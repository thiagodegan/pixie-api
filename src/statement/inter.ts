// ---------------------------------------------------------------------------
// Banco Inter — extrato via mTLS.
//
// Esqueleto funcional, ativado por STATEMENT_PROVIDER=inter. Ainda não validado
// contra o sandbox (não temos certificado), então trate as formas de resposta
// como hipótese a conferir, não como fato.
//
// Regra inegociável: o par .crt/.key é decifrado direto para MEMÓRIA e entregue
// ao https.Agent. Nunca toca o disco, nunca entra em log.
// ---------------------------------------------------------------------------

import https from "node:https";
import type { Account, PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { open } from "../lib/crypto.js";
import type { StatementEntry, StatementProvider } from "./types.js";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface InterCredentials {
  cert: Buffer;
  key: Buffer;
}

/** POST/GET sobre um agent mTLS, sem dependência externa. */
function request(
  url: string,
  options: https.RequestOptions & { agent: https.Agent },
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("timeout na API do Inter")));
    if (body) req.write(body);
    req.end();
  });
}

export class InterStatementProvider implements StatementProvider {
  readonly name = "banco-inter";

  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly prisma: PrismaClient) {}

  // -------------------------------------------------------------------------
  // Credenciais
  // -------------------------------------------------------------------------

  private async loadCredentials(accountId: string): Promise<InterCredentials> {
    const certs = await this.prisma.certificate.findMany({ where: { accountId } });
    const crt = certs.find((c) => c.kind === "CRT");
    const key = certs.find((c) => c.kind === "KEY");

    if (!crt || !key) {
      throw new Error(
        "Certificados mTLS não configurados. Envie o .crt e o .key na tela de Segurança.",
      );
    }

    return { cert: open(crt), key: open(key) };
  }

  private agentFor(creds: InterCredentials): https.Agent {
    return new https.Agent({
      cert: creds.cert,
      key: creds.key,
      keepAlive: true,
    });
  }

  private async accessToken(
    account: Account,
    agent: https.Agent,
  ): Promise<string> {
    const cached = this.tokens.get(account.id);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.accessToken;
    }

    if (!config.INTER_CLIENT_ID || !config.INTER_CLIENT_SECRET) {
      throw new Error("INTER_CLIENT_ID / INTER_CLIENT_SECRET não configurados.");
    }

    const form = new URLSearchParams({
      client_id: config.INTER_CLIENT_ID,
      client_secret: config.INTER_CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "extrato.read",
    }).toString();

    const res = await request(
      `${config.INTER_BASE_URL}/oauth/v2/token`,
      {
        method: "POST",
        agent,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(form),
        },
      },
      form,
    );

    if (res.status !== 200) {
      throw new Error(`Falha ao obter token do Inter (HTTP ${res.status})`);
    }

    const parsed = JSON.parse(res.body) as {
      access_token: string;
      expires_in: number;
    };

    this.tokens.set(account.id, {
      accessToken: parsed.access_token,
      expiresAt: Date.now() + parsed.expires_in * 1000,
    });

    return parsed.access_token;
  }

  // -------------------------------------------------------------------------
  // Extrato
  // -------------------------------------------------------------------------

  async fetchEntries(account: Account, since: Date): Promise<StatementEntry[]> {
    const creds = await this.loadCredentials(account.id);
    const agent = this.agentFor(creds);

    try {
      const token = await this.accessToken(account, agent);
      const today = new Date();

      const query = new URLSearchParams({
        dataInicio: isoDate(since),
        dataFim: isoDate(today),
        tipoOperacao: "C", // só créditos
      });

      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      };
      if (config.INTER_ACCOUNT) {
        headers["x-conta-corrente"] = config.INTER_ACCOUNT;
      }

      const res = await request(
        `${config.INTER_BASE_URL}/banking/v2/extrato/completo?${query}`,
        { method: "GET", agent, headers },
      );

      if (res.status === 429) {
        // Risco conhecido do produto: a API gratuita de extrato tem limite de
        // chamadas. Erro explícito para o worker aplicar backoff.
        throw new Error("RATE_LIMIT: Inter respondeu 429");
      }
      if (res.status !== 200) {
        throw new Error(`Extrato do Inter respondeu HTTP ${res.status}`);
      }

      return parseInterStatement(res.body);
    } finally {
      agent.destroy();
    }
  }

  async testConnection(account: Account): Promise<{ ok: boolean; steps: string[] }> {
    const steps: string[] = [];
    try {
      steps.push("Decifrando certificados mTLS…");
      const creds = await this.loadCredentials(account.id);

      steps.push("Certificado carregado em memória (não persistido em disco)");
      const agent = this.agentFor(creds);

      try {
        steps.push(`Autenticando em ${config.INTER_BASE_URL}…`);
        const started = Date.now();
        await this.accessToken(account, agent);
        steps.push(`Token obtido — ${Date.now() - started}ms`);

        steps.push("Consultando endpoint de extrato…");
        await this.fetchEntries(account, new Date(Date.now() - 60_000));
        steps.push("Conexão estabelecida com sucesso");
        return { ok: true, steps };
      } finally {
        agent.destroy();
      }
    } catch (err) {
      steps.push(`Falhou: ${(err as Error).message}`);
      return { ok: false, steps };
    }
  }
}

// ---------------------------------------------------------------------------
// Normalização da resposta
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface InterTransaction {
  idTransacao?: string;
  dataInclusao?: string;
  dataEntrada?: string;
  tipoOperacao?: string;
  valor?: string | number;
  titulo?: string;
  descricao?: string;
  detalhes?: {
    nomePagador?: string;
    cpfCnpjPagador?: string;
    descricaoPix?: string;
    txId?: string;
  };
}

/** Converte a resposta do Inter em StatementEntry. Valores viram centavos. */
export function parseInterStatement(raw: string): StatementEntry[] {
  const payload = JSON.parse(raw) as { transacoes?: InterTransaction[] };
  const transactions = payload.transacoes ?? [];

  return transactions
    .filter((t) => (t.tipoOperacao ?? "C").toUpperCase() === "C")
    .map((t) => {
      const occurred = t.dataInclusao ?? t.dataEntrada;
      // O txid pode chegar em campo próprio ou embutido na descrição —
      // juntamos tudo e deixamos o matcher procurar.
      const description = [t.detalhes?.txId, t.detalhes?.descricaoPix, t.descricao, t.titulo]
        .filter(Boolean)
        .join(" ");

      return {
        externalId: t.idTransacao ?? `${occurred}-${t.valor}-${description}`,
        amountCents: toCents(t.valor),
        payerName: t.detalhes?.nomePagador ?? null,
        payerDocument: t.detalhes?.cpfCnpjPagador ?? null,
        rawDescription: description,
        occurredAt: occurred ? new Date(occurred) : new Date(),
      };
    })
    .filter((e) => e.amountCents > 0);
}

/** "123.45" | 123.45 -> 12345. Arredonda para blindar contra erro de float. */
function toCents(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const numeric = typeof value === "number" ? value : Number(value.replace(",", "."));
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
}
