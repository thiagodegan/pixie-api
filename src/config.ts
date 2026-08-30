// ---------------------------------------------------------------------------
// Configuração — lida uma vez, no boot. Env inválido derruba o processo aqui,
// e não no meio de uma requisição.
// ---------------------------------------------------------------------------

import { z } from "zod";

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "deve ser 32 bytes em hexadecimal (64 chars)");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32),
  /// Chave mestra do AES-256-GCM (certificados e códigos de acesso).
  ENCRYPTION_KEY: hex32,
  /// Pepper do HMAC de busca do código de acesso.
  ACCESS_CODE_PEPPER: z.string().min(16),

  /**
   * Em quem confiar para descobrir o IP real do cliente. Valores aceitos:
   *   false            nenhuma confiança (padrão — seguro sem proxy na frente)
   *   <número>         quantidade de saltos de proxy à sua frente (ex: 1)
   *   <ips/cidrs>      lista separada por vírgula (ex: 10.0.0.0/8,172.16.0.0/12)
   *
   * NUNCA use "true" em produção: passa a aceitar qualquer X-Forwarded-For que
   * o cliente enviar, e todo limite por IP (login, código do PDV, cadastro)
   * vira contornável trocando um header.
   */
  TRUST_PROXY: z.string().default("false"),

  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://localhost:5174")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),

  STATEMENT_PROVIDER: z.enum(["simulated", "inter"]).default("simulated"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(2000),
  /// Janela de sobreposição ao reler o extrato, para não perder linhas na borda.
  POLL_OVERLAP_SECONDS: z.coerce.number().int().min(0).default(120),
  CHARGE_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  INTER_BASE_URL: z.string().default("https://cdpj.partners.bancointer.com.br"),
  INTER_CLIENT_ID: z.string().optional(),
  INTER_CLIENT_SECRET: z.string().optional(),
  INTER_ACCOUNT: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`Configuração inválida:\n${issues}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

export const isProduction = config.NODE_ENV === "production";

/** O que o Fastify aceita em `trustProxy`. */
type TrustProxy = boolean | string | ((address: string, hop: number) => boolean);

/**
 * Converte TRUST_PROXY no formato do Fastify.
 *
 * A contagem de saltos vira função porque o tipo do Fastify não aceita número,
 * embora o proxy-addr por baixo aceite: confiar em "n saltos" é literalmente
 * `hop < n`.
 */
function parseTrustProxy(raw: string): TrustProxy {
  const value = raw.trim();
  if (value === "" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") {
    console.warn(
      "[config] TRUST_PROXY=true aceita qualquer X-Forwarded-For — os limites " +
        "por IP deixam de valer. Use um número de saltos ou uma lista de CIDRs.",
    );
    return true;
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return (_address: string, hop: number) => hop < hops;
  }
  return value;
}

export const trustProxy = parseTrustProxy(config.TRUST_PROXY);
