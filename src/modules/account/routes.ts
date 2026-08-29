// ---------------------------------------------------------------------------
// Conta: chave Pix, certificados mTLS e diagnóstico de conexão.
//
// Estas rotas servem a tela "Segurança e conexão" do painel do dono.
// Nenhuma delas devolve material de certificado — só metadados.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../../lib/errors.js";
import { seal } from "../../lib/crypto.js";
import { createStatementProvider } from "../../statement/index.js";

const pixKeySchema = z.object({
  pixKeyType: z.enum(["CNPJ", "CPF", "EMAIL", "TELEFONE", "ALEATORIA"]),
  pixKey: z.string().trim().min(1, "Informe a chave Pix.").max(77),
});

/** Limite generoso para um par .crt/.key — qualquer coisa acima é suspeita. */
const MAX_CERT_BYTES = 64 * 1024;

export async function accountRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.requireOwner);

  // --- Dados da conta -------------------------------------------------------

  app.get("/account", async (req) => {
    const account = await app.prisma.account.findUniqueOrThrow({
      where: { id: req.owner.accountId },
      select: {
        id: true,
        name: true,
        email: true,
        pixKeyType: true,
        pixKey: true,
      },
    });
    return account;
  });

  app.patch("/account/pix-key", async (req) => {
    const body = pixKeySchema.parse(req.body);
    return app.prisma.account.update({
      where: { id: req.owner.accountId },
      data: body,
      select: { pixKeyType: true, pixKey: true },
    });
  });

  // --- Certificados ---------------------------------------------------------

  app.get("/account/certificates", async (req) => {
    const certs = await app.prisma.certificate.findMany({
      where: { accountId: req.owner.accountId },
      // Sem cipherText/iv/authTag: material de certificado não sai da API.
      select: { kind: true, filename: true, uploadedAt: true },
    });
    return certs;
  });

  app.post("/account/certificates", async (req) => {
    const file = await req.file({ limits: { fileSize: MAX_CERT_BYTES } });
    if (!file) throw badRequest("Envie um arquivo.");

    const kindRaw = (file.fields.kind as { value?: string } | undefined)?.value;
    const kind = kindRaw?.toUpperCase();
    if (kind !== "CRT" && kind !== "KEY") {
      throw badRequest('Campo "kind" deve ser CRT ou KEY.');
    }

    const buffer = await file.toBuffer();
    if (buffer.length === 0) throw badRequest("Arquivo vazio.");

    const content = buffer.toString("utf8");
    if (!content.includes("-----BEGIN")) {
      throw badRequest(
        "Arquivo não parece ser PEM. Exporte o certificado no formato .crt/.key em texto.",
      );
    }

    const sealed = seal(buffer);
    const data = {
      filename: file.filename,
      cipherText: sealed.cipherText,
      iv: sealed.iv,
      authTag: sealed.authTag,
      uploadedAt: new Date(),
    };

    await app.prisma.certificate.upsert({
      where: { accountId_kind: { accountId: req.owner.accountId, kind } },
      create: { accountId: req.owner.accountId, kind, ...data },
      update: data,
    });

    await log(app, req.owner.accountId, `Certificado ${kind} armazenado (cifrado em repouso)`, true);

    return { kind, filename: file.filename, uploadedAt: data.uploadedAt };
  });

  // --- Diagnóstico ----------------------------------------------------------

  app.get("/account/connection-logs", async (req) => {
    const logs = await app.prisma.connectionLog.findMany({
      where: { accountId: req.owner.accountId },
      orderBy: { at: "desc" },
      take: 50,
      select: { id: true, at: true, message: true, ok: true },
    });
    return logs.reverse(); // cronológico, como um terminal
  });

  app.post("/account/connection-test", async (req) => {
    const account = await app.prisma.account.findUniqueOrThrow({
      where: { id: req.owner.accountId },
    });

    const provider = createStatementProvider(app.prisma);
    const result = await provider.testConnection(account);

    for (const step of result.steps) {
      await log(app, account.id, step, result.ok);
    }

    return result;
  });
}

async function log(
  app: FastifyInstance,
  accountId: string,
  message: string,
  ok: boolean,
) {
  await app.prisma.connectionLog.create({ data: { accountId, message, ok } });
}
