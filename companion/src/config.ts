import { randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface CompanionConfig {
  token: string;
  port: number;
}

const CONFIG_DIR = process.env.LOLCS_CONFIG_DIR ?? path.join(os.homedir(), '.lol-champ-select');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** No 0/O, 1/I/L: easy to read off the screen and type on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

function newToken() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Pairing codes are case-insensitive and may be typed with spaces or dashes. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Loads (or creates) the persisted pairing token so the phone only needs to pair once. */
export async function loadConfig(opts: { resetToken?: boolean } = {}): Promise<CompanionConfig> {
  let cfg: Partial<CompanionConfig> = {};
  try {
    cfg = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    /* first run */
  }
  const full: CompanionConfig = {
    // Older versions used a long code; replace it with a short one.
    token: !opts.resetToken && cfg.token && CODE_PATTERN.test(cfg.token) ? cfg.token : newToken(),
    port: cfg.port ?? 8787,
  };
  if (full.token !== cfg.token || full.port !== cfg.port) {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(full, null, 2), { mode: 0o600 });
  }
  return full;
}

export function configPath() {
  return CONFIG_FILE;
}

/** Non-internal IPv4 addresses, most likely LAN address first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Skip common virtual adapters (WSL, Hyper-V, Docker, VirtualBox).
      if (/vEthernet|docker|vbox|virtualbox|vmnet|br-/i.test(name)) continue;
      out.push(a.address);
    }
  }
  const score = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('100.') ? 3 : 2);
  return out.sort((a, b) => score(a) - score(b));
}
