import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { MockLeagueClient } from './mock/mockClient.js';
import { Bridge } from './bridge.js';
import { startServer } from './server.js';
import type { AppState, ServerMessage } from './protocol.js';

test('phone can follow a full draft and lock in through the companion', { timeout: 60_000 }, async () => {
  const mock = new MockLeagueClient({ speed: 10, champSelectOnly: true });
  const lcuPort = await mock.listen();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lolcs-test-'));
  const lockfile = path.join(dir, 'lockfile');
  await writeFile(lockfile, `LeagueClient:1:${lcuPort}:${mock.password}:http`);

  const bridge = new Bridge({ lockfile, pollMs: 100 });
  const server = await startServer(bridge, { port: 0, host: '127.0.0.1', token: 'secret' });
  bridge.start();
  const port = (server.address() as { port: number }).port;

  // Wrong token is rejected.
  const bad = new WebSocket(`ws://127.0.0.1:${port}/ws?token=nope`);
  await new Promise<void>((resolve) => bad.on('error', () => resolve()));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`);
  let state: AppState | null = null;
  let champions = 0;
  const results = new Map<string, (r: { ok: boolean; error?: string }) => void>();
  const waiters: Array<() => void> = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    if (msg.type === 'state') state = msg.state;
    if (msg.type === 'champions') champions = msg.champions.length;
    if (msg.type === 'result') results.get(msg.requestId)?.(msg);
    waiters.splice(0).forEach((w) => w());
  });
  const until = async (pred: (s: AppState) => boolean) => {
    while (!state || !pred(state)) await new Promise<void>((r) => waiters.push(r));
    return state;
  };
  let n = 0;
  const call = (msg: object) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const requestId = String(++n);
      results.set(requestId, resolve);
      ws.send(JSON.stringify({ ...msg, requestId }));
    });

  try {
    const first = await until((s) => s.clientConnected && s.champSelect !== null);
    assert.equal(first.gameflowPhase, 'ChampSelect');
    assert.ok(champions > 100, 'champion list delivered');
    assert.equal(first.champSelect!.myTeam.length, 5);

    // Planning: pre-hover a pick.
    const pickable = (await until((s) => s.champSelect!.pickableChampionIds.length > 0)).champSelect!.pickableChampionIds;
    const target = pickable[0];
    assert.deepEqual(await call({ type: 'hover', championId: target }), { type: 'result', requestId: '1', ok: true });
    const me = (s: AppState) => s.champSelect!.myTeam.find((p) => p.isLocalPlayer)!;
    await until((s) => me(s).hoverChampionId === target);

    // Locking outside your turn fails cleanly.
    const early = await call({ type: 'lock', championId: target });
    assert.equal(early.ok, false);

    // Ban turn: lock a ban.
    const banTurn = await until((s) => s.champSelect!.currentAction?.type === 'ban');
    const banId = banTurn.champSelect!.bannableChampionIds.find((id) => id !== target)!;
    assert.equal((await call({ type: 'lock', championId: banId })).ok, true);
    await until((s) => s.champSelect!.myTeamBans.includes(banId));

    // Enemy bans are revealed once the ban phase ends.
    await until((s) => s.champSelect!.theirTeamBans.length === 5);

    // Pick turn: lock our hovered champion (if a bot didn't steal it, take any pickable one).
    const pickTurn = await until((s) => s.champSelect!.currentAction?.type === 'pick');
    const choice = pickTurn.champSelect!.pickableChampionIds.includes(target)
      ? target
      : pickTurn.champSelect!.pickableChampionIds[0];
    const locked = await call({ type: 'lock', championId: choice });
    assert.equal(locked.ok, true, locked.error ?? "");
    await until((s) => me(s).championId === choice);

    const done = await until((s) => s.champSelect!.phase === 'FINALIZATION');
    assert.ok(done.champSelect!.myTeam.every((p) => p.championId > 0));
    assert.ok(done.champSelect!.theirTeam.every((p) => p.championId > 0));

    // Icons are proxied (and require the token).
    const icon = await fetch(`http://127.0.0.1:${port}/icon/${choice}?token=secret`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`http://127.0.0.1:${port}/icon/${choice}`)).status, 401);
  } finally {
    ws.close();
    bridge.stop();
    server.close();
    mock.close();
  }
});
