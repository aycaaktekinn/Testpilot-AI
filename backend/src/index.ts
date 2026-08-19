import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachRunSocket } from './api/ws/runSocket.js';
import { env } from './config/env.js';
import { createLogger } from './config/logger.js';

const log = createLogger('server');

const app = createApp();
const server = createServer(app);
attachRunSocket(server);

server.listen(env.PORT, () => {
  log.info(`AI Playwright Automation backend ${env.PORT} portunda çalışıyor (env=${env.NODE_ENV})`);
});

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Yakalanmamış promise reddi');
});

process.on('SIGTERM', () => {
  log.info('SIGTERM alındı, sunucu kapatılıyor');
  server.close(() => process.exit(0));
});
