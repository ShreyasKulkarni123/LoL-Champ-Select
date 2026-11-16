import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { MockLeagueClient } from './mock/mockClient.js';
import { Bridge } from './bridge.js';
import { startServer } from './server.js';
import type { AppState, ChampSelectView, ServerMessage, SwapKind, SwapOperation } from './protocol.js';

/** Mock client + companion + a websocket "phone". */
async function harness(mockOpts: ConstructorParameters<typeof MockLeagueClient>[0]) {
  const mock = new MockLeagueClient({ champSelectOnly: true, ...mockOpts });
  const lcuPort = await mock.listen();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lolcs-test-'));
  const lockfile = path.join(dir, 'lockfile');
  await writeFile(lockfile, `LeagueClient:1:${lcuPort}:${mock.password}:http`);
  const bridge = new Bridge({ lockfile, pollMs: 100 });
  const server = await startServer(bridge, { port: 0, host: '127.0.0.1', token: 't' });
  bridge.start();
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=t`);

  let state: AppState | null = null;
  const results = new Map<string, (r: { ok: boolean; error?: string }) => void>();
  const waiters: Array<() => void> = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    if (msg.type === 'state') state = msg.state;
    if (msg.type === 'result') results.get(msg.requestId)?.(msg);
    waiters.splice(0).forEach((w) => w());
  });

  const until = async (pred: (v: ChampSelectView) => boolean): Promise<ChampSelectView> => {
    while (!state?.champSelect || !pred(state.champSelect)) await new Promise<void>((r) => waiters.push(r));
    return state.champSelect;
  };
  let n = 0;
  const swap = (kind: SwapKind, swapId: number, op: SwapOperation) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const requestId = String(++n);
      results.set(requestId, resolve);
      ws.send(JSON.stringify({ type: 'swap', kind, swapId, op, requestId }));
    });
  const call = (msg: object) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const requestId = String(++n);
      results.set(requestId, resolve);
      ws.send(JSON.stringify({ ...msg, requestId }));
    });
  const close = () => {
    ws.close();
    bridge.stop();
    server.close();
    mock.close();
  };
  return { until, swap, call, close };
}

const me = (v: ChampSelectView) => v.myTeam.find((p) => p.isLocalPlayer)!;
const cell = (v: ChampSelectView, cellId: number) => v.myTeam.find((p) => p.cellId === cellId)!;
const available = (v: ChampSelectView, kind: SwapKind) => v.swaps.find((s) => s.kind === kind && s.state === 'AVAILABLE');

test('request role, pick order and champion swaps with teammates', { timeout: 90_000 }, async () => {
  const h = await harness({ speed: 5, botSwapRequests: false, botAcceptRate: 1 });
  try {
    // Role swap (planning only).
    let v = await h.until((x) => x.phase === 'PLANNING' && !!available(x, 'position'));
    const pos = available(v, 'position')!;
    const theirRole = cell(v, pos.cellId).position;
    const myRole = me(v).position;
    assert.equal((await h.swap('position', pos.id, 'request')).ok, true);
    v = await h.until((x) => me(x).position === theirRole);
    assert.equal(cell(v, pos.cellId).position, myRole);

    // Only one swap can be pending at a time; a stale/unknown id is rejected by the companion.
    assert.equal((await h.swap('position', 99999, 'request')).ok, false);

    // Pick order swap (before either of us is picking).
    v = await h.until((x) => !!available(x, 'pickOrder'));
    const order = available(v, 'pickOrder')!;
    const theirOrder = cell(v, order.cellId).pickOrder;
    const myOrder = me(v).pickOrder;
    assert.notEqual(theirOrder, myOrder);
    assert.equal((await h.swap('pickOrder', order.id, 'request')).ok, true);
    v = await h.until((x) => me(x).pickOrder === theirOrder);
    assert.equal(cell(v, order.cellId).pickOrder, myOrder);

    // Champion trade (both locked in). Our own pick times out to a random champion in the mock.
    v = await h.until((x) => me(x).championId > 0 && !!available(x, 'champion'));
    const trade = available(v, 'champion')!;
    const theirChamp = cell(v, trade.cellId).championId;
    const myChamp = me(v).championId;
    assert.equal((await h.swap('champion', trade.id, 'request')).ok, true);
    v = await h.until((x) => me(x).championId === theirChamp);
    assert.equal(cell(v, trade.cellId).championId, myChamp);
  } finally {
    h.close();
  }
});

test('accept a swap request sent by a teammate', { timeout: 30_000 }, async () => {
  const h = await harness({ speed: 5, botSwapRequests: true });
  try {
    const v = await h.until((x) => x.swaps.some((s) => s.state === 'RECEIVED'));
    const incoming = v.swaps.find((s) => s.state === 'RECEIVED')!;
    assert.equal(incoming.kind, 'position');
    // Everything else is BUSY while a request is pending.
    assert.ok(v.swaps.filter((s) => s !== incoming).every((s) => s.state === 'BUSY'));
    const theirRole = cell(v, incoming.cellId).position;
    assert.equal((await h.swap('position', incoming.id, 'accept')).ok, true);
    const after = await h.until((x) => me(x).position === theirRole);
    assert.ok(after.swaps.every((s) => s.state !== 'RECEIVED'));
  } finally {
    h.close();
  }
});

test('ARAM: choose a champion card, swap with the bench, trade with a teammate', { timeout: 60_000 }, async () => {
  const h = await harness({ speed: 4, mode: 'aram', botSwapRequests: false, botAcceptRate: 1 });
  try {
    // Your two cards are offered; bans are absent.
    let v = await h.until((x) => x.choiceChampionIds.length === 2 && x.currentAction?.type === 'pick');
    assert.equal(v.benchEnabled, true);
    assert.deepEqual([...v.myTeamBans, ...v.theirTeamBans], []);
    const [, second] = v.choiceChampionIds;

    // Only your cards can be locked.
    const notACard = v.pickableChampionIds.find((id) => !v.choiceChampionIds.includes(id))!;
    assert.equal((await h.call({ type: 'lock', championId: notACard })).ok, false);
    assert.equal((await h.call({ type: 'lock', championId: second })).ok, true);
    v = await h.until((x) => me(x).championId === second);

    // Once allies have picked, their other cards are on the bench; take one.
    v = await h.until((x) => x.benchChampionIds.length >= 2);
    const fromBench = v.benchChampionIds[0];
    assert.equal((await h.call({ type: 'benchSwap', championId: fromBench })).ok, true);
    v = await h.until((x) => me(x).championId === fromBench);
    assert.ok(v.benchChampionIds.includes(second), 'your old champion goes back to the bench');

    // Champion trades go through the champion-swaps endpoint.
    v = await h.until((x) => !!available(x, 'champion'));
    const trade = available(v, 'champion')!;
    const theirChamp = cell(v, trade.cellId).championId;
    const res = await h.swap('champion', trade.id, 'request');
    assert.equal(res.ok, true, res.error ?? '');
    v = await h.until((x) => me(x).championId === theirChamp);
    assert.equal(cell(v, trade.cellId).championId, fromBench);
  } finally {
    h.close();
  }
});
