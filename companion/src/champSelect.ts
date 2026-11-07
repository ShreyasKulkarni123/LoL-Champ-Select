import type { ChampSelectView, MyAction, PlayerSlot, Position } from './protocol.js';

/* Subset of the raw `/lol-champ-select/v1/session` payload that we use. */

export interface LcuMember {
  cellId: number;
  championId: number;
  championPickIntent: number;
  summonerId?: number;
  puuid?: string;
  gameName?: string;
  tagLine?: string;
  assignedPosition?: string;
  spell1Id?: number;
  spell2Id?: number;
  team?: number;
}

export interface LcuAction {
  id: number;
  actorCellId: number;
  championId: number;
  completed: boolean;
  isAllyAction: boolean;
  isInProgress: boolean;
  type: string; // 'pick' | 'ban' | 'ten_bans_reveal' | ...
}

export interface LcuSession {
  localPlayerCellId: number;
  isSpectating?: boolean;
  myTeam: LcuMember[];
  theirTeam: LcuMember[];
  actions: LcuAction[][];
  bans?: { myTeamBans?: number[]; theirTeamBans?: number[] };
  timer?: {
    phase?: string;
    adjustedTimeLeftInPhase?: number;
    totalTimeInPhase?: number;
    internalNowInEpoch?: number;
    isInfinite?: boolean;
  };
}

export interface ViewExtras {
  /** Resolved display names keyed by puuid. */
  names?: Map<string, string | null>;
  pickableChampionIds?: number[];
  bannableChampionIds?: number[];
  now?: number;
}

const POSITIONS: Position[] = ['top', 'jungle', 'middle', 'bottom', 'utility'];

function normalizePosition(p: string | undefined): Position {
  const v = (p ?? '').toLowerCase();
  return (POSITIONS as string[]).includes(v) ? (v as Position) : '';
}

function toMyAction(a: LcuAction): MyAction {
  return { id: a.id, type: a.type === 'ban' ? 'ban' : 'pick', championId: a.championId, isInProgress: a.isInProgress };
}

export function buildChampSelectView(session: LcuSession, extras: ViewExtras = {}): ChampSelectView {
  const now = extras.now ?? Date.now();
  const actions = (session.actions ?? []).flat();
  const myCells = new Set(session.myTeam.map((m) => m.cellId));
  const local = session.localPlayerCellId;

  const actionsBy = (cellId: number, type: string) => actions.filter((a) => a.actorCellId === cellId && a.type === type);
  const inProgress = actions.filter((a) => a.isInProgress && !a.completed);

  const slot = (m: LcuMember): PlayerSlot => {
    const picks = actionsBy(m.cellId, 'pick');
    const completedPick = picks.find((a) => a.completed && a.championId > 0);
    const openPick = picks.find((a) => !a.completed && a.championId > 0);

    // When there are no pick actions for the actor (blind pick summary, FINALIZATION in
    // some queues, spectating) fall back to the member's championId.
    const championId = completedPick?.championId ?? (picks.length === 0 ? m.championId : 0);
    const hover = championId ? 0 : (openPick?.championId ?? (m.championPickIntent || 0));

    let name: string | null = null;
    if (m.gameName) name = m.gameName;
    else if (m.puuid && extras.names?.has(m.puuid)) name = extras.names.get(m.puuid) ?? null;

    return {
      cellId: m.cellId,
      name,
      position: normalizePosition(m.assignedPosition),
      championId,
      hoverChampionId: hover,
      isLocalPlayer: m.cellId === local,
      isActing: inProgress.some((a) => a.actorCellId === m.cellId),
      spell1Id: m.spell1Id ?? 0,
      spell2Id: m.spell2Id ?? 0,
    };
  };

  // Bans: derive from completed ban actions; fall back to the `bans` summary if actions are absent.
  const completedBans = actions.filter((a) => a.type === 'ban' && a.completed && a.championId > 0);
  let myTeamBans = completedBans.filter((a) => myCells.has(a.actorCellId)).map((a) => a.championId);
  let theirTeamBans = completedBans.filter((a) => !myCells.has(a.actorCellId)).map((a) => a.championId);
  if (myTeamBans.length === 0) myTeamBans = (session.bans?.myTeamBans ?? []).filter((c) => c > 0);
  if (theirTeamBans.length === 0) theirTeamBans = (session.bans?.theirTeamBans ?? []).filter((c) => c > 0);

  const myTeam = session.myTeam.map(slot);
  const theirTeam = session.theirTeam.map(slot);

  const mine = actions.filter((a) => a.actorCellId === local);
  const current = mine.find((a) => a.isInProgress && !a.completed && (a.type === 'pick' || a.type === 'ban'));
  const nextPick = mine.find((a) => a.type === 'pick' && !a.completed);

  const unavailable = new Set<number>([
    ...myTeamBans,
    ...theirTeamBans,
    ...myTeam.map((p) => p.championId),
    ...theirTeam.map((p) => p.championId),
  ]);
  unavailable.delete(0);

  const timer = session.timer ?? {};
  const phase = timer.phase ?? 'UNKNOWN';
  let timeLeftMs = timer.adjustedTimeLeftInPhase ?? 0;
  if (timer.internalNowInEpoch) timeLeftMs -= now - timer.internalNowInEpoch;
  if (timer.isInfinite) timeLeftMs = 0;

  return {
    phase,
    timeLeftMs: Math.max(0, Math.round(timeLeftMs)),
    totalTimeMs: timer.totalTimeInPhase ?? 0,
    myTeam,
    theirTeam,
    myTeamBans,
    theirTeamBans,
    currentAction: current ? toMyAction(current) : null,
    nextPickAction: nextPick ? toMyAction(nextPick) : null,
    pickableChampionIds: extras.pickableChampionIds ?? [],
    bannableChampionIds: extras.bannableChampionIds ?? [],
    unavailableChampionIds: [...unavailable],
    isSpectating: Boolean(session.isSpectating),
    activeActionType: inProgress.some((a) => a.type === 'ban')
      ? 'ban'
      : inProgress.some((a) => a.type === 'pick')
        ? 'pick'
        : null,
    turnDescription: describeTurn(phase, inProgress, local, myCells),
  };
}

function describeTurn(phase: string, inProgress: LcuAction[], local: number, myCells: Set<number>): string {
  switch (phase) {
    case 'PLANNING':
      return 'Declare your champion';
    case 'FINALIZATION':
      return 'Finalizing loadouts';
    case 'GAME_STARTING':
      return 'Game starting';
  }
  if (inProgress.length === 0) return 'Waiting…';
  const kind = inProgress[0].type === 'ban' ? 'ban' : 'pick';
  if (inProgress.some((a) => a.actorCellId === local)) return `Your turn to ${kind}!`;
  const ally = inProgress.some((a) => myCells.has(a.actorCellId));
  if (kind === 'ban') return ally ? 'Your team is banning' : 'Enemy team is banning';
  return ally ? 'Your team is picking' : 'Enemy team is picking';
}
