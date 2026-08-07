import { loadConfig } from './config';
import { createOmxtermServer } from './server';
import { closeServerWithinDeadline } from './shutdown';

const SHUTDOWN_DEADLINE_MS = 10_000;

const config = loadConfig();
const app = await createOmxtermServer(config);
let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await closeServerWithinDeadline(signal, () => app.close(), {
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    writeError: (message) => process.stderr.write(message),
    forceExit: (code) => process.exit(code),
    markFailure: () => {
      process.exitCode = 1;
    },
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

await app.listen({ host: config.host, port: config.port });
process.stdout.write(
  `OMXTerm Web server listening on http://${config.host}:${config.port}\n`,
);
