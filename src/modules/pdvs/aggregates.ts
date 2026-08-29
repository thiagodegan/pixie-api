// ---------------------------------------------------------------------------
// Agregados por PDV.
//
// No protótipo, `today`, `month` e `tx` eram colunas fixas do mock. Aqui são
// derivados das cobranças PAGAS — não existe contador para desincronizar do
// que de fato foi recebido.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";
import { startOfMonth, startOfToday } from "../../lib/dates.js";

export interface PdvTotals {
  todayCents: number;
  monthCents: number;
  txCount: number;
}

const ZERO: PdvTotals = { todayCents: 0, monthCents: 0, txCount: 0 };

/** Totais de todos os PDVs da conta, em uma passada. */
export async function pdvTotals(
  prisma: PrismaClient,
  accountId: string,
): Promise<Map<string, PdvTotals>> {
  const [month, today] = await Promise.all([
    prisma.charge.groupBy({
      by: ["pdvId"],
      where: { accountId, status: "PAGO", paidAt: { gte: startOfMonth() } },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    prisma.charge.groupBy({
      by: ["pdvId"],
      where: { accountId, status: "PAGO", paidAt: { gte: startOfToday() } },
      _sum: { amountCents: true },
    }),
  ]);

  const todayByPdv = new Map(today.map((r) => [r.pdvId, r._sum.amountCents ?? 0]));
  const totals = new Map<string, PdvTotals>();

  for (const row of month) {
    totals.set(row.pdvId, {
      monthCents: row._sum.amountCents ?? 0,
      txCount: row._count._all,
      todayCents: todayByPdv.get(row.pdvId) ?? 0,
    });
  }

  return totals;
}

export const zeroTotals = (): PdvTotals => ({ ...ZERO });
