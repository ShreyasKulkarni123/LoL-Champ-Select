import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from './bridge.js';
import { startServer } from './server.js';

test('pairing code is case-insensitive and wrong guesses are rate limited', async () => {
  const bridge = new Bridge();
  const server = await startServer(bridge, { port: 0, host: '127.0.0.1', token: 'K7MQ4P' });
  const port = (server.address() as { port: number }).port;
  const check = (code: string) => fetch(`http://127.0.0.1:${port}/auth-check?token=${code}`).then((r) => r.status);
  try {
    assert.equal(await check('K7MQ4P'), 200);
    assert.equal(await check('k7m-q4p'), 200);
    for (let i = 0; i < 10; i++) assert.equal(await check('WRONG1'), 401);
    // Locked out, even with the right code, until the lockout expires.
    assert.equal(await check('K7MQ4P'), 429);
  } finally {
    server.close();
  }
});
