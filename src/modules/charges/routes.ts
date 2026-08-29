// ---------------------------------------------------------------------------
// Cobranças: gerar o QR e acompanhar a confirmação.
//
// O front do vendedor consulta GET /charges/:id em laço curto. É deliberado
// que a tela não decida nada sobre pagamento: ela só reflete o status que a
// conciliação escreveu.
// ---------------------------------------------------------------------------

import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { buildPixPayload } from "../../lib/emv.js";
import { generateTxid } from "../../lib/ids.js";

const createSchema = z.object({
  amountCents: z
    .number()
    .int("O valor deve estar em centavos.")
    .positive("Informe um valor maior que zero.")
    .max(100_000_000, "Valor acima do limite (R$ 1.000.000,00)."),
});

const TXID_ATTEMPTS = 5;

export async function chargeRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.requirePdv);

  // --- Criar cobrança -------------------------------------------------------

  app.post("/charges", async (req, reply) => {
    const { amountCents } = createSchema.parse(req.body);
    const { accountId, pdvId } = req.pdv;

    const [account, pdv] = await Promise.all([
      app.prisma.account.findUniqueOrThrow({ where: { id: accountId } }),
      app.prisma.pdv.findUniqueOrThrow({ where: { id: pdvId } }),
    ]);

    if (!account.pixKey) {
      throw badRequest(
        "A conta ainda não tem chave Pix configurada. O dono precisa defini-la no painel.",
        "NO_PIX_KEY",
      );
    }

    const expiresAt = new Date(Date.now() + config.CHARGE_TTL_SECONDS * 1000);

    // A unique do txid é a autoridade. Em colisão, o create falha (P2002) e
    // tentamos outro — não confiamos só na improbabilidade do gerador.
    for (let attempt = 0; attempt < TXID_ATTEMPTS; attempt++) {
      const txid = generateTxid(pdv.prefix);
      const pixPayload = buildPixPayload({
        pixKey: account.pixKey,
        merchantName: account.name,
        merchantCity: "SAO PAULO",
        amountCents,
        txid,
      });

      try {
        const charge = await app.prisma.charge.create({
          data: { accountId, pdvId, txid, amountCents, pixPayload, expiresAt },
          select: {
            id: true,
            txid: true,
            amountCents: true,
            status: true,
            pixPayload: true,
            createdAt: true,
            expiresAt: true,
          },
        });
        reply.code(201);
        return charge;
      } catch (err) {
        const isCollision =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
        if (!isCollision) throw err;
      }
    }

    throw conflict("Não foi possível gerar um txid livre. Tente novamente.");
  });

  // --- Status ---------------------------------------------------------------

  app.get("/charges/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const charge = await app.prisma.charge.findFirst({
      // Escopado ao PDV do token: um caixa não enxerga cobrança de outro.
      where: { id, pdvId: req.pdv.pdvId },
      select: {
        id: true,
        txid: true,
        amountCents: true,
        status: true,
        pixPayload: true,
        payerName: true,
        createdAt: true,
        expiresAt: true,
        paidAt: true,
      },
    });
    if (!charge) throw notFound("Cobrança não encontrada.");

    return charge;
  });

  app.post("/charges/:id/cancel", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const charge = await app.prisma.charge.findFirst({
      where: { id, pdvId: req.pdv.pdvId },
      select: { id: true, status: true },
    });
    if (!charge) throw notFound("Cobrança não encontrada.");
    if (charge.status === "PAGO") {
      throw conflict("Esta cobrança já foi paga e não pode ser cancelada.");
    }

    return app.prisma.charge.update({
      where: { id },
      data: { status: "CANCELADO" },
      select: { id: true, status: true },
    });
  });
}
