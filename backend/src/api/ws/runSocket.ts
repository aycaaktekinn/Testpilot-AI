import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { runManager } from '../runManager.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('runSocket');

/**
 * Canlı run takibi için WebSocket endpoint'i: ws://host/ws/runs/:runId
 * Bağlantı kurulduğu anda o run'a ait tüm gelecek olaylar (step, run_finished, run_error) push edilir.
 */
export function attachRunSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', 'http://localhost');
    const match = url.pathname.match(/^\/ws\/runs\/([a-zA-Z0-9_-]+)$/);

    if (!match || !match[1]) {
      socket.destroy();
      return;
    }
    const runId = match[1];

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleConnection(ws, runId);
    });
  });
}

function handleConnection(ws: WebSocket, runId: string): void {
  let unsubscribe: () => void;
  try {
    unsubscribe = runManager.subscribe(runId, (event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });
  } catch (err) {
    log.warn({ err, runId }, 'WS bağlantısı bilinmeyen run için reddedildi');
    ws.close(4004, 'run bulunamadı');
    return;
  }

  // Bağlanır bağlanmaz mevcut durumu bir kez gönder (bağlantı geç kurulmuş olabilir).
  try {
    const summary = runManager.getSummary(runId);
    ws.send(JSON.stringify({ type: 'run_snapshot', summary }));
  } catch {
    // yok say
  }

  ws.on('close', () => unsubscribe());
  ws.on('error', (err) => log.debug({ err, runId }, 'WS hata'));
}
