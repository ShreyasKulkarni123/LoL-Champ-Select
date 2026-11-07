import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { LcuCredentials } from './lockfile.js';

/**
 * The League Client serves its API on 127.0.0.1 with a self-signed Riot certificate.
 * We only ever talk to loopback, so certificate verification is disabled for this agent only.
 */
const insecureLoopbackAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

export class LcuError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RawResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export interface LcuEvent {
  uri: string;
  eventType: 'Create' | 'Update' | 'Delete';
  data: unknown;
}

export const SUBSCRIBED_EVENTS = [
  'OnJsonApiEvent_lol-champ-select_v1_session',
  'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
  'OnJsonApiEvent_lol-matchmaking_v1_ready-check',
];

/**
 * Thin client for the League Client Update (LCU) API.
 * Emits: 'event' (LcuEvent), 'close'.
 */
export class LcuClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly authHeader: string;

  constructor(
    public readonly creds: LcuCredentials,
    private readonly host = '127.0.0.1',
  ) {
    super();
    this.authHeader = 'Basic ' + Buffer.from(`riot:${creds.password}`).toString('base64');
  }

  requestRaw(method: string, path: string, body?: unknown): Promise<RawResponse> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const lib = this.creds.protocol === 'https' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          host: this.host,
          port: this.creds.port,
          path,
          method,
          agent: this.creds.protocol === 'https' ? insecureLoopbackAgent : undefined,
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          },
          timeout: 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error('LCU request timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.requestRaw(method, path, body);
    const text = res.body.toString('utf8');
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = json && typeof json === 'object' && 'message' in json ? String(json.message) : '';
      const message = detail || `LCU ${method} ${path} failed with ${res.status}`;
      throw new LcuError(res.status, message);
    }
    return json as T;
  }

  get<T = unknown>(path: string) {
    return this.request<T>('GET', path);
  }

  /** Opens the WAMP websocket and subscribes to the events we care about. */
  connectEvents(): Promise<void> {
    const scheme = this.creds.protocol === 'https' ? 'wss' : 'ws';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${scheme}://${this.host}:${this.creds.port}/`, 'wamp', {
        headers: { Authorization: this.authHeader },
        rejectUnauthorized: false,
      });
      this.ws = ws;
      ws.once('open', () => {
        for (const name of SUBSCRIBED_EVENTS) ws.send(JSON.stringify([5, name]));
        resolve();
      });
      ws.once('error', (err) => reject(err));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          // WAMP event: [8, "<topic>", { uri, eventType, data }]
          if (Array.isArray(msg) && msg[0] === 8 && msg[2]) this.emit('event', msg[2] as LcuEvent);
        } catch {
          /* ignore non-JSON frames */
        }
      });
      ws.on('close', () => {
        this.ws = null;
        this.emit('close');
      });
    });
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}
