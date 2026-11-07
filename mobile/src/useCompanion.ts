import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState as RNAppState } from 'react-native';
import type { AppState, ChampionInfo, ClientMessage, ServerMessage } from './protocol';
import type { Pairing } from './pairing';

export type LinkStatus = 'connecting' | 'open' | 'closed';

export interface CommandResult {
  ok: boolean;
  error?: string;
}

export type Command = ClientMessage extends infer M ? (M extends { requestId: string } ? Omit<M, 'requestId'> : never) : never;

const COMMAND_TIMEOUT_MS = 8000;

/**
 * Maintains a websocket to the desktop companion, reconnecting automatically
 * (including when the app returns to the foreground).
 */
export function useCompanion(pairing: Pairing | null) {
  const [status, setStatus] = useState<LinkStatus>('connecting');
  const [state, setState] = useState<AppState | null>(null);
  /** Device time at which `state` was received; used to count timers down locally. */
  const [receivedAt, setReceivedAt] = useState(0);
  const [champions, setChampions] = useState<ChampionInfo[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, (r: CommandResult) => void>());
  const seq = useRef(0);

  useEffect(() => {
    if (!pairing) return;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      wsRef.current?.close();
      setStatus('connecting');
      const ws = new WebSocket(
        `ws://${pairing.host}:${pairing.port}/ws?token=${encodeURIComponent(pairing.token)}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus('open');
      };
      ws.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.type === 'state') {
          setState(msg.state);
          setReceivedAt(Date.now());
        } else if (msg.type === 'champions') {
          setChampions(msg.champions);
        } else if (msg.type === 'result') {
          pending.current.get(msg.requestId)?.({ ok: msg.ok, error: msg.error });
          pending.current.delete(msg.requestId);
        }
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        setStatus('closed');
        for (const resolve of pending.current.values()) resolve({ ok: false, error: 'Connection lost' });
        pending.current.clear();
        if (!disposed) {
          const delay = Math.min(5000, 500 * 2 ** attempt++);
          retryTimer = setTimeout(connect, delay);
        }
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    };

    connect();

    // Mobile OSes kill sockets in the background; reconnect immediately on resume.
    const sub = RNAppState.addEventListener('change', (s) => {
      if (s === 'active' && wsRef.current?.readyState !== WebSocket.OPEN) {
        if (retryTimer) clearTimeout(retryTimer);
        attempt = 0;
        connect();
      }
    });

    return () => {
      disposed = true;
      sub.remove();
      if (retryTimer) clearTimeout(retryTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [pairing?.host, pairing?.port, pairing?.token]);

  const send = useCallback((cmd: Command): Promise<CommandResult> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: 'Not connected to your computer' });
    }
    const requestId = String(++seq.current);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.current.delete(requestId);
        resolve({ ok: false, error: 'Timed out' });
      }, COMMAND_TIMEOUT_MS);
      pending.current.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      ws.send(JSON.stringify({ ...cmd, requestId }));
    });
  }, []);

  return { status, state, receivedAt, champions, send };
}

/** Counts a server-provided duration down on the device. */
export function useCountdown(timeLeftMs: number, receivedAt: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, timeLeftMs - (now - receivedAt));
}
