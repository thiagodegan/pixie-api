// ---------------------------------------------------------------------------
// BR Code (EMV®QRCPS-MPM) — o "Pix Copia e Cola".
//
// Referência: Manual de Padrões para Iniciação do Pix (BCB) + EMVCo MPM.
// A estrutura é TLV: cada campo é ID(2) + tamanho(2, decimal) + valor.
//
// O campo que sustenta o produto inteiro é o 62-05 (Reference Label), onde vai
// o txid — é ele que precisa voltar legível no extrato para a conciliação
// funcionar.
// ---------------------------------------------------------------------------

/** Formata um campo TLV. O tamanho é sempre 2 dígitos, zero-padded. */
function tlv(id: string, value: string): string {
  const len = value.length;
  if (len > 99) {
    throw new Error(`Campo EMV ${id} excede 99 caracteres (${len})`);
  }
  return `${id}${String(len).padStart(2, "0")}${value}`;
}

/**
 * CRC16/CCITT-FALSE — polinômio 0x1021, init 0xFFFF, sem reflexão, sem xorout.
 * Calculado sobre o payload inteiro JÁ INCLUINDO o prefixo "6304" do campo 63.
 */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * O BR Code aceita apenas um subconjunto ASCII. Remove acentos e qualquer
 * caractere fora da faixa imprimível, e trunca no limite do campo.
 */
export function sanitizeText(value: string, maxLength: number): string {
  return value
    .normalize("NFD")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, maxLength);
}

/**
 * O txid do Pix é restrito a `[A-Za-z0-9]{1,25}` — sem hífen, sem separador.
 * (O protótipo do front gerava "CXB-1234", que é inválido no payload real.)
 */
export const TXID_PATTERN = /^[A-Za-z0-9]{1,25}$/;

export function assertValidTxid(txid: string): void {
  if (!TXID_PATTERN.test(txid)) {
    throw new Error(
      `txid inválido: "${txid}" — esperado [A-Za-z0-9]{1,25}, sem hífen`,
    );
  }
}

/** Valor em centavos → "123.45", formato exigido pelo campo 54. */
export function formatAmount(amountCents: number): string {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`Valor inválido: ${amountCents} (esperado inteiro > 0)`);
  }
  return (amountCents / 100).toFixed(2);
}

export interface PixPayloadInput {
  pixKey: string;
  merchantName: string;
  merchantCity: string;
  amountCents: number;
  txid: string;
}

/**
 * Monta o BR Code estático completo, com CRC.
 *
 * O campo 01 (Point of Initiation) usa "11" = estático/reutilizável, que é
 * exatamente o modelo do produto: nada de payload dinâmico via URL, tudo vai
 * dentro do QR.
 */
export function buildPixPayload(input: PixPayloadInput): string {
  assertValidTxid(input.txid);

  const merchantAccount =
    tlv("00", "br.gov.bcb.pix") + tlv("01", input.pixKey.trim());

  const withoutCrc =
    tlv("00", "01") +
    tlv("01", "11") +
    tlv("26", merchantAccount) +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", formatAmount(input.amountCents)) +
    tlv("58", "BR") +
    tlv("59", sanitizeText(input.merchantName, 25) || "PIXIE") +
    tlv("60", sanitizeText(input.merchantCity, 15) || "SAO PAULO") +
    tlv("62", tlv("05", input.txid)) +
    "6304";

  return withoutCrc + crc16(withoutCrc);
}

/** Revalida um payload recebido: confere o CRC dos últimos 4 caracteres. */
export function verifyPayloadCrc(payload: string): boolean {
  if (payload.length < 8) return false;
  const body = payload.slice(0, -4);
  const provided = payload.slice(-4).toUpperCase();
  return crc16(body) === provided;
}
