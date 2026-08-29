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
