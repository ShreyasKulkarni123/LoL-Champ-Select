import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChampSelectView, type LcuSession } from './champSelect.js';
import { parseCommandLine, parseLockfile } from './lockfile.js';

const member = (cellId: number, extra = {}) => ({ cellId, championId: 0, championPickIntent: 0, ...extra });
const action = (id: number, actorCellId: number, type: string, extra = {}) => ({
  id,
  actorCellId,
  type,
  championId: 0,
  completed: false,
  isInProgress: false,
  isAllyAction: actorCellId < 5,
  ...extra,
});

test('derives bans, picks, hovers and the local turn', () => {
  const session: LcuSession = {
    localPlayerCellId: 1,
    myTeam: [member(0, { assignedPosition: 'TOP', gameName: 'Ally' }), member(1, { championPickIntent: 103 })],
    theirTeam: [member(5)],
    actions: [
      [action(1, 0, 'ban', { completed: true, championId: 11 }), action(2, 5, 'ban', { completed: true, championId: 22 })],
      [action(3, 0, 'pick', { completed: true, championId: 86 })],
      [action(4, 1, 'pick', { isInProgress: true, championId: 99 }), action(5, 5, 'pick')],
    ],
    timer: { phase: 'BAN_PICK', adjustedTimeLeftInPhase: 20_000, totalTimeInPhase: 30_000, internalNowInEpoch: 1000 },
  };
  const v = buildChampSelectView(session, { now: 6000 });
  assert.deepEqual(v.myTeamBans, [11]);
  assert.deepEqual(v.theirTeamBans, [22]);
  assert.equal(v.myTeam[0].championId, 86);
  assert.equal(v.myTeam[0].position, 'top');
  assert.equal(v.myTeam[0].name, 'Ally');
  assert.equal(v.myTeam[1].championId, 0);
  assert.equal(v.myTeam[1].hoverChampionId, 99);
  assert.equal(v.myTeam[1].isActing, true);
  assert.deepEqual(v.currentAction, { id: 4, type: 'pick', championId: 99, isInProgress: true });
  assert.equal(v.turnDescription, 'Your turn to pick!');
  assert.equal(v.timeLeftMs, 15_000);
  assert.deepEqual(v.unavailableChampionIds.sort(), [11, 22, 86]);
});

test('falls back to the bans summary and member championId', () => {
  const v = buildChampSelectView({
    localPlayerCellId: 0,
    myTeam: [member(0, { championId: 1 })],
    theirTeam: [member(5, { championId: 2 })],
    actions: [],
    bans: { myTeamBans: [3], theirTeamBans: [4] },
    timer: { phase: 'FINALIZATION' },
  });
  assert.equal(v.myTeam[0].championId, 1);
  assert.equal(v.theirTeam[0].championId, 2);
  assert.deepEqual(v.myTeamBans, [3]);
  assert.deepEqual(v.theirTeamBans, [4]);
  assert.equal(v.currentAction, null);
});

test('parses lockfile and process command line', () => {
  assert.deepEqual(parseLockfile('LeagueClient:1234:54321:abcDEF-123:https\n'), {
    port: 54321,
    password: 'abcDEF-123',
    protocol: 'https',
  });
  assert.deepEqual(
    parseCommandLine('"C:/Riot Games/LeagueClientUx.exe" "--remoting-auth-token=tok_EN-1" "--app-port=50000"'),
    { port: 50000, password: 'tok_EN-1', protocol: 'https' },
  );
});
