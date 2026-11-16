import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Bridge } from './bridge.js';
import { normalizeCode } from './config.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

export const COMPANION_VERSION = '0.1.0';

function tokenMatches(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(normalizeCode(expected));
  const b = Buffer.from(normalizeCode(given));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The pairing code is short, so wrong guesses are rate limited per address:
 * after MAX_FAILURES bad codes, that address is locked out for LOCKOUT_MS.
 */
const MAX_FAILURES = 10;
const LOCKOUT_MS = 60_000;

function createGuard(expected: string) {
  const failures = new Map<string, { count: number; until: number }>();
  return (ip: string, given: string | null): 'ok' | 'bad' | 'locked' => {
    const now = Date.now();
    const entry = failures.get(ip);
    if (entry && entry.until < now) failures.delete(ip);
    const current = failures.get(ip);
    if (current && current.count >= MAX_FAILURES) return 'locked';
    if (tokenMatches(expected, given)) {
      failures.delete(ip);
      return 'ok';
    }
    failures.set(ip, { count: (current?.count ?? 0) + 1, until: now + LOCKOUT_MS });
    return 'bad';
  };
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * HTTP + WebSocket server the phone connects to.
 *   GET /health                  -> unauthenticated liveness probe
 *   GET /auth-check?token=       -> 200 if the pairing code is valid, 401 otherwise
 *   GET /icon/:championId?token= -> champion square icon (proxied from the League Client)
 *   WS  /ws?token=               -> live state + commands
 */
export function startServer(bridge: Bridge, opts: { port: number; host: string; token: string }) {
  const iconCache = new Map<number, { type: string; body: Buffer }>();
  const checkToken = createGuard(opts.token);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Allows the app's web build (useful for development) to call the JSON endpoints.
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'lol-champ-select-companion', version: COMPANION_VERSION }));
      return;
    }

    const auth = checkToken(req.socket.remoteAddress ?? '', url.searchParams.get('token'));
    if (auth !== 'ok') {
      res.writeHead(auth === 'locked' ? 429 : 401).end(auth === 'locked' ? 'Too many attempts' : 'Unauthorized');
      return;
    }

    if (url.pathname === '/auth-check') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clientConnected: bridge.client !== null }));
      return;
    }

    const icon = /^\/icon\/(-?\d+)$/.exec(url.pathname);
    if (icon) {
      const id = Number(icon[1]);
      let cached = iconCache.get(id);
      if (!cached) {
        const lcu = bridge.client;
        if (!lcu) {
          res.writeHead(503).end('League Client not connected');
          return;
        }
        try {
          const r = await lcu.requestRaw('GET', `/lol-game-data/assets/v1/champion-icons/${id}.png`);
          if (r.status !== 200) {
            res.writeHead(r.status).end();
            return;
          }
          cached = { type: r.contentType || 'image/png', body: r.body };
          iconCache.set(id, cached);
        } catch {
          res.writeHead(502).end();
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': cached.type, 'Cache-Control': 'public, max-age=86400' });
      res.end(cached.body);
      return;
    }

    res.writeHead(404).end('Not found');
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = url.pathname === '/ws' ? checkToken(req.socket.remoteAddress ?? '', url.searchParams.get('token')) : 'bad';
    if (auth !== 'ok') {
      socket.write(auth === 'locked' ? 'HTTP/1.1 429 Too Many Requests\r\n\r\n' : 'HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    bridge.emit('log', `Phone connected from ${req.socket.remoteAddress}`);
    send(ws, { type: 'hello', companionVersion: COMPANION_VERSION });
    const champions = bridge.getChampions();
    if (champions.length) send(ws, { type: 'champions', champions });
    send(ws, { type: 'state', state: bridge.getState() });

    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const requestId = msg.requestId ?? '';
      try {
        switch (msg.type) {
          case 'hover':
            await bridge.hover(Number(msg.championId));
            break;
          case 'lock':
            await bridge.lock(Number(msg.championId));
            break;
          case 'swap':
            await bridge.swap(msg.kind, Number(msg.swapId), msg.op);
            break;
          case 'benchSwap':
            await bridge.benchSwap(Number(msg.championId));
            break;
          case 'reroll':
            await bridge.reroll();
            break;
          case 'acceptReadyCheck':
            await bridge.acceptReadyCheck();
            break;
          case 'declineReadyCheck':
            await bridge.declineReadyCheck();
            break;
          case 'ping':
            break;
          default:
            throw new Error(`Unknown command ${(msg as { type: string }).type}`);
        }
        send(ws, { type: 'result', requestId, ok: true });
      } catch (err) {
        send(ws, { type: 'result', requestId, ok: false, error: (err as Error).message });
      }
    });

    ws.on('close', () => bridge.emit('log', 'Phone disconnected'));
  });

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
  };
  bridge.on('state', (state) => broadcast({ type: 'state', state }));
  bridge.on('champions', (champions) => broadcast({ type: 'champions', champions }));

  // Keep idle mobile connections alive through NATs / Wi-Fi power saving.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) client.ping();
  }, 15_000);

  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve(server));
    server.on('close', () => clearInterval(heartbeat));
  });
}
