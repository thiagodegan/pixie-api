import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { InterStatementProvider } from "./inter.js";
import { SimulatedStatementProvider } from "./simulated.js";
import type { StatementProvider } from "./types.js";

export type { StatementEntry, StatementProvider } from "./types.js";

/** Escolhe o adapter de extrato conforme STATEMENT_PROVIDER. */
export function createStatementProvider(prisma: PrismaClient): StatementProvider {
  return config.STATEMENT_PROVIDER === "inter"
    ? new InterStatementProvider(prisma)
    : new SimulatedStatementProvider(prisma);
}
