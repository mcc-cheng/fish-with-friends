// HTTP + WebSocket transport: serves the client files and feeds messages to Rooms.

import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { History } from './history.js';
import { Ratings } from './ratings.js';
import { Rooms } from './rooms.js';
import { RoomStore } from './store.js';

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
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Has the server's own code changed on disk since this process loaded it?
 * The page files are read fresh on every request, so after an update a server
 * that was never restarted ends up serving a new page that expects things the
 * old code can't do. This lets the page say so instead of quietly misbehaving.
 */
const loadedAt = Date.now();
let staleCheck = { at: 0, stale: false };
function codeIsStale() {
  if (Date.now() - staleCheck.at > 3000) {
    const newest = [path.join(ROOT, 'server'), SHARED]
      .flatMap((dir) => readdirSync(dir).map((name) => statSync(path.join(dir, name)).mtimeMs))
      .reduce((a, b) => Math.max(a, b), 0);
    staleCheck = { at: Date.now(), stale: newest > loadedAt };
  }
  return staleCheck.stale;
}

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

  // The lobby, the help and profile pages, "/ABCD" (a room link) and "/game/<id>" (a finished game) all load the app.
  let base = PUBLIC;
  let relative = pathname;
  if (['/', '/help', '/profile'].includes(pathname) || /^\/[BCDFGHJKLMNPQRSTVWXZ]{4}$/i.test(pathname) || /^\/game\/[0-9a-f]{16}$/.test(pathname)) relative = '/index.html';
  else if (pathname.startsWith('/shared/')) [base, relative] = [SHARED, pathname.slice('/shared'.length)];
  const file = path.join(base, relative);
  if (!file.startsWith(base + path.sep)) return send(404, 'Not found');
  try {
    send(200, await readFile(file), MIME[path.extname(file)] ?? 'application/octet-stream');
  } catch {
    send(404, 'Not found');
  }
}

/**
 * @param {object} options  Options for Rooms, plus:
 *   `dataDir`: a folder for what should outlive a restart: Elo ratings (ratings.json),
 *     the list of finished games (games.jsonl), the full record of each (games/<id>.json),
 *     and the rooms open right now, with any game in progress (rooms/<CODE>.json).
 *     Without it they last only as long as the process.
 *   `messagesPer10s`: how many messages one connection may send in ten seconds.
 *     Stepping through bot moves takes one per move, so it has to leave room for quick clicking.
 */
export function createApp({ dataDir = null, messagesPer10s = 200, ...options } = {}) {
  const rooms = new Rooms({
    ratings: new Ratings({ file: dataDir && path.join(dataDir, 'ratings.json') }),
    history: new History({ file: dataDir && path.join(dataDir, 'games.jsonl') }),
    store: dataDir ? new RoomStore({ dir: path.join(dataDir, 'rooms') }) : null,
    stale: codeIsStale,
    ...options,
  });
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

  wss.on('connection', (ws) => {
    const conn = {
      send(message) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
    };
    let alive = true;
    let budget = messagesPer10s;
    const refill = setInterval(() => {
      budget = messagesPer10s;
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
      if (isBinary) return;
      if (budget-- <= 0) {
        // Refuse out loud. A client that hears nothing back would wait for ever on an answer to its click.
        return conn.send({ t: 'error', message: 'You’re going too fast. Give it a few seconds.' });
      }
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
    /** Stops the server once everything it had to save is on disk. */
    close: async () => {
      rooms.close();
      await rooms.saved();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    },
  };
}
