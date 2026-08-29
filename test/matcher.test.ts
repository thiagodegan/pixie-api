import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchTransaction,
  normalizeForSearch,
  type ChargeCandidate,
} from "../src/worker/matcher.ts";
import type { StatementEntry } from "../src/statement/types.ts";

const T0 = new Date("2026-08-29T14:00:00.000Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

function charge(over: Partial<ChargeCandidate> = {}): ChargeCandidate {
  return {
    id: "c1",
    txid: "CXBK7M2QP4XR",
    amountCents: 12890,
    createdAt: T0,
    expiresAt: at(15 * 60_000),
    ...over,
  };
}

function entry(over: Partial<StatementEntry> = {}): StatementEntry {
  return {
    externalId: "tx-1",
    amountCents: 12890,
    payerName: "Camila R.",
    payerDocument: null,
    rawDescription: "PIX RECEBIDO CXBK7M2QP4XR",
    occurredAt: at(30_000),
    ...over,
  };
}

describe("normalizeForSearch", () => {
  it("achata caixa e pontuação para comparar txid", () => {
    assert.equal(normalizeForSearch("pix cxb-k7m2 q.p4xr"), "PIXCXBK7M2QP4XR");
  });
});

describe("matchTransaction — txid (evidência forte)", () => {
  it("casa quando o txid aparece na descrição", () => {
    const result = matchTransaction(entry(), [charge()]);
    assert.deepEqual(result, { kind: "txid", chargeId: "c1" });
  });

  it("casa mesmo se o banco reformatar o txid", () => {
    // Bancos inserem espaço, hífen e mudam a caixa do campo de descrição.
    for (const rawDescription of [
      "pix recebido cxb-k7m2-qp4xr",
      "PIX  CXBK7M2QP4XR  RECEBIDO",
      "Pix/Recebido/CXBK7M2QP4XR",
      "CXBK7M2QP4XR",
    ]) {
      assert.deepEqual(
        matchTransaction(entry({ rawDescription }), [charge()]),
        { kind: "txid", chargeId: "c1" },
        `falhou para: ${rawDescription}`,
      );
    }
  });

  it("txid ganha de uma candidata que só bate por valor", () => {
    const byTxid = charge({ id: "certa", txid: "CXBK7M2QP4XR", amountCents: 999 });
    const byAmount = charge({ id: "errada", txid: "LSSZZZZZZZZZ" });
    const result = matchTransaction(entry(), [byAmount, byTxid]);
    assert.deepEqual(result, { kind: "txid", chargeId: "certa" });
  });

  it("não casa txid parcial", () => {
    const result = matchTransaction(
      entry({ rawDescription: "PIX RECEBIDO CXBK7M2", amountCents: 1 }),
      [charge()],
    );
    assert.deepEqual(result, { kind: "none" });
  });
});

describe("matchTransaction — heurística (evidência fraca)", () => {
  const noTxid = { rawDescription: "PIX RECEBIDO" };

  it("aceita candidata única por valor dentro da janela", () => {
    const result = matchTransaction(entry(noTxid), [charge()]);
    assert.deepEqual(result, { kind: "heuristic", chargeId: "c1" });
  });

  it("com duas cobranças de mesmo valor, não confirma nenhuma", () => {
    // O cenário ambíguo listado como risco: dois clientes pagando R$ 128,90
    // no mesmo caixa, na mesma janela. Confirmar a errada faria o vendedor
    // entregar mercadoria contra um pagamento que não chegou.
    const result = matchTransaction(entry(noTxid), [
      charge({ id: "a" }),
      charge({ id: "b" }),
    ]);
    assert.equal(result.kind, "ambiguous");
    assert.deepEqual(
      result.kind === "ambiguous" ? [...result.chargeIds].sort() : [],
      ["a", "b"],
    );
  });

  it("valor diferente não casa", () => {
    const result = matchTransaction(
      entry({ ...noTxid, amountCents: 12891 }),
      [charge()],
    );
    assert.deepEqual(result, { kind: "none" });
  });

  it("fora da janela de tempo não casa", () => {
    const result = matchTransaction(
      entry({ ...noTxid, occurredAt: at(60 * 60_000) }),
      [charge()],
    );
    assert.deepEqual(result, { kind: "none" });
  });

  it("aceita pequeno desvio de relógio antes da criação", () => {
    const result = matchTransaction(
      entry({ ...noTxid, occurredAt: at(-30_000) }),
      [charge()],
    );
    assert.deepEqual(result, { kind: "heuristic", chargeId: "c1" });
  });

  it("aceita pagamento logo após expirar (janela de graça)", () => {
    const result = matchTransaction(
      entry({ ...noTxid, occurredAt: at(20 * 60_000) }),
      [charge()],
    );
    assert.deepEqual(result, { kind: "heuristic", chargeId: "c1" });
  });
});

describe("matchTransaction — sem candidatas", () => {
  it("um Pix que não nasceu no Pixie fica sem match", () => {
    assert.deepEqual(matchTransaction(entry(), []), { kind: "none" });
  });
});
