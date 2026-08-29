// ---------------------------------------------------------------------------
// Criptografia em repouso.
//
// Dois primitivos, com propósitos diferentes:
//   seal/open  — AES-256-GCM reversível. Para o que precisa voltar em claro:
//                certificados mTLS (o worker precisa deles para o handshake) e
//                códigos de acesso (o painel do dono os revela).
//   lookupHash — HMAC-SHA256 determinístico. Para achar uma linha por um valor
//                secreto sem varrer a tabela decifrando registro a registro.
// ---------------------------------------------------------------------------

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // recomendado para GCM

const key = Buffer.from(config.ENCRYPTION_KEY, "hex");

/**
 * O Prisma tipa colunas `Bytes` como `Uint8Array<ArrayBuffer>`, enquanto o
 * `Buffer` do Node é `Uint8Array<ArrayBufferLike>` — os dois não são
 * atribuíveis entre si. Convertemos na saída para o que vai ao banco, e
 * aceitamos o tipo largo na entrada para ler de volta sem cerimônia.
 */
const toBytes = (b: Buffer): Uint8Array<ArrayBuffer> => Uint8Array.from(b);

/** O que sai de `seal` e vai direto para uma coluna Bytes. */
export interface Sealed {
  cipherText: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
}

/** O que `open` aceita — inclusive o que veio cru do Prisma. */
export interface SealedInput {
  cipherText: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}

export function seal(plain: Uint8Array | string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const cipherText = Buffer.concat([
    cipher.update(typeof plain === "string" ? Buffer.from(plain, "utf8") : plain),
    cipher.final(),
  ]);
  return {
    cipherText: toBytes(cipherText),
    iv: toBytes(iv),
    authTag: toBytes(cipher.getAuthTag()),
  };
}

/** Decifra. Lança se o authTag não bater — adulteração não passa silenciosa. */
export function open(sealed: SealedInput): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.cipherText), decipher.final()]);
}

export function openText(sealed: SealedInput): string {
  return open(sealed).toString("utf8");
}

/// HMAC determinístico do código de acesso, para busca indexada.
export function lookupHash(value: string): string {
  return createHmac("sha256", config.ACCESS_CODE_PEPPER)
    .update(value)
    .digest("hex");
}

/// Comparação de strings resistente a timing attack.
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
