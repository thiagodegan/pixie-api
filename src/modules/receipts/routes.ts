// ---------------------------------------------------------------------------
// Recebimentos, na visão do dono da conta.
//
// O painel enxerga TODAS as cobranças de TODOS os PDVs, inclusive as que ainda
// não foram confirmadas. Antes disto, uma cobrança só existia para o caixa que
// a gerou, e o dono não tinha como saber que ela existia — muito menos agir.
//
// Também é aqui que mora a baixa manual: a saída quando a conciliação pelo
// extrato não acontece (banco fora do ar, txid ilegível, atraso do Pix).
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conflict, notFound } from "../../lib/errors.js";

const CHARGE_STATUSES = [
  "AGUARDANDO",
  "PAGO",
  "EXPIRADO",
  "CANCELADO",
  "REVISAO",
] as const;

const listSchema = z.object({
  pdvId: z.string().uuid().optional(),
  status: z.enum(CHARGE_STATUSES).optional(),
  /** Busca por txid — para achar UMA cobrança quando há muitas. */
  txid: z.string().trim().max(30).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const confirmSchema = z.object({
  /**
   * Obrigatória: dar baixa sem prova bancária precisa deixar rastro de quem
   * decidiu e por quê. É o que separa uma exceção justificada de um descontrole.
   */
  note: z
    .string()
    .trim()
    .min(5, "Explique por que está confirmando manualmente.")
    .max(280),
  /** Quem pagou, quando o dono souber. O extrato não vai informar. */
  payerName: z.string().trim().max(60).optional(),
});

/** Campos devolvidos ao painel. `pixPayload` fica de fora: é grande e inútil aqui. */
const listSelect = {
  id: true,
  txid: true,
  amountCents: true,
  status: true,
  payerName: true,
  confirmationSource: true,
  manualNote: true,
  manualConfirmedBy: true,
  createdAt: true,
  expiresAt: true,
  paidAt: true,
  pdv: { select: { id: true, name: true, prefix: true } },
} as const;

export async function receiptRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.requireOwner);

  // --- Listagem -------------------------------------------------------------

  app.get("/receipts", async (req) => {
    const q = listSchema.parse(req.query);
    const accountId = req.owner.accountId;

    const where = {
      accountId,
      ...(q.pdvId ? { pdvId: q.pdvId } : {}),
      ...(q.status ? { status: q.status } : {}),
      // Buscar txid por prefixo casa com o que o dono tem em mãos: o começo do
      // código, lido da tela do PDV ou do comprovante.
      ...(q.txid
        ? { txid: { contains: q.txid.toUpperCase(), mode: "insensitive" as const } }
        : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: q.from } : {}),
              ...(q.to ? { lte: q.to } : {}),
            },
          }
        : {}),
    };

    const [items, total, byStatus] = await Promise.all([
      app.prisma.charge.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.limit,
        skip: q.offset,
        select: listSelect,
      }),
      app.prisma.charge.count({ where }),
      // Contagem por status ignorando o filtro de status: é o que alimenta as
      // abas ("Aguardando 3", "Em revisão 1") sem uma segunda ida ao servidor.
      app.prisma.charge.groupBy({
        by: ["status"],
        where: { ...where, status: undefined },
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
    ]);

    return {
      items,
      total,
      limit: q.limit,
      offset: q.offset,
      counts: Object.fromEntries(
        CHARGE_STATUSES.map((s) => [
          s,
          byStatus.find((r) => r.status === s)?._count._all ?? 0,
        ]),
      ),
      /** Só o que foi de fato recebido entra no total. */
      paidCents:
        byStatus.find((r) => r.status === "PAGO")?._sum.amountCents ?? 0,
    };
  });

  // --- Baixa manual ---------------------------------------------------------

  app.post("/receipts/:id/confirm", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { note, payerName } = confirmSchema.parse(req.body);

    const charge = await app.prisma.charge.findFirst({
      where: { id, accountId: req.owner.accountId },
      select: { id: true, status: true, txid: true },
    });
    if (!charge) throw notFound("Cobrança não encontrada.");
    if (charge.status === "PAGO") {
      throw conflict("Esta cobrança já está confirmada.", "ALREADY_PAID");
    }
    if (charge.status === "CANCELADO") {
      throw conflict("Cobrança cancelada não pode ser confirmada.", "CANCELLED");
    }

    const updated = await app.prisma.charge.update({
      where: { id },
      data: {
        status: "PAGO",
        paidAt: new Date(),
        confirmationSource: "MANUAL",
        manualNote: note,
        manualConfirmedBy: req.owner.email,
        ...(payerName ? { payerName } : {}),
        // matchedTransactionId continua null de propósito: nenhuma linha de
        // extrato sustenta esta baixa, e fingir que sim corromperia a auditoria.
      },
      select: listSelect,
    });

    // Fica no mesmo terminal de diagnóstico da tela de Segurança, junto das
    // conexões com o banco — é lá que se reconstrói o que aconteceu na conta.
    await app.prisma.connectionLog.create({
      data: {
        accountId: req.owner.accountId,
        ok: false, // amarelo no terminal: aconteceu, mas não pelo caminho normal
        message: `Baixa MANUAL da cobrança ${charge.txid} por ${req.owner.email} — ${note}`,
      },
    });

    req.log.warn(
      { chargeId: id, txid: charge.txid, by: req.owner.email },
      "cobrança confirmada manualmente, sem evidência no extrato",
    );

    return updated;
  });

  // --- Desfazer a baixa manual ---------------------------------------------

  app.post("/receipts/:id/undo-confirm", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const charge = await app.prisma.charge.findFirst({
      where: { id, accountId: req.owner.accountId },
      select: { id: true, status: true, txid: true, confirmationSource: true },
    });
    if (!charge) throw notFound("Cobrança não encontrada.");

    // Só desfaz o que foi decidido por uma pessoa. Uma confirmação vinda do
    // extrato é um fato bancário — se pudesse ser apagada pelo painel, o
    // registro deixaria de valer como registro.
    if (charge.confirmationSource !== "MANUAL") {
      throw conflict(
        "Só uma confirmação manual pode ser desfeita. Esta veio do extrato do banco.",
        "NOT_MANUAL",
      );
    }

    const updated = await app.prisma.charge.update({
      where: { id },
      data: {
        status: "AGUARDANDO",
        paidAt: null,
        confirmationSource: null,
        manualNote: null,
        manualConfirmedBy: null,
      },
      select: listSelect,
    });

    await app.prisma.connectionLog.create({
      data: {
        accountId: req.owner.accountId,
        ok: false,
        message: `Baixa manual da cobrança ${charge.txid} DESFEITA por ${req.owner.email}`,
      },
    });

    return updated;
  });

  // --- Cancelamento ---------------------------------------------------------

  app.post("/receipts/:id/cancel", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const charge = await app.prisma.charge.findFirst({
      where: { id, accountId: req.owner.accountId },
      select: { id: true, status: true },
    });
    if (!charge) throw notFound("Cobrança não encontrada.");
    if (charge.status === "PAGO") {
      throw conflict("Cobrança já paga não pode ser cancelada.", "ALREADY_PAID");
    }

    return app.prisma.charge.update({
      where: { id },
      data: { status: "CANCELADO" },
      select: listSelect,
    });
  });
}
