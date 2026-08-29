// ---------------------------------------------------------------------------
// Seed de desenvolvimento: uma conta e um PDV para destravar o primeiro login.
//
// Deliberadamente NÃO recria os PDVs do mock antigo ("Caixa Balcão" 482913
// etc.). O código de acesso agora é aleatório e sai impresso abaixo — se um
// código antigo hardcoded ainda funcionasse, seria impossível saber se a tela
// está lendo o banco ou o mock.
// ---------------------------------------------------------------------------

import { hash } from "@node-rs/argon2";
import { PrismaClient } from "@prisma/client";
import { lookupHash, openText, seal } from "../src/lib/crypto.js";
import { generateAccessCode, prefixFrom } from "../src/lib/ids.js";

const prisma = new PrismaClient();

const EMAIL = process.env.SEED_EMAIL ?? "dono@pixie.local";
const PASSWORD = process.env.SEED_PASSWORD ?? "pixie123456";
const PDV_NAME = process.env.SEED_PDV_NAME ?? "Caixa Balcão";

async function main() {
  const account = await prisma.account.upsert({
    where: { email: EMAIL },
    update: {},
    create: {
      name: "Mercearia do Bairro",
      email: EMAIL,
      passwordHash: await hash(PASSWORD),
      pixKeyType: "CNPJ",
      pixKey: "12345678000190",
    },
  });

  const existing = await prisma.pdv.findFirst({
    where: { accountId: account.id, name: PDV_NAME },
  });

  let accessCode: string;

  if (existing) {
    accessCode = openText({
      cipherText: existing.accessCodeEnc,
      iv: existing.accessCodeIv,
      authTag: existing.accessCodeTag,
    });
  } else {
    accessCode = generateAccessCode();
    const sealed = seal(accessCode);
    await prisma.pdv.create({
      data: {
        accountId: account.id,
        name: PDV_NAME,
        prefix: prefixFrom(PDV_NAME),
        accessCodeEnc: sealed.cipherText,
        accessCodeIv: sealed.iv,
        accessCodeTag: sealed.authTag,
        accessCodeLookup: lookupHash(accessCode),
        status: "ATIVO",
      },
    });
  }

  console.log(`
  Seed concluído.

    Painel do dono   http://localhost:5173
      e-mail         ${EMAIL}
      senha          ${PASSWORD}

    PDV do vendedor  http://localhost:5174
      PDV            ${PDV_NAME}
      código         ${accessCode}
  `);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
