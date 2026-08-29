// ---------------------------------------------------------------------------
// Conciliação: casar uma linha do extrato com a cobrança que a originou.
//
// Este é o ponto onde o produto vive ou morre. Duas regras de projeto:
//
//   1. txid é a única evidência forte. Achou o txid íntegro na descrição, é
//      match determinístico e pronto.
//   2. Sem txid, NUNCA confirmar no escuro. Valor + janela de tempo é heurística;
//      se mais de uma cobrança casa, o resultado é REVISAO — pagamento fica
//      pendente de conferência humana em vez de creditar a cobrança errada.
//
// Confirmar a cobrança errada é pior do que não confirmar: o vendedor entrega
// mercadoria contra um pagamento que não existe.
// ---------------------------------------------------------------------------

import type { StatementEntry } from "../statement/types.js";

export interface ChargeCandidate {
  id: string;
  txid: string;
  amountCents: number;
  createdAt: Date;
  expiresAt: Date;
}

export type MatchDecision =
  /** txid encontrado na descrição — evidência forte. */
  | { kind: "txid"; chargeId: string }
  /** Candidata única por valor + janela de tempo — evidência fraca, aceita. */
  | { kind: "heuristic"; chargeId: string }
  /** Várias candidatas plausíveis — ninguém é confirmado. */
  | { kind: "ambiguous"; chargeIds: string[] }
  /** Nenhuma cobrança corresponde: é um Pix que não nasceu no Pixie. */
  | { kind: "none" };

/**
 * Normaliza para busca de txid: maiúsculas e só alfanumérico.
 *
 * Bancos reformatam o campo de descrição — inserem espaço, hífen, quebram
 * linha, mudam caixa. Achatar os dois lados antes de comparar absorve isso
 * sem afrouxar a comparação (o txid continua tendo que aparecer inteiro).
 */
export function normalizeForSearch(value: string): string {
  return value.normalize("NFD").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Tolerância na borda: o pagamento pode aparecer pouco antes/depois. */
const CLOCK_SKEW_MS = 60_000;
const POST_EXPIRY_GRACE_MS = 10 * 60_000;

function withinWindow(entry: StatementEntry, charge: ChargeCandidate): boolean {
  const at = entry.occurredAt.getTime();
  return (
    at >= charge.createdAt.getTime() - CLOCK_SKEW_MS &&
    at <= charge.expiresAt.getTime() + POST_EXPIRY_GRACE_MS
  );
}

/**
 * Decide a qual cobrança uma linha de extrato pertence.
 * Função pura: recebe candidatas, não toca o banco.
 */
export function matchTransaction(
  entry: StatementEntry,
  candidates: ChargeCandidate[],
): MatchDecision {
  // --- 1. txid: evidência forte -------------------------------------------
  const haystack = normalizeForSearch(entry.rawDescription);
  if (haystack.length > 0) {
    const byTxid = candidates.filter((c) =>
      haystack.includes(normalizeForSearch(c.txid)),
    );
    // Txid é unique global; mais de um só aconteceria se um txid fosse
    // substring de outro. Desempata pelo mais longo — o match mais específico.
    if (byTxid.length > 0) {
      const best = byTxid.reduce((a, b) => (b.txid.length > a.txid.length ? b : a));
      return { kind: "txid", chargeId: best.id };
    }
  }

  // --- 2. valor + janela de tempo: evidência fraca -------------------------
  const plausible = candidates.filter(
    (c) => c.amountCents === entry.amountCents && withinWindow(entry, c),
  );

  if (plausible.length === 1) {
    return { kind: "heuristic", chargeId: plausible[0]!.id };
  }
  if (plausible.length > 1) {
    return { kind: "ambiguous", chargeIds: plausible.map((c) => c.id) };
  }

  return { kind: "none" };
}
