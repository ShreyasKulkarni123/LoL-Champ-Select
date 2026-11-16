import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Pairing {
  host: string;
  port: number;
  token: string;
}

const KEY = 'lolcs.pairing.v1';

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Pairing) : null;
  } catch {
    return null;
  }
}

export async function savePairing(p: Pairing) {
  await AsyncStorage.setItem(KEY, JSON.stringify(p));
}

export async function clearPairing() {
  await AsyncStorage.removeItem(KEY);
}

/** Parses the QR payload printed by the companion: `lolcs://connect?host=..&port=..&token=..`. */
export function parsePairingUrl(data: string): Pairing | null {
  const match = /^lolcs:\/\/connect\?(.*)$/i.exec(data.trim());
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const part of match[1].split('&')) {
    const [k, v = ''] = part.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  const port = Number(params.port);
  if (!params.host || !params.token || !Number.isInteger(port)) return null;
  return { host: params.host, port, token: params.token };
}

export const baseUrl = (p: Pairing) => `http://${p.host}:${p.port}`;
export const iconUrl = (p: Pairing, championId: number) =>
  `${baseUrl(p)}/icon/${championId}?token=${encodeURIComponent(p.token)}`;

/** Pairing codes are case-insensitive and may be typed with spaces or dashes. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export type CheckResult = 'ok' | 'bad-token' | 'locked' | 'unreachable';

/** Verifies that the companion is reachable and the pairing code is right. */
export async function checkPairing(p: Pairing): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${baseUrl(p)}/auth-check?token=${encodeURIComponent(p.token)}`, {
      signal: controller.signal,
    });
    if (res.status === 401) return 'bad-token';
    if (res.status === 429) return 'locked';
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timeout);
  }
}
