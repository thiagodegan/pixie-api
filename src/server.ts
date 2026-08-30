import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import { Prisma } from "@prisma/client";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { config, isProduction, trustProxy } from "./config.js";
import { AppError } from "./lib/errors.js";
import authPlugin from "./plugins/auth.js";
import prismaPlugin from "./plugins/prisma.js";
import { accountRoutes } from "./modules/account/routes.js";
import { authRoutes } from "./modules/auth/routes.js";
import { chargeRoutes } from "./modules/charges/routes.js";
import { dashboardRoutes } from "./modules/dashboard/routes.js";
import { devRoutes } from "./modules/dev/routes.js";
import { pdvAuthRoutes, pdvSessionRoutes } from "./modules/pdv/routes.js";
import { pdvRoutes } from "./modules/pdvs/routes.js";
import { receiptRoutes } from "./modules/receipts/routes.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: isProduction ? "info" : "debug",
      // Chave Pix, certificado e código de acesso jamais em log.
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.password",
        "req.body.code",
      ],
    },
    // Só confia em X-Forwarded-For de quem TRUST_PROXY autorizar. Com `true`,
    // qualquer cliente forjaria o próprio IP e escaparia dos limites de
    // tentativa — inclusive o do código de 6 dígitos do PDV.
    trustProxy,
  });

  // --- Infra ----------------------------------------------------------------

  await app.register(fastifyCors, {
    origin: config.CORS_ORIGINS,
    credentials: true, // o painel do dono autentica por cookie
    // O default do plugin é GET,HEAD,POST — sem PATCH aqui, salvar a chave Pix
    // falha no preflight, e só em produção (mesma origem em dev disfarça).
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
  });
  await app.register(fastifyRateLimit, { global: false, max: 100, timeWindow: "1 minute" });
  await app.register(fastifyMultipart);
  await app.register(prismaPlugin);
  await app.register(authPlugin);

  // --- Tratamento de erro ---------------------------------------------------

  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: error.issues[0]?.message ?? "Dados inválidos.",
        code: "VALIDATION_ERROR",
        fields: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return reply.code(404).send({ error: "Não encontrado.", code: "NOT_FOUND" });
      }
      if (error.code === "P2002") {
        return reply.code(409).send({ error: "Registro já existe.", code: "CONFLICT" });
      }
    }

    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code ?? "REQUEST_ERROR",
      });
    }

    // 5xx: log completo no servidor, mensagem genérica no cliente.
    req.log.error({ err: error }, "erro não tratado");
    return reply.code(500).send({
      error: "Erro interno. Tente novamente.",
      code: "INTERNAL_ERROR",
    });
  });

  // --- Rotas ----------------------------------------------------------------

  app.get("/health", async () => {
    await app.prisma.$queryRaw`SELECT 1`;
    return { status: "ok", provider: config.STATEMENT_PROVIDER };
  });

  await app.register(authRoutes);
  await app.register(pdvAuthRoutes);
  await app.register(accountRoutes);
  await app.register(pdvRoutes);
  await app.register(dashboardRoutes);
  await app.register(receiptRoutes);
  await app.register(pdvSessionRoutes);
  await app.register(chargeRoutes);

  if (!isProduction) {
    await app.register(devRoutes);
    app.log.warn("rotas /dev registradas (NODE_ENV != production)");
  }

  return app;
}
