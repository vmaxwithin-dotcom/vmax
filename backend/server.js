import http from 'node:http';
import { loadConfig } from './lib/config.js';
import { createTokenProvider, loadServiceAccount } from './lib/google-auth.js';
import { createVertexClient } from './lib/vertex.js';
import { createApp } from './lib/app.js';
import { createOpenAIClient } from './lib/openai.js';

function main() {
  const config = loadConfig();
  let vertexClient;
  const vertex = async request => {
    if (!vertexClient) {
      const account = loadServiceAccount(config);
      config.project ||= account.project_id || '';
      if (!config.project) throw new Error('Missing Google project');
      vertexClient = createVertexClient({ config, getAccessToken:createTokenProvider(account) });
    }
    return vertexClient(request);
  };
  const openai = createOpenAIClient({ config });
  const app = createApp({ config, vertex, openai });

  const server = http.createServer(app);
  server.requestTimeout = 300_000;
  server.headersTimeout = 15_000;

  server.listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({
      level: 'info',
      message: 'st-vertex-polish backend listening',
      port: config.port,
      project: config.project,
      location: config.location,
      model: config.model,
    }));
  });

  const shutdown = signal => {
    console.log(JSON.stringify({ level: 'info', message: 'shutting down', signal }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (error) {
  // Never log raw startup exceptions: credential parsers may include secrets.
  console.error(JSON.stringify({ level: 'error', code: 'startup_failed', message: 'Backend configuration or service-account initialization failed; check environment and mounted secret.' }));
  process.exit(1);
}
