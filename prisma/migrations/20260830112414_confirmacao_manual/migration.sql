-- CreateEnum
CREATE TYPE "ConfirmationSource" AS ENUM ('EXTRATO', 'MANUAL');

-- AlterTable
ALTER TABLE "charges" ADD COLUMN     "confirmationSource" "ConfirmationSource",
ADD COLUMN     "manualConfirmedBy" TEXT,
ADD COLUMN     "manualNote" TEXT;
