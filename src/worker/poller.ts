// ---------------------------------------------------------------------------
// Worker de conciliação.
//
// Ciclo, por conta: lê o extrato desde o cursor → ingere de forma idempotente
// → casa com as cobranças abertas → expira o que passou do prazo.
//
// Roda no mesmo processo da API por ora. Quando o volume exigir, vira serviço
// próprio no compose sem mudar nada abaixo desta linha — é só quem chama
// reconcileAccount que muda.
// ---------------------------------------------------------------------------

import type { Account, PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import type { StatementProvider } from "../statement/types.js";
import { matchTransaction, type ChargeCandidate } from "./matcher.js";

/** Quanto tempo depois de expirar uma cobrança ainda aceita pagamento. */
const EXPIRY_GRACE_MS = 10 * 60_000;
/** Janela máxima de cobranças consideradas na conciliação. */
const CANDIDATE_WINDOW_MS = 24 * 60 * 60_000;

export interface ReconcileResult {
  fetched: number;
  ingested: number;
  matched: number;
  ambiguous: number;
}

export async function reconcileAccount(
  prisma: PrismaClient,
  provider: StatementProvider,
  account: Account,
  log: FastifyBaseLogger,
): Promise<ReconcileResult> {
  const run = await prisma.pollingRun.create({ data: { accountId: account.id } });
  const result: ReconcileResult = { fetched: 0, ingested: 0, matched: 0, ambiguous: 0 };

  try {
    // --- 1. Ler o extrato -------------------------------------------------
    // A sobreposição existe porque o extrato pode publicar fora de ordem; sem
    // ela, uma linha que chega atrasada cairia atrás do cursor e sumiria.
    const cursor = account.statementCursor ?? new Date(Date.now() - CANDIDATE_WINDOW_MS);
    const since = new Date(cursor.getTime() - config.POLL_OVERLAP_SECONDS * 1000);

    const entries = await provider.fetchEntries(account, since);
    result.fetched = entries.length;

    // --- 2. Ingerir (idempotente por externalId) --------------------------
    for (const entry of entries) {
      const existing = await prisma.bankTransaction.findUnique({
        where: {
          accountId_externalId: {
            accountId: account.id,
            externalId: entry.externalId,
          },
        },
        select: { id: true },
      });
      if (existing) continue;

      await prisma.bankTransaction.create({
        data: {
          accountId: account.id,
          externalId: entry.externalId,
          amountCents: entry.amountCents,
          payerName: entry.payerName,
          payerDocument: entry.payerDocument,
          rawDescription: entry.rawDescription,
          occurredAt: entry.occurredAt,
        },
      });
      result.ingested++;
    }

    // --- 3. Conciliar -----------------------------------------------------
    Object.assign(result, await matchPending(prisma, account.id, result));

    // --- 4. Expirar o que passou do prazo + graça -------------------------
    await prisma.charge.updateMany({
      where: {
        accountId: account.id,
        status: { in: ["AGUARDANDO", "REVISAO"] },
        expiresAt: { lt: new Date(Date.now() - EXPIRY_GRACE_MS) },
      },
      data: { status: "EXPIRADO" },
    });

    // --- 5. Avançar o cursor ----------------------------------------------
    const latest = entries.reduce<Date | null>(
      (acc, e) => (acc === null || e.occurredAt > acc ? e.occurredAt : acc),
      null,
    );
    if (latest) {
      await prisma.account.update({
        where: { id: account.id },
        data: { statementCursor: latest },
      });
    }

    await prisma.pollingRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        fetched: result.fetched,
        ingested: result.ingested,
        matched: result.matched,
      },
    });

    return result;
  } catch (err) {
    const message = (err as Error).message;
    await prisma.pollingRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), error: message },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Casamento das transações ainda não conciliadas
// ---------------------------------------------------------------------------

async function matchPending(
  prisma: PrismaClient,
  accountId: string,
  result: ReconcileResult,
): Promise<Pick<ReconcileResult, "matched" | "ambiguous">> {
  const windowStart = new Date(Date.now() - CANDIDATE_WINDOW_MS);

  const pending = await prisma.bankTransaction.findMany({
    where: { accountId, charge: null, occurredAt: { gte: windowStart } },
    orderBy: { occurredAt: "asc" },
  });
  if (pending.length === 0) {
    return { matched: result.matched, ambiguous: result.ambiguous };
  }

  const openCharges = await prisma.charge.findMany({
    where: {
      accountId,
      status: { in: ["AGUARDANDO", "REVISAO"] },
      matchedTransactionId: null,
      createdAt: { gte: windowStart },
    },
    select: {
      id: true,
      txid: true,
      amountCents: true,
      createdAt: true,
      expiresAt: true,
    },
  });

  // Mutável de propósito: assim que uma cobrança é paga ela sai do pool e não
  // pode ser reivindicada por uma segunda transação.
  let candidates: ChargeCandidate[] = openCharges;
  let matched = result.matched;
  let ambiguous = result.ambiguous;

  for (const tx of pending) {
    if (candidates.length === 0) break;

    const decision = matchTransaction(
      {
        externalId: tx.externalId,
        amountCents: tx.amountCents,
        payerName: tx.payerName,
        payerDocument: tx.payerDocument,
        rawDescription: tx.rawDescription,
        occurredAt: tx.occurredAt,
      },
      candidates,
    );

    if (decision.kind === "none") continue;

    if (decision.kind === "ambiguous") {
      ambiguous += decision.chargeIds.length;
      await prisma.charge.updateMany({
        where: { id: { in: decision.chargeIds }, status: "AGUARDANDO" },
        data: { status: "REVISAO" },
      });
      continue;
    }

    const charge = candidates.find((c) => c.id === decision.chargeId);
    if (!charge) continue;

    // A unique em matchedTransactionId é a garantia final contra dois workers
    // concorrentes creditarem o mesmo pagamento duas vezes.
    await prisma.charge.update({
      where: { id: charge.id },
      data: {
        status: "PAGO",
        paidAt: tx.occurredAt,
        payerName: tx.payerName,
        matchedTransactionId: tx.id,
        // Marca a procedência: esta veio do extrato, não de uma baixa manual.
        confirmationSource: "EXTRATO",
      },
    });
    await prisma.bankTransaction.update({
      where: { id: tx.id },
      data: { extractedTxid: decision.kind === "txid" ? charge.txid : null },
    });

    candidates = candidates.filter((c) => c.id !== charge.id);
    matched++;
  }

  return { matched, ambiguous };
}

// ---------------------------------------------------------------------------
// Laço
// ---------------------------------------------------------------------------

export interface PollerHandle {
  stop: () => void;
}

export function startPoller(
  prisma: PrismaClient,
  provider: StatementProvider,
  log: FastifyBaseLogger,
): PollerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let backoff = 1;

  const tick = async () => {
    if (stopped) return;
    try {
      // Só contas com cobrança aberta: sem isso, cada conta ociosa gastaria
      // chamada do orçamento de rate limit da API de extrato à toa.
      const accounts = await prisma.account.findMany({
        where: { charges: { some: { status: { in: ["AGUARDANDO", "REVISAO"] } } } },
      });

      for (const account of accounts) {
        const r = await reconcileAccount(prisma, provider, account, log);
        if (r.matched > 0 || r.ambiguous > 0) {
          log.info(
            { accountId: account.id, ...r },
            "conciliação: pagamentos processados",
          );
        }
      }
      backoff = 1;
    } catch (err) {
      // Backoff exponencial até 30x — protege contra 429 da API de extrato.
      backoff = Math.min(backoff * 2, 30);
      log.warn(
        { err, backoff },
        "falha no ciclo de conciliação; reduzindo frequência",
      );
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, config.POLL_INTERVAL_MS * backoff);
      }
    }
  };

  log.info(
    { provider: provider.name, intervalMs: config.POLL_INTERVAL_MS },
    "worker de conciliação iniciado",
  );
  timer = setTimeout(tick, config.POLL_INTERVAL_MS);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
