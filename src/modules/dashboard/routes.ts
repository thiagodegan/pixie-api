// ---------------------------------------------------------------------------
// Dashboard do dono — os KPIs da visão geral.
//
// O protótipo somava o array de PDVs no cliente. Agora vem agregado do banco,
// numa resposta só: a tela precisa dos totais E da tabela por PDV.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";
import { pdvTotals, zeroTotals } from "../pdvs/aggregates.js";

/**
 * A economia é a razão de existir do produto: o que seria pago em taxa se a
 * conta usasse a API de Cobrança (Pix Comercial, ~1%) em vez do extrato.
 */
const PIX_COMERCIAL_FEE_BPS = 100; // 1% em basis points

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.requireOwner);

  app.get("/dashboard/summary", async (req) => {
    const accountId = req.owner.accountId;

    const [pdvs, totals, account] = await Promise.all([
      app.prisma.pdv.findMany({
        where: { accountId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, prefix: true, status: true },
      }),
      pdvTotals(app.prisma, accountId),
      // Uma conta recém-criada não tem chave Pix nem certificados, e sem chave
      // toda cobrança falha. O painel precisa saber disso para orientar em vez
      // de deixar o dono descobrir no balcão.
      app.prisma.account.findUniqueOrThrow({
        where: { id: accountId },
        select: {
          pixKey: true,
          _count: { select: { certificates: true } },
        },
      }),
    ]);

    const rows = pdvs.map((pdv) => ({
      ...pdv,
      ...(totals.get(pdv.id) ?? zeroTotals()),
    }));

    const totalTodayCents = sum(rows, (r) => r.todayCents);
    const totalMonthCents = sum(rows, (r) => r.monthCents);

    return {
      totalTodayCents,
      totalMonthCents,
      // Inteiro o tempo todo: dividir centavos por 10.000 com floor evita
      // fabricar frações de centavo que não existem.
      savingsCents: Math.floor((totalMonthCents * PIX_COMERCIAL_FEE_BPS) / 10_000),
      txCount: sum(rows, (r) => r.txCount),
      activePdvs: rows.filter((r) => r.status === "ATIVO").length,
      totalPdvs: rows.length,
      pdvs: rows,
      setup: {
        pixKeyConfigured: Boolean(account.pixKey),
        // O par .crt + .key: um só não fecha o handshake mTLS.
        certificatesConfigured: account._count.certificates >= 2,
        hasPdv: rows.length > 0,
      },
    };
  });
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0);
}
