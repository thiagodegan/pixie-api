// ---------------------------------------------------------------------------
// A fronteira com o banco.
//
// Tudo que o Pixie precisa saber sobre "de onde vem o extrato" cabe nesta
// interface. É o ponto onde o adapter simulado (offline) e o do Banco Inter
// (mTLS, produção) são intercambiáveis — o worker e o matcher não sabem qual
// dos dois está rodando.
// ---------------------------------------------------------------------------

import type { Account } from "@prisma/client";

/** Uma linha de extrato, normalizada. Valor sempre em centavos. */
export interface StatementEntry {
  /**
   * Identificador estável da transação no banco. É a chave de idempotência:
   * o worker relê janelas sobrepostas e não pode duplicar recebimento.
   */
  externalId: string;
  amountCents: number;
  payerName: string | null;
  payerDocument: string | null;
  /** Descrição crua, como veio do banco — é aqui que o txid precisa aparecer. */
  rawDescription: string;
  occurredAt: Date;
}

export interface StatementProvider {
  readonly name: string;

  /**
   * Busca créditos Pix a partir de `since`.
   * Deve devolver apenas entradas (créditos); débitos não interessam.
   */
  fetchEntries(account: Account, since: Date): Promise<StatementEntry[]>;

  /**
   * Diagnóstico para a tela de "Segurança e conexão": valida credenciais e
   * conectividade sem ingerir nada. Cada passo vira uma linha no terminal.
   */
  testConnection(account: Account): Promise<{ ok: boolean; steps: string[] }>;
}
