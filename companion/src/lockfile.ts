import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);

export interface LcuCredentials {
  port: number;
  password: string;
  protocol: 'https' | 'http';
}

/** Parses `LeagueClient:<pid>:<port>:<password>:<protocol>`. */
export function parseLockfile(contents: string): LcuCredentials {
  const parts = contents.trim().split(':');
  if (parts.length < 5) throw new Error(`Malformed lockfile: ${contents}`);
  const [, , port, password, protocol] = parts;
  return {
    port: Number(port),
    password,
    protocol: protocol === 'http' ? 'http' : 'https',
  };
}

/** Extracts credentials from the LeagueClientUx process command line. */
export function parseCommandLine(cmdline: string): LcuCredentials | null {
  const port = /--app-port=["']?(\d+)/.exec(cmdline)?.[1];
  const password = /--remoting-auth-token=["']?([\w-]+)/.exec(cmdline)?.[1];
  if (!port || !password) return null;
  return { port: Number(port), password, protocol: 'https' };
}

const DEFAULT_LOCKFILES: Record<string, string[]> = {
  win32: [
    'C:\\Riot Games\\League of Legends\\lockfile',
    'D:\\Riot Games\\League of Legends\\lockfile',
  ],
  darwin: ['/Applications/League of Legends.app/Contents/LoL/lockfile'],
  linux: [],
};

async function fromProcessList(): Promise<LcuCredentials | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine",
        ],
        { windowsHide: true, timeout: 5000 },
      );
      return parseCommandLine(stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'args'], { timeout: 5000 });
    const line = stdout.split('\n').find((l) => l.includes('LeagueClientUx'));
    return line ? parseCommandLine(line) : null;
  } catch {
    return null;
  }
}

/**
 * Locates League Client credentials. Order:
 *   1. explicit lockfile path (CLI flag / LCU_LOCKFILE env)
 *   2. the running LeagueClientUx process' command line
 *   3. default install locations
 */
export async function findCredentials(explicitLockfile?: string): Promise<LcuCredentials | null> {
  if (explicitLockfile) {
    try {
      return parseLockfile(await readFile(explicitLockfile, 'utf8'));
    } catch {
      return null;
    }
  }
  const fromProc = await fromProcessList();
  if (fromProc) return fromProc;
  for (const path of DEFAULT_LOCKFILES[os.platform()] ?? []) {
    try {
      return parseLockfile(await readFile(path, 'utf8'));
    } catch {
      /* try next */
    }
  }
  return null;
}
