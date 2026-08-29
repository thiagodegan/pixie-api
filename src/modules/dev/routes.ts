// ---------------------------------------------------------------------------
// Rotas de desenvolvimento — NUNCA registradas com NODE_ENV=production.
//
// Servem para exercitar o pipeline de conciliação sem um banco de verdade do
// outro lado. O que elas fazem é só injetar linhas no extrato simulado; a
// confirmação continua saindo do matcher.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../../lib/errors.js";
import { createStatementProvider } from "../../statement/index.js";
import { reconcileAccount } from "../../worker/poller.js";

const simulateSchema = z.object({
  /** Atraso até a linha aparecer no extrato — imita a latência do banco. */
  delayMs: z.number().int().min(0).max(120_000).default(0),
  payerName: z.string().default("Camila R."),
  /**
   * Omite o txid da descrição, forçando o caminho heurístico (valor + janela).
   * É como se reproduz o risco central do produto: o txid não voltar legível
   * no extrato.
   */
  omitTxid: z.boolean().default(false),
  /** Paga valor diferente do cobrado, para testar o não-casamento. */
  amountCents: z.number().int().positive().optional(),
});

export async function devRoutes(app: FastifyInstance) {
  app.post("/dev/simulate-payment/:txid", async (req) => {
    const { txid } = z.object({ txid: z.string() }).parse(req.params);
    const opts = simulateSchema.parse(req.body ?? {});

    const charge = await app.prisma.charge.findUnique({
      where: { txid },
      select: { id: true, accountId: true, amountCents: true, txid: true },
    });
    if (!charge) throw notFound(`Nenhuma cobrança com txid ${txid}.`);

    const description = opts.omitTxid
      ? "PIX RECEBIDO"
      : `PIX RECEBIDO ${charge.txid}`;

    const payment = await app.prisma.simulatedPayment.create({
      data: {
        accountId: charge.accountId,
        txid: charge.txid,
        amountCents: opts.amountCents ?? charge.amountCents,
        payerName: opts.payerName,
        description,
        availableAt: new Date(Date.now() + opts.delayMs),
      },
    });

    return {
      injected: true,
      availableAt: payment.availableAt,
      description,
      hint: "O worker vai ingerir e conciliar no próximo ciclo.",
    };
  });

  /** Roda um ciclo de conciliação na hora, sem esperar o worker. */
  app.post("/dev/reconcile", async (req) => {
    const provider = createStatementProvider(app.prisma);
    const accounts = await app.prisma.account.findMany();

    const results = [];
    for (const account of accounts) {
      results.push({
        account: account.email,
        ...(await reconcileAccount(app.prisma, provider, account, req.log)),
      });
    }
    return { provider: provider.name, results };
  });
}
