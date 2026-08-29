import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertValidTxid,
  buildPixPayload,
  crc16,
  formatAmount,
  sanitizeText,
  verifyPayloadCrc,
} from "../src/lib/emv.ts";

/** Parser TLV mínimo, só para conferir o que o gerador produziu. */
function parseTlv(payload: string): Map<string, string> {
  const fields = new Map<string, string>();
  let i = 0;
  while (i < payload.length - 4) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    fields.set(id, payload.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return fields;
}

describe("crc16", () => {
  it("bate com o valor de referência do CCITT-FALSE", () => {
    // Vetor de teste canônico: "123456789" -> 0x29B1 em CRC16/CCITT-FALSE.
    assert.equal(crc16("123456789"), "29B1");
  });

  it("sempre devolve 4 caracteres hex maiúsculos", () => {
    for (const input of ["", "A", "pix", "00020101"]) {
      assert.match(crc16(input), /^[0-9A-F]{4}$/);
    }
  });
});

describe("buildPixPayload", () => {
  const base = {
    pixKey: "12345678000190",
    merchantName: "Mercearia do Bairro",
    merchantCity: "SAO PAULO",
    amountCents: 12890,
    txid: "CXBK7M2QP4XR9T",
  };

  it("gera um payload com CRC válido", () => {
    assert.equal(verifyPayloadCrc(buildPixPayload(base)), true);
  });

  it("coloca o txid no campo 62-05 — o elo com o extrato", () => {
    const fields = parseTlv(buildPixPayload(base));
    const additional = fields.get("62");
    assert.ok(additional, "campo 62 ausente");
    assert.equal(parseTlv(`${additional}0000`).get("05"), base.txid);
  });

  it("declara moeda BRL, país BR e o valor cobrado", () => {
    const fields = parseTlv(buildPixPayload(base));
    assert.equal(fields.get("53"), "986");
    assert.equal(fields.get("58"), "BR");
    assert.equal(fields.get("54"), "128.90");
  });

  it("põe a chave Pix sob o GUI do Pix", () => {
    const merchantAccount = parseTlv(buildPixPayload(base)).get("26");
    assert.ok(merchantAccount);
    const inner = parseTlv(`${merchantAccount}0000`);
    assert.equal(inner.get("00"), "br.gov.bcb.pix");
    assert.equal(inner.get("01"), base.pixKey);
  });

  it("detecta payload adulterado", () => {
    const payload = buildPixPayload(base);
    // Troca um dígito do valor sem recalcular o CRC.
    const tampered = payload.replace("128.90", "138.90");
    assert.notEqual(tampered, payload);
    assert.equal(verifyPayloadCrc(tampered), false);
  });

  it("trunca e normaliza nome do recebedor acima de 25 caracteres", () => {
    const fields = parseTlv(
      buildPixPayload({
        ...base,
        merchantName: "Padaria e Confeitaria São João Ltda ME",
      }),
    );
    const name = fields.get("59");
    assert.ok(name);
    assert.ok(name.length <= 25);
    // NFD + filtro ASCII: "São" vira "Sao", sem quebrar o comprimento do TLV.
    assert.match(name, /^[\x20-\x7E]+$/);
  });

  it("recusa txid com hífen — o Pix não aceita", () => {
    // Exatamente o formato que o protótipo do front gerava ("CXB-1234").
    assert.throws(() => assertValidTxid("CXB-1234"), /txid inválido/);
    assert.throws(() => buildPixPayload({ ...base, txid: "CXB-1234" }));
  });

  it("recusa txid acima de 25 caracteres", () => {
    assert.throws(() => assertValidTxid("A".repeat(26)), /txid inválido/);
  });
});

describe("formatAmount", () => {
  it("converte centavos para o formato do campo 54", () => {
    assert.equal(formatAmount(1), "0.01");
    assert.equal(formatAmount(100), "1.00");
    assert.equal(formatAmount(12890), "128.90");
    assert.equal(formatAmount(100000000), "1000000.00");
  });

  it("recusa valor não inteiro ou não positivo", () => {
    assert.throws(() => formatAmount(0));
    assert.throws(() => formatAmount(-500));
    assert.throws(() => formatAmount(10.5));
  });
});

describe("sanitizeText", () => {
  it("remove acentos preservando a letra base", () => {
    assert.equal(sanitizeText("Ação Balcão", 50), "Acao Balcao");
  });

  it("remove caracteres fora do ASCII imprimível", () => {
    assert.equal(sanitizeText("Caixa\n\tBalcão", 50), "CaixaBalcao");
  });
});
