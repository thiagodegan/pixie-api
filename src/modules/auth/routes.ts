// ---------------------------------------------------------------------------
// Autenticação do dono da conta.
// ---------------------------------------------------------------------------

import { hash, verify } from "@node-rs/argon2";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SESSION_COOKIE, sessionCookieOptions } from "../../plugins/auth.js";
import { badRequest, conflict, unauthorized } from "../../lib/errors.js";
import { sanitizeText } from "../../lib/emv.js";

const loginSchema = z.object({
  email: z.string().email("E-mail inválido."),
  password: z.string().min(1, "Informe a senha."),
});

/**
 * Senha mínima de 10 caracteres. Esta conta comanda uma chave Pix de
 * recebimento e certificados bancários — não é uma conta de newsletter.
 */
const MIN_PASSWORD = 10;

const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Informe o nome do seu negócio.")
    .max(60, "Nome muito longo."),
  email: z.string().trim().toLowerCase().email("E-mail inválido."),
  password: z
    .string()
    .min(MIN_PASSWORD, `A senha precisa de pelo menos ${MIN_PASSWORD} caracteres.`)
    .max(200, "Senha muito longa."),
});

export async function authRoutes(app: FastifyInstance) {
  // --- Cadastro -------------------------------------------------------------

  app.post("/auth/register", {
    // Endpoint público que ESCREVE no banco: sem limite, vira alvo de criação
    // de contas em massa. O teto é por IP.
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
    handler: async (req, reply) => {
      const { name, email, password } = registerSchema.parse(req.body);

      // O nome da conta vai para o campo 59 do BR Code (nome do recebedor),
      // que só aceita ASCII imprimível. "名前" ou "🍕" passariam na validação
      // acima e produziriam um QR sem nome de recebedor — melhor recusar aqui
      // do que gerar um Pix estranho no balcão.
      if (sanitizeText(name, 25).length === 0) {
        throw badRequest(
          "O nome do negócio precisa conter letras ou números.",
          "INVALID_MERCHANT_NAME",
        );
      }

      const account = await app.prisma.account
        .create({
          data: {
            name,
            email,
            passwordHash: await hash(password),
            // Chave Pix e certificados ficam para a tela de Segurança: pedir
            // dado bancário antes da pessoa conhecer o produto derruba o
            // cadastro.
          },
          select: { id: true, name: true, email: true },
        })
        .catch((err: unknown) => {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          ) {
            throw conflict(
              "Já existe uma conta com este e-mail.",
              "EMAIL_TAKEN",
            );
          }
          throw err;
        });

      // Entra direto: mandar para o login logo após cadastrar é atrito puro.
      const token = app.jwt.sign(
        { scope: "owner", accountId: account.id, email: account.email },
        { expiresIn: "12h" },
      );
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());

      req.log.info({ accountId: account.id }, "nova conta criada");
      reply.code(201);
      return account;
    },
  });

  // --- Login ----------------------------------------------------------------

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
