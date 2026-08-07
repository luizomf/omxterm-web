import { loadConfig } from './config';
import { createOmxtermServer } from './server';

const SHUTDOWN_DEADLINE_MS = 10_000;

const config = loadConfig();
const app = await createOmxtermServer(config);
let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const forceExit = setTimeout(() => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'shutdown_timeout', signal })}\n`,
    );
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  forceExit.unref();

  try {
    await app.close();
    clearTimeout(forceExit);
  } catch (error) {
    clearTimeout(forceExit);
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        msg: 'shutdown_failed',
        signal,
        error: error instanceof Error ? error.message : 'unknown_error',
      })}\n`,
    );
    process.exitCode = 1;
  }
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
