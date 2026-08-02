import { createApp, defaultConfig } from '../app.js';

async function main() {
  const config = defaultConfig();
  const app = await createApp(config);
  const recovery = app.repository.recover();
  await app.server.listen({ port: config.port, host: config.host });
  app.server.log.info(
    `contract control center listening on http://${config.host}:${config.port} ` +
      `(db=${config.dbPath}, recovered proposals=${recovery.proposals.length}, events=${recovery.events.length}, lamport=${recovery.lamport})`,
  );

  const shutdown = async () => {
    await app.server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
