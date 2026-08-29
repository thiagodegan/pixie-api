import { config } from "./config.js";
import { buildServer } from "./server.js";
import { createStatementProvider } from "./statement/index.js";
import { startPoller } from "./worker/poller.js";

const app = await buildServer();
const poller = startPoller(app.prisma, createStatementProvider(app.prisma), app.log);

// Encerramento limpo: para o worker antes de fechar o pool do Prisma, senão a
// volta em curso morre com o banco já desconectado.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} recebido, encerrando…`);
    poller.stop();
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.error({ err }, "falha ao subir o servidor");
  process.exit(1);
}
