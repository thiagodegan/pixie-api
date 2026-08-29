// ---------------------------------------------------------------------------
// Autenticação do dono da conta.
// ---------------------------------------------------------------------------

import { verify } from "@node-rs/argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE, sessionCookieOptions } from "../../plugins/auth.js";
import { unauthorized } from "../../lib/errors.js";

const loginSchema = z.object({
  email: z.string().email("E-mail inválido."),
  password: z.string().min(1, "Informe a senha."),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      const { email, password } = loginSchema.parse(req.body);

      const account = await app.prisma.account.findUnique({
        where: { email: email.toLowerCase() },
      });

      // Mensagem única para e-mail inexistente e senha errada: dizer qual das
      // duas falhou entrega a existência da conta a quem estiver sondando.
      const invalid = unauthorized("E-mail ou senha incorretos.", "INVALID_CREDENTIALS");
      if (!account) throw invalid;
      if (!(await verify(account.passwordHash, password))) throw invalid;

      const token = app.jwt.sign(
        { scope: "owner", accountId: account.id, email: account.email },
        { expiresIn: "12h" },
      );

      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
      return { id: account.id, name: account.name, email: account.email };
    },
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", { onRequest: [app.requireOwner] }, async (req) => {
    const account = await app.prisma.account.findUniqueOrThrow({
      where: { id: req.owner.accountId },
      select: { id: true, name: true, email: true },
    });
    return account;
  });
}
