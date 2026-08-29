// ---------------------------------------------------------------------------
// Geração de identificadores.
//
// Tudo que precisa ser único nasce AQUI, no servidor. No protótipo o front
// gerava txid com Math.random() e código de acesso no cliente — nenhum dos dois
// tem como garantir unicidade, que é justamente o que a conciliação exige.
// ---------------------------------------------------------------------------

import { randomInt } from "node:crypto";

/**
 * Alfabeto sem os caracteres que se confundem lidos num extrato ou ditados por
 * telefone: I/1, O/0, S/5, U/V. O txid vai ser lido por humanos conferindo
 * pagamento — legibilidade não é detalhe estético aqui.
 */
const TXID_ALPHABET = "ABCDEFGHJKLMNPQRTWXYZ2346789";

/** Sufixo aleatório do txid, uniforme (randomInt evita o viés do módulo). */
export function randomToken(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += TXID_ALPHABET[randomInt(TXID_ALPHABET.length)];
  }
  return out;
}

/**
 * txid = prefixo do PDV + token aleatório.
 *
 * Sem hífen: o Pix restringe o campo a [A-Za-z0-9]{1,25}. O prefixo dá a
 * rastreabilidade por caixa; o token dá a unicidade. 12 chars sobre um alfabeto
 * de 28 são ~57 bits — colisão é irrelevante, e a unique constraint no banco é
 * a rede de segurança.
 */
export function generateTxid(prefix: string): string {
  const clean = prefix.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 4);
  return `${clean}${randomToken(12)}`;
}

/** Código de acesso do vendedor: 6 dígitos, sem viés. */
export function generateAccessCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Deriva o prefixo de txid a partir do nome do PDV — mesma regra do
 * `prefixFrom` que vivia no front, agora autoritativa no servidor.
 * "Caixa Balcão" -> "CB", "Loja Shopping Sul" -> "LSS".
 */
export function prefixFrom(name: string): string {
  const initials = name
    .normalize("NFD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 4);

  return initials.padEnd(3, "X");
}
