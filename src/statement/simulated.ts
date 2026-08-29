// ---------------------------------------------------------------------------
// Extrato simulado — o que permite fechar o fluxo ponta a ponta offline,
// sem certificado do Banco Inter.
//
// Importante: isto NÃO é um atalho que pula a conciliação. O pagamento
// injetado entra pelo mesmo caminho de uma linha real de extrato e passa por
// ingestão idempotente + matching de txid como qualquer outra. O que é falso
// aqui é só a origem dos dados.
// ---------------------------------------------------------------------------

import type { Account, PrismaClient } from "@prisma/client";
import type { StatementEntry, StatementProvider } from "./types.js";

export class SimulatedStatementProvider implements StatementProvider {
  readonly name = "simulado";

  constructor(private readonly prisma: PrismaClient) {}

  async fetchEntries(account: Account, since: Date): Promise<StatementEntry[]> {
    const payments = await this.prisma.simulatedPayment.findMany({
      where: {
        accountId: account.id,
        availableAt: { gte: since, lte: new Date() },
      },
      orderBy: { availableAt: "asc" },
      take: 200,
    });

    return payments.map((p) => ({
      // Estável por linha: reler a mesma janela devolve o mesmo externalId,
      // e a unique (accountId, externalId) descarta a repetição.
      externalId: `sim-${p.id}`,
      amountCents: p.amountCents,
      payerName: p.payerName,
      payerDocument: null,
      rawDescription: p.description,
      occurredAt: p.availableAt,
    }));
  }

  async testConnection(): Promise<{ ok: boolean; steps: string[] }> {
    return {
      ok: true,
      steps: [
        "Provedor de extrato: SIMULADO (nenhuma chamada ao Banco Inter)",
        "Pagamentos entram por POST /dev/simulate-payment/:txid",
        "Conciliação por txid roda igual à de produção",
      ],
    };
  }
}
