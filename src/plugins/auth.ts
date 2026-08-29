// ---------------------------------------------------------------------------
// Autenticação — dois escopos deliberadamente separados.
//
//   owner : dono da conta. E-mail + senha, JWT em cookie httpOnly. Longo.
//   pdv   : caixa no balcão. Código de 6 dígitos, JWT em Bearer no header,
//           guardado em localStorage porque o front do vendedor roda em outra
//           origem e não compartilha cookie com o painel.
//
// Um token de PDV NUNCA abre rota de dono. O escopo vai dentro do token e é
// conferido no guard, e não inferido do formato de entrega.
// ---------------------------------------------------------------------------

import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { config, isProduction } from "../config.js";
import { unauthorized } from "../lib/errors.js";

export const SESSION_COOKIE = "pixie_session";

export interface OwnerToken {
  scope: "owner";
  accountId: string;
  email: string;
}

export interface PdvToken {
  scope: "pdv";
  accountId: string;
  pdvId: string;
}

export type PixieToken = OwnerToken | PdvToken;

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: PixieToken;
    user: PixieToken;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    requireOwner: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePdv: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    owner: OwnerToken;
    pdv: PdvToken;
  }
}

async function authPlugin(app: FastifyInstance) {
  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    cookie: { cookieName: SESSION_COOKIE, signed: false },
  });

  // Declaradas no boot para o V8 manter a mesma shape em toda request; o guard
  // preenche o campo do escopo correspondente antes do handler rodar.
  app.decorateRequest("owner", null as unknown as OwnerToken);
  app.decorateRequest("pdv", null as unknown as PdvToken);

  app.decorate("requireOwner", async (req: FastifyRequest) => {
    let token: PixieToken;
    try {
      token = await req.jwtVerify();
    } catch {
      throw unauthorized();
    }
    if (token.scope !== "owner") {
      throw unauthorized("Esta área exige a sessão do dono da conta.");
    }
    req.owner = token;
  });

  app.decorate("requirePdv", async (req: FastifyRequest) => {
    let token: PixieToken;
    try {
      token = await req.jwtVerify();
    } catch {
      throw unauthorized();
    }
    if (token.scope !== "pdv") {
      throw unauthorized("Esta área exige o código de acesso do PDV.");
    }
    req.pdv = token;
  });
}

/** Opções do cookie de sessão do dono. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.COOKIE_SECURE || isProduction,
    path: "/",
    maxAge: 60 * 60 * 12, // 12h
  };
}

export default fp(authPlugin, { name: "auth" });
