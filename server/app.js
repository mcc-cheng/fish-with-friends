// HTTP + WebSocket transport: serves the client files and feeds messages to Rooms.

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Rooms } from './rooms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const MESSAGES_PER_10S = 80;

async function serveStatic(req, res) {
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(400, 'Bad request');
  }
  if (pathname === '/healthz') return send(200, 'ok');

  // "/" and "/ABCD" (a room link) both load the app.
  let base = PUBLIC;
  let relative = pathname;
  if (pathname === '/' || /^\/[A-Za-z]{4}$/.test(pathname)) relative = '/index.html';
  else if (pathname.startsWith('/shared/')) [base, relative] = [SHARED, pathname.slice('/shared'.length)];
  const file = path.join(base, relative);
  if (!file.startsWith(base + path.sep)) return send(404, 'Not found');
  try {
    send(200, await readFile(file), MIME[path.extname(file)] ?? 'application/octet-stream');
  } catch {
    send(404, 'Not found');
  }
}

export function createApp(options = {}) {
  const rooms = new Rooms(options);
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

  wss.on('connection', (ws) => {
    const conn = {
      send(message) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
    };
    let alive = true;
    let budget = MESSAGES_PER_10S;
    const refill = setInterval(() => {
      budget = MESSAGES_PER_10S;
    }, 10_000);
    // Pings notice dead connections and keep idle ones open through proxies.
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);

    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary || budget-- <= 0) return;
      try {
        rooms.handle(conn, JSON.parse(data.toString()));
      } catch (error) {
        if (!(error instanceof SyntaxError)) console.error(error);
        conn.send({ t: 'error', message: 'Something went wrong with that.' });
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearInterval(refill);
      clearInterval(heartbeat);
      rooms.disconnect(conn);
    });
  });

  return {
    server,
    rooms,
    listen: (port, host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        rooms.close();
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}
