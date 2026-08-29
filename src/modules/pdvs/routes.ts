// ---------------------------------------------------------------------------
// Pontos de venda.
//
// Prefixo de txid e código de acesso são gerados AQUI. No protótipo saíam do
// cliente (`prefixFrom` + `randCode` no modal), o que não tem como garantir
// unicidade — e unicidade é exatamente o que a conciliação por txid exige.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { lookupHash, openText, seal } from "../../lib/crypto.js";
import { conflict, notFound } from "../../lib/errors.js";
import { generateAccessCode, prefixFrom } from "../../lib/ids.js";
import { pdvTotals, zeroTotals } from "./aggregates.js";

const createSchema = z.object({
  name: z.string().trim().min(2, "Dê um nome ao PDV.").max(60),
});

/** Colisão de código de 6 dígitos é rara mas possível; tentamos algumas vezes. */
const CODE_ATTEMPTS = 12;

export async function pdvRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.requireOwner);

  // --- Listagem -------------------------------------------------------------

  app.get("/pdvs", async (req) => {
    const accountId = req.owner.accountId;
    const [pdvs, totals] = await Promise.all([
      app.prisma.pdv.findMany({
        where: { accountId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          prefix: true,
          status: true,
          createdAt: true,
        },
      }),
      pdvTotals(app.prisma, accountId),
    ]);

    return pdvs.map((pdv) => ({
      ...pdv,
      ...(totals.get(pdv.id) ?? zeroTotals()),
    }));
  });

  // --- Criação --------------------------------------------------------------

  app.post("/pdvs", async (req, reply) => {
    const { name } = createSchema.parse(req.body);
    const accountId = req.owner.accountId;

    const prefix = await uniquePrefix(app, accountId, prefixFrom(name));
    const { code, sealed } = await uniqueAccessCode(app);

    const pdv = await app.prisma.pdv.create({
      data: {
        accountId,
        name,
        prefix,
        accessCodeEnc: sealed.cipherText,
        accessCodeIv: sealed.iv,
        accessCodeTag: sealed.authTag,
        accessCodeLookup: lookupHash(code),
        status: "ATIVO",
      },
      select: { id: true, name: true, prefix: true, status: true, createdAt: true },
    });

    reply.code(201);
    // O código vai na resposta da criação porque a tela o exibe na hora.
    // Depois disso, só pelo endpoint dedicado de revelação.
    return { ...pdv, ...zeroTotals(), accessCode: code };
  });

  // --- Revelação do código --------------------------------------------------

  app.get("/pdvs/:id/access-code", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const pdv = await app.prisma.pdv.findFirst({
      where: { id, accountId: req.owner.accountId },
    });
    if (!pdv) throw notFound("PDV não encontrado.");

    // Revelar credencial é evento auditável, mesmo sendo o próprio dono.
    await app.prisma.connectionLog.create({
      data: {
        accountId: req.owner.accountId,
        message: `Código de acesso do PDV "${pdv.name}" foi exibido`,
        ok: true,
      },
    });

    return {
      accessCode: openText({
        cipherText: pdv.accessCodeEnc,
        iv: pdv.accessCodeIv,
        authTag: pdv.accessCodeTag,
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Unicidade
// ---------------------------------------------------------------------------

/** "Caixa 1" e "Caixa 2" colidem em "C1"/"C2"? Não — mas "Caixa A"/"Caixa B" sim. */
async function uniquePrefix(
  app: FastifyInstance,
  accountId: string,
  base: string,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 3)}${attempt}`;
    const taken = await app.prisma.pdv.findFirst({
      where: { accountId, prefix: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  throw conflict("Não foi possível derivar um prefixo livre para este nome.");
}

/**
 * O código é único GLOBALMENTE, não por conta: o vendedor digita 6 dígitos sem
 * nenhum contexto de qual conta é a dele.
 */
async function uniqueAccessCode(app: FastifyInstance) {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = generateAccessCode();
    const taken = await app.prisma.pdv.findUnique({
      where: { accessCodeLookup: lookupHash(code) },
      select: { id: true },
    });
    if (!taken) return { code, sealed: seal(code) };
  }
  throw conflict("Não foi possível gerar um código de acesso livre. Tente de novo.");
}
