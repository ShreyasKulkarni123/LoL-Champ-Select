import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MockLeagueClient } from './mockClient.js';
import { runCompanion } from '../index.js';

const { values } = parseArgs({
  options: {
    'with-companion': { type: 'boolean' },
    'champ-select-only': { type: 'boolean' },
    speed: { type: 'string' },
    port: { type: 'string' },
  },
});

const mock = new MockLeagueClient({
  speed: values.speed ? Number(values.speed) : 1,
  champSelectOnly: values['champ-select-only'],
});
const lcuPort = await mock.listen(values.port ? Number(values.port) : 0);

const dir = path.join(os.tmpdir(), 'lolcs-mock');
await mkdir(dir, { recursive: true });
const lockfile = path.join(dir, 'lockfile');
await writeFile(lockfile, `LeagueClient:${process.pid}:${lcuPort}:${mock.password}:http`);

console.log(`[mock] Fake League Client listening on 127.0.0.1:${lcuPort}`);
console.log(`[mock] Lockfile written to ${lockfile}`);

if (values['with-companion']) {
  await runCompanion({ lockfile });
} else {
  console.log(`[mock] Start the companion with:  npm start -- --lockfile "${lockfile}"`);
}

process.on('SIGINT', () => {
  mock.close();
  process.exit(0);
});
