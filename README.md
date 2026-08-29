# pixie-api

Backend do Pixie (PixFree). Fastify + Prisma + PostgreSQL.

É aqui que vive o núcleo do produto: gerar o QR Pix estático com um `txid` único e confirmar o pagamento lendo o extrato bancário, em vez de pagar a API de Cobrança.

## Rodar

Normalmente sobe junto com o resto pelo compose do diretório pai:

```bash
cd .. && docker compose up --build
```

Fora do Docker:

```bash
cp .env.example .env        # preencha os segredos
npm install
npx prisma migrate dev
npm run seed                # imprime as credenciais criadas
npm run dev
```

## Mapa do código

| Caminho | Responsabilidade |
|---|---|
| `src/lib/emv.ts` | BR Code EMV: TLV, CRC16-CCITT, `txid` no campo 62-05 |
| `src/lib/crypto.ts` | AES-256-GCM em repouso + HMAC de busca |
| `src/lib/ids.ts` | Geração de `txid`, código de acesso e prefixo |
| `src/statement/` | Fronteira com o banco: interface + adapters `simulated` e `inter` |
| `src/worker/matcher.ts` | A quem pertence uma linha do extrato |
| `src/worker/poller.ts` | Ciclo de leitura, ingestão idempotente e conciliação |
| `src/modules/` | Rotas, por domínio |

## Três decisões que valem conhecer antes de mexer

**1. `txid` é o único elo com o pagamento.** Ele é gerado no servidor, é `unique` global, e vai no campo 62-05 do payload. O Pix restringe o formato a `[A-Za-z0-9]{1,25}` — sem hífen. Se ele não voltar legível no extrato, o produto depende de heurística, e heurística não confirma sozinha (ver abaixo).

**2. Ambiguidade nunca vira confirmação.** O matcher aceita `txid` como evidência forte. Sem ele, valor + janela de tempo só confirma se houver **uma** candidata; com duas, ambas viram `REVISAO`. Confirmar a cobrança errada faz o vendedor entregar mercadoria contra um pagamento que não existe — é pior que não confirmar.

**3. O código de acesso do PDV é cifrado, não hasheado.** O painel do dono precisa revelá-lo, então guardamos `accessCodeEnc` (reversível) mais um `accessCodeLookup` (HMAC, `unique`) para o login do vendedor buscar em tempo constante. Ele é único **globalmente**, porque o vendedor manda só 6 dígitos, sem contexto de conta.

## Testes

```bash
npm test        # CRC16 contra vetor canônico, estrutura TLV, regras do matcher
```

## Rotas `/dev`

Só existem com `NODE_ENV != production` — em produção nem são registradas.

```bash
# injeta uma linha no extrato simulado
curl -X POST localhost:3000/dev/simulate-payment/<TXID> \
  -H 'content-type: application/json' \
  -d '{"payerName":"Camila R.", "delayMs":0, "omitTxid":false}'

# roda um ciclo de conciliação na hora
curl -X POST localhost:3000/dev/reconcile
```

`omitTxid: true` reproduz o risco central do produto: o identificador não voltar legível do banco.

## Ligar no Banco Inter de verdade

`STATEMENT_PROVIDER=inter`, mais `INTER_CLIENT_ID` / `INTER_CLIENT_SECRET`, e os certificados enviados pelo painel do dono. O adapter (`src/statement/inter.ts`) está escrito mas **nunca foi exercitado contra o banco** — trate as formas de resposta como hipótese a conferir.
