// ---------------------------------------------------------------------------
// Lado do vendedor: login por código de 6 dígitos e recebimentos do dia.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { startOfToday } from "../../lib/dates.js";
import { lookupHash } from "../../lib/crypto.js";
import { unauthorized } from "../../lib/errors.js";

const authSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "O código tem 6 dígitos."),
});

export async function pdvAuthRoutes(app: FastifyInstance) {
  app.post("/pdv/auth", {
    // Seis dígitos é um espaço pequeno (10^6). Sem limite de tentativas, dá
    // para varrer o espaço inteiro; com limite por IP, não dá.
    config: { rateLimit: { max: 8, timeWindow: "1 minute" } },
    handler: async (req) => {
      const { code } = authSchema.parse(req.body);

      // Busca pelo HMAC: índice único, tempo constante, sem decifrar a tabela.
      const pdv = await app.prisma.pdv.findUnique({
        where: { accessCodeLookup: lookupHash(code) },
        select: { id: true, accountId: true, name: true, prefix: true, status: true },
      });

      if (!pdv || pdv.status === "INATIVO") {
        throw unauthorized("Código inválido. Tente novamente.", "INVALID_CODE");
      }

      const token = app.jwt.sign(
        { scope: "pdv", accountId: pdv.accountId, pdvId: pdv.id },
        { expiresIn: "30d" }, // o caixa não faz login todo dia
      );

      return {
        token,
        pdv: { id: pdv.id, name: pdv.name, prefix: pdv.prefix },
      };
    },
  });
}

export async function pdvSessionRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.requirePdv);

  app.get("/pdv/me", async (req) => {
    const pdv = await app.prisma.pdv.findUniqueOrThrow({
      where: { id: req.pdv.pdvId },
      select: { id: true, name: true, prefix: true, status: true },
    });
    return pdv;
  });

  app.get("/pdv/receipts", async (req) => {
    const receipts = await app.prisma.charge.findMany({
      where: {
        pdvId: req.pdv.pdvId,
        status: "PAGO",
        paidAt: { gte: startOfToday() },
      },
      orderBy: { paidAt: "desc" },
      select: {
        id: true,
        txid: true,
        amountCents: true,
        payerName: true,
        paidAt: true,
      },
    });

    return {
      receipts,
      totalCents: receipts.reduce((acc, r) => acc + r.amountCents, 0),
    };
  });
}
