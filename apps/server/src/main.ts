import { loadConfig } from './config';
import { createOmxtermServer } from './server';

const config = loadConfig();
const app = await createOmxtermServer(config);

await app.listen({ host: config.host, port: config.port });
process.stdout.write(`OMXTerm Web server listening on http://${config.host}:${config.port}\n`);
