-- CreateEnum
CREATE TYPE "PixKeyType" AS ENUM ('CNPJ', 'CPF', 'EMAIL', 'TELEFONE', 'ALEATORIA');

-- CreateEnum
CREATE TYPE "PdvStatus" AS ENUM ('ATIVO', 'PENDENTE', 'INATIVO');

-- CreateEnum
CREATE TYPE "CertificateKind" AS ENUM ('CRT', 'KEY');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('AGUARDANDO', 'PAGO', 'EXPIRADO', 'CANCELADO', 'REVISAO');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "pixKeyType" "PixKeyType" NOT NULL DEFAULT 'CNPJ',
    "pixKey" TEXT,
    "statementCursor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "kind" "CertificateKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "cipherText" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pdvs" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "accessCodeEnc" BYTEA NOT NULL,
    "accessCodeIv" BYTEA NOT NULL,
    "accessCodeTag" BYTEA NOT NULL,
    "accessCodeLookup" TEXT NOT NULL,
    "status" "PdvStatus" NOT NULL DEFAULT 'PENDENTE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pdvs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charges" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "pdvId" UUID NOT NULL,
    "txid" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "ChargeStatus" NOT NULL DEFAULT 'AGUARDANDO',
    "pixPayload" TEXT NOT NULL,
    "payerName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "matchedTransactionId" UUID,

    CONSTRAINT "charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "payerName" TEXT,
    "payerDocument" TEXT,
    "rawDescription" TEXT NOT NULL,
    "extractedTxid" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_logs" (
    "id" SERIAL NOT NULL,
    "accountId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,

    CONSTRAINT "connection_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polling_runs" (
    "id" SERIAL NOT NULL,
    "accountId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "ingested" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "polling_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulated_payments" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "txid" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "payerName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulated_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "certificates_accountId_kind_key" ON "certificates"("accountId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "pdvs_accessCodeLookup_key" ON "pdvs"("accessCodeLookup");

-- CreateIndex
CREATE UNIQUE INDEX "pdvs_accountId_prefix_key" ON "pdvs"("accountId", "prefix");

-- CreateIndex
CREATE UNIQUE INDEX "charges_txid_key" ON "charges"("txid");

-- CreateIndex
CREATE UNIQUE INDEX "charges_matchedTransactionId_key" ON "charges"("matchedTransactionId");

-- CreateIndex
CREATE INDEX "charges_pdvId_status_idx" ON "charges"("pdvId", "status");

-- CreateIndex
CREATE INDEX "charges_accountId_createdAt_idx" ON "charges"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "charges_status_expiresAt_idx" ON "charges"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "bank_transactions_accountId_occurredAt_idx" ON "bank_transactions"("accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "bank_transactions_extractedTxid_idx" ON "bank_transactions"("extractedTxid");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_accountId_externalId_key" ON "bank_transactions"("accountId", "externalId");

-- CreateIndex
CREATE INDEX "connection_logs_accountId_at_idx" ON "connection_logs"("accountId", "at");

-- CreateIndex
CREATE INDEX "polling_runs_accountId_startedAt_idx" ON "polling_runs"("accountId", "startedAt");

-- CreateIndex
CREATE INDEX "simulated_payments_accountId_availableAt_idx" ON "simulated_payments"("accountId", "availableAt");

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pdvs" ADD CONSTRAINT "pdvs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_pdvId_fkey" FOREIGN KEY ("pdvId") REFERENCES "pdvs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_matchedTransactionId_fkey" FOREIGN KEY ("matchedTransactionId") REFERENCES "bank_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_logs" ADD CONSTRAINT "connection_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polling_runs" ADD CONSTRAINT "polling_runs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulated_payments" ADD CONSTRAINT "simulated_payments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
