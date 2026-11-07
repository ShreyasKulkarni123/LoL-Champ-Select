/**
 * A fake League Client (LCU) for developing / demoing without the game running.
 *
 * It implements just enough of the LCU REST + WAMP websocket API for the companion:
 * lobby -> matchmaking -> ready check -> ranked-style draft champ select -> game -> lobby (repeat).
 * Bots take every action except the local player's, which waits for the phone.
 */
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { FALLBACK_CHAMPIONS } from './champions.js';
import { placeholderIcon } from './png.js';
import type { LcuAction, LcuMember, LcuSession } from '../champSelect.js';

const CDRAGON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1';
const POSITIONS = ['top', 'jungle', 'middle', 'bottom', 'utility'];
const ALLY_NAMES = ['Baron Bait', 'Ward Bot 3000', 'FlashOnD', 'Gank Plz', 'Minion Enjoyer'];

type Champion = { id: number; name: string; alias: string };

interface MockOptions {
  /** >1 makes every timer faster. */
  speed?: number;
  /** Stay in champ select forever (no ready check, no game). Useful for UI work. */
  champSelectOnly?: boolean;
  /** Probability a bot teammate accepts your swap request (default 0.75). */
  botAcceptRate?: number;
  /** Whether bot teammates send you swap requests themselves (default true). */
  botSwapRequests?: boolean;
}

type SwapKind = 'pickOrder' | 'position' | 'champion';
const SWAP_ROUTES: Record<string, SwapKind> = {
  'pick-order-swaps': 'pickOrder',
  'position-swaps': 'position',
  trades: 'champion',
};
/** Swap ids are `base + teammate cellId`, one per (kind, teammate) like the real client. */
const SWAP_ID_BASE: Record<SwapKind, number> = { pickOrder: 100, position: 200, champion: 300 };
const SWAP_FIELDS = { pickOrder: 'pickOrderSwaps', position: 'positionSwaps', champion: 'trades' } as const;

interface PendingSwap {
  kind: SwapKind;
  from: number;
  to: number;
}

export class MockLeagueClient {
  private champions: Champion[] = FALLBACK_CHAMPIONS;
  private cdragonAvailable = true;
  private iconCache = new Map<number, Buffer>();
  private sockets = new Map<WebSocket, Set<string>>();
  private timers = new Set<NodeJS.Timeout>();
  private speed: number;

  phase = 'Lobby';
  readyCheck: { state: string; playerResponse: string; timer: number } | null = null;
  session: (LcuSession & { timer: NonNullable<LcuSession['timer']> }) | null = null;
  private phaseEndsAt = 0;
  private groupIndex = -1;
  private localTimeout: NodeJS.Timeout | null = null;
  private pendingSwap: PendingSwap | null = null;
  private ownedChampions = new Set<number>();
  readonly server: http.Server;
  readonly password = 'mock-password';

  constructor(private readonly opts: MockOptions = {}) {
    this.speed = opts.speed ?? 1;
    this.server = http.createServer((req, res) => void this.handle(req, res));
    const wss = new WebSocketServer({ server: this.server });
    wss.on('connection', (ws) => {
      const topics = new Set<string>();
      this.sockets.set(ws, topics);
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (Array.isArray(msg) && msg[0] === 5) topics.add(msg[1]);
        } catch {
          /* ignore */
        }
      });
      ws.on('close', () => this.sockets.delete(ws));
    });
  }

  async listen(port = 0): Promise<number> {
    await this.loadChampions();
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    const addr = this.server.address();
    if (this.opts.champSelectOnly) this.startChampSelect();
    else this.later(() => this.setPhase('Matchmaking'), 2000).then(() => this.queue());
    return typeof addr === 'object' && addr ? addr.port : port;
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    if (this.localTimeout) clearTimeout(this.localTimeout);
    for (const ws of this.sockets.keys()) ws.terminate();
    this.server.close();
  }

  /* ----------------------------- assets ----------------------------- */

  private async loadChampions() {
    try {
      const res = await fetch(`${CDRAGON}/champion-summary.json`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(String(res.status));
      const list = (await res.json()) as Champion[];
      this.champions = list.filter((c) => c.id > 0);
    } catch {
      this.cdragonAvailable = false;
    }
    // Own ~75% of the roster so the "unlocked champions" filter is visible.
    for (const c of this.champions) if ((c.id * 7) % 4 !== 0) this.ownedChampions.add(c.id);
  }

  private async icon(id: number): Promise<Buffer> {
    const cached = this.iconCache.get(id);
    if (cached) return cached;
    let png: Buffer | null = null;
    if (this.cdragonAvailable) {
      try {
        const res = await fetch(`${CDRAGON}/champion-icons/${id}.png`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) png = Buffer.from(await res.arrayBuffer());
      } catch {
        this.cdragonAvailable = false;
      }
    }
    png ??= placeholderIcon(id);
    this.iconCache.set(id, png);
    return png;
  }

  /* ------------------------------ events ------------------------------ */

  private publish(uri: string, eventType: 'Create' | 'Update' | 'Delete', data: unknown) {
    const topic = 'OnJsonApiEvent_' + uri.slice(1).replace(/\//g, '_');
    const frame = JSON.stringify([8, topic, { uri, eventType, data }]);
    for (const [ws, topics] of this.sockets) {
      if ((topics.has(topic) || topics.has('OnJsonApiEvent')) && ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  }

  private setPhase(phase: string) {
    this.phase = phase;
    this.publish('/lol-gameflow/v1/gameflow-phase', 'Update', phase);
  }

  private later(fn: () => void, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        fn();
        resolve();
      }, ms / this.speed);
      this.timers.add(t);
    });
  }

  /* ----------------------------- gameflow ----------------------------- */

  private async queue() {
    await this.later(() => {}, 4000);
    this.readyCheck = { state: 'InProgress', playerResponse: 'None', timer: 0 };
    this.setPhase('ReadyCheck');
    this.publish('/lol-matchmaking/v1/ready-check', 'Create', this.readyCheck);
    for (let s = 1; s <= 12; s++) {
      await this.later(() => {}, 1000);
      if (!this.readyCheck || this.readyCheck.playerResponse !== 'None') return;
      this.readyCheck.timer = s;
      this.publish('/lol-matchmaking/v1/ready-check', 'Update', this.readyCheck);
    }
    // Timed out: back to queue.
    this.endReadyCheck();
    this.setPhase('Matchmaking');
    void this.queue();
  }

  private endReadyCheck() {
    this.readyCheck = null;
    this.publish('/lol-matchmaking/v1/ready-check', 'Delete', null);
  }

  private respondReadyCheck(accept: boolean) {
    if (!this.readyCheck) throw new HttpError(404, 'No ready check in progress');
    this.readyCheck.playerResponse = accept ? 'Accepted' : 'Declined';
    this.readyCheck.state = accept ? 'EveryoneReady' : 'PartyNotReady';
    this.publish('/lol-matchmaking/v1/ready-check', 'Update', this.readyCheck);
    void this.later(() => {
      this.endReadyCheck();
      if (accept) this.startChampSelect();
      else this.setPhase('Lobby');
    }, 1000);
    if (!accept) void this.later(() => this.setPhase('Matchmaking'), 5000).then(() => this.queue());
  }

  /* --------------------------- champ select --------------------------- */

  private startChampSelect() {
    const localCell = Math.floor(Math.random() * 5);
    const member = (cellId: number): LcuMember => {
      const ally = cellId < 5;
      return {
        cellId,
        championId: 0,
        championPickIntent: 0,
        summonerId: ally ? 1000 + cellId : 0,
        puuid: ally ? `mock-puuid-${cellId}` : '',
        gameName: ally ? (cellId === localCell ? 'You (Mock)' : ALLY_NAMES[cellId]) : '',
        tagLine: ally ? 'MOCK' : '',
        assignedPosition: POSITIONS[cellId % 5],
        spell1Id: 4,
        spell2Id: cellId % 5 === 1 ? 11 : 14,
        team: ally ? 1 : 2,
      };
    };
    let id = 1;
    const act = (actorCellId: number, type: string): LcuAction => ({
      id: id++,
      actorCellId,
      championId: 0,
      completed: false,
      isAllyAction: actorCellId < 5,
      isInProgress: false,
      type,
    });
    const actions: LcuAction[][] = [
      Array.from({ length: 10 }, (_, i) => act(i, 'ban')),
      [act(-1, 'ten_bans_reveal')],
      [act(0, 'pick')],
      [act(5, 'pick'), act(6, 'pick')],
      [act(1, 'pick'), act(2, 'pick')],
      [act(7, 'pick'), act(8, 'pick')],
      [act(3, 'pick'), act(4, 'pick')],
      [act(9, 'pick')],
    ];
    this.session = {
      localPlayerCellId: localCell,
      isSpectating: false,
      myTeam: [0, 1, 2, 3, 4].map(member),
      theirTeam: [5, 6, 7, 8, 9].map(member),
      actions,
      bans: { myTeamBans: [], theirTeamBans: [] },
      timer: { phase: 'PLANNING', adjustedTimeLeftInPhase: 0, totalTimeInPhase: 0, internalNowInEpoch: 0 },
    };
    this.groupIndex = -1;
    this.pendingSwap = null;
    this.setPhase('ChampSelect');
    this.setTimer('PLANNING', 15000);
    this.publish('/lol-champ-select/v1/session', 'Create', this.publicSession());

    // Allies declare intents during planning.
    for (const m of this.session.myTeam) {
      if (m.cellId === localCell) continue;
      void this.later(() => {
        if (this.session?.timer.phase !== 'PLANNING') return;
        m.championPickIntent = this.randomChampion();
        const pick = this.session.actions.flat().find((a) => a.actorCellId === m.cellId && a.type === 'pick');
        if (pick) pick.championId = m.championPickIntent;
        this.update();
      }, 1500 + Math.random() * 8000);
    }
    void this.later(() => this.nextGroup(), 15000);

    // A teammate asks to swap roles during planning.
    void this.later(() => this.botRequestSwap('position'), 4000);
  }

  private setTimer(phase: string, ms: number) {
    if (!this.session) return;
    this.phaseEndsAt = Date.now() + ms / this.speed;
    this.session.timer = {
      phase,
      adjustedTimeLeftInPhase: ms / this.speed,
      totalTimeInPhase: ms / this.speed,
      internalNowInEpoch: Date.now(),
      isInfinite: false,
    };
  }

  private update() {
    if (!this.session) return;
    // Pending swaps that are no longer possible (e.g. a pick turn started) are dropped.
    const p = this.pendingSwap;
    if (p && !this.swapAvailable(p.kind, p.from, p.to)) this.pendingSwap = null;
    this.session.timer.adjustedTimeLeftInPhase = Math.max(0, this.phaseEndsAt - Date.now());
    this.session.timer.internalNowInEpoch = Date.now();
    this.publish('/lol-champ-select/v1/session', 'Update', this.publicSession());
  }

  /** What the client would actually reveal: enemy hovers and unrevealed enemy bans are hidden. */
  publicSession(): LcuSession | null {
    if (!this.session) return null;
    const s: LcuSession = structuredClone(this.session);
    const revealed = s.actions[1]?.[0]?.completed ?? false;
    for (const a of s.actions.flat()) {
      if (a.isAllyAction) continue;
      if (!a.completed || (a.type === 'ban' && !revealed)) a.championId = 0;
    }
    for (const m of s.theirTeam) {
      const pick = s.actions.flat().find((a) => a.actorCellId === m.cellId && a.type === 'pick');
      m.championId = pick?.completed ? pick.championId : 0;
    }
    const local = s.localPlayerCellId;
    for (const kind of Object.keys(SWAP_FIELDS) as SwapKind[]) {
      s[SWAP_FIELDS[kind]] = s.myTeam
        .filter((m) => m.cellId !== local)
        .map((m) => ({ id: SWAP_ID_BASE[kind] + m.cellId, cellId: m.cellId, state: this.swapState(kind, m.cellId) }));
    }
    return s;
  }

  /* ------------------------------ swaps ------------------------------- */

  private member(cellId: number) {
    return this.session?.myTeam.find((m) => m.cellId === cellId);
  }

  private picksOf(cellId: number) {
    return (this.session?.actions.flat() ?? []).filter((a) => a.type === 'pick' && a.actorCellId === cellId);
  }

  /** Mirrors the real client's rules for when each swap is offered. */
  private swapAvailable(kind: SwapKind, a: number, b: number): boolean {
    const session = this.session;
    const ma = this.member(a);
    const mb = this.member(b);
    if (!session || !ma || !mb || a === b) return false;
    const phase = session.timer.phase;
    if (kind === 'position') return phase === 'PLANNING' && ma.assignedPosition !== mb.assignedPosition;
    const pa = this.picksOf(a)[0];
    const pb = this.picksOf(b)[0];
    if (!pa || !pb) return false;
    if (kind === 'pickOrder') {
      return (phase === 'PLANNING' || phase === 'BAN_PICK') && [pa, pb].every((x) => !x.completed && !x.isInProgress);
    }
    return (
      (phase === 'BAN_PICK' || phase === 'FINALIZATION') && pa.completed && pb.completed && pa.championId !== pb.championId
    );
  }

  private swapState(kind: SwapKind, cell: number): string {
    const local = this.session!.localPlayerCellId;
    const p = this.pendingSwap;
    if (p) {
      if (p.kind === kind && p.from === local && p.to === cell) return 'SENT';
      if (p.kind === kind && p.from === cell && p.to === local) return 'RECEIVED';
      return 'BUSY';
    }
    return this.swapAvailable(kind, local, cell) ? 'AVAILABLE' : 'INVALID';
  }

  private applySwap(kind: SwapKind, a: number, b: number) {
    const ma = this.member(a)!;
    const mb = this.member(b)!;
    if (kind === 'position') {
      [ma.assignedPosition, mb.assignedPosition] = [mb.assignedPosition, ma.assignedPosition];
    } else if (kind === 'pickOrder') {
      // Exchange turns; each player keeps their hover, so the champions move with them.
      const pa = this.picksOf(a).find((x) => !x.completed)!;
      const pb = this.picksOf(b).find((x) => !x.completed)!;
      [pa.actorCellId, pb.actorCellId] = [b, a];
      [pa.championId, pb.championId] = [pb.championId, pa.championId];
    } else {
      const pa = this.picksOf(a).find((x) => x.completed)!;
      const pb = this.picksOf(b).find((x) => x.completed)!;
      [pa.championId, pb.championId] = [pb.championId, pa.championId];
      [ma.championId, mb.championId] = [mb.championId, ma.championId];
    }
  }

  /** A random teammate asks the local player for a swap; withdrawn if ignored. */
  private botRequestSwap(kind: SwapKind) {
    const session = this.session;
    if (!session || this.opts.botSwapRequests === false || this.pendingSwap) return;
    const local = session.localPlayerCellId;
    const candidates = session.myTeam.filter((m) => m.cellId !== local && this.swapAvailable(kind, m.cellId, local));
    if (!candidates.length) return;
    const from = candidates[Math.floor(Math.random() * candidates.length)].cellId;
    const pending: PendingSwap = { kind, from, to: local };
    this.pendingSwap = pending;
    this.update();
    void this.later(() => {
      if (this.pendingSwap === pending) {
        this.pendingSwap = null;
        this.update();
      }
    }, 12000);
  }

  private handleSwap(kind: SwapKind, id: number, op: string) {
    const session = this.session;
    if (!session) throw new HttpError(404, 'No active delegate');
    const cell = id - SWAP_ID_BASE[kind];
    const local = session.localPlayerCellId;
    if (cell === local || !this.member(cell)) throw new HttpError(404, `Swap ${id} not found`);
    const p = this.pendingSwap;

    switch (op) {
      case 'request': {
        if (p) throw new HttpError(400, 'Another swap is already in progress');
        if (!this.swapAvailable(kind, local, cell)) throw new HttpError(400, 'Swap is not available');
        const pending: PendingSwap = { kind, from: local, to: cell };
        this.pendingSwap = pending;
        void this.later(() => {
          if (this.pendingSwap !== pending) return;
          this.pendingSwap = null;
          if (Math.random() < (this.opts.botAcceptRate ?? 0.75)) this.applySwap(kind, local, cell);
          this.update();
        }, 1500 + Math.random() * 1500);
        break;
      }
      case 'accept':
      case 'decline':
        if (!p || p.kind !== kind || p.from !== cell || p.to !== local) throw new HttpError(400, 'No such request');
        this.pendingSwap = null;
        if (op === 'accept') this.applySwap(kind, cell, local);
        break;
      case 'cancel':
        if (!p || p.kind !== kind || p.from !== local || p.to !== cell) throw new HttpError(400, 'No such request');
        this.pendingSwap = null;
        break;
      default:
        throw new HttpError(404, `Unknown swap operation ${op}`);
    }
    this.update();
  }

  private unavailable(): Set<number> {
    const set = new Set<number>();
    for (const a of this.session?.actions.flat() ?? []) {
      if (a.completed && a.championId > 0 && (a.type === 'ban' || a.type === 'pick')) set.add(a.championId);
    }
    return set;
  }

  pickable(): number[] {
    const taken = this.unavailable();
    return [...this.ownedChampions].filter((id) => !taken.has(id));
  }

  bannable(): number[] {
    const taken = this.unavailable();
    return this.champions.map((c) => c.id).filter((id) => !taken.has(id));
  }

  private randomChampion(): number {
    const taken = this.unavailable();
    for (const a of this.session?.actions.flat() ?? []) if (a.championId) taken.add(a.championId);
    const free = this.champions.filter((c) => !taken.has(c.id));
    return free[Math.floor(Math.random() * free.length)].id;
  }

  private nextGroup() {
    const session = this.session;
    if (!session) return;
    if (this.localTimeout) clearTimeout(this.localTimeout);
    this.groupIndex++;
    const group = session.actions[this.groupIndex];

    if (!group) {
      this.setTimer('FINALIZATION', 20000);
      this.update();
      void this.later(() => this.botRequestSwap('champion'), 3000);
      void this.later(() => {
        this.setTimer('GAME_STARTING', 3000);
        this.update();
      }, 20000).then(() => this.later(() => this.startGame(), 3000));
      return;
    }

    const isReveal = group[0].type === 'ten_bans_reveal';
    const duration = isReveal ? 3000 : 30000;
    this.setTimer('BAN_PICK', duration);
    for (const a of group) a.isInProgress = true;
    this.update();

    if (isReveal) {
      void this.later(() => this.completeAction(group[0], 0), 3000);
      return;
    }

    for (const a of group) {
      if (a.actorCellId === session.localPlayerCellId) continue;
      const ally = a.isAllyAction;
      // Allies who declared an intent usually stick with it.
      const intent = a.type === 'pick' && a.championId && !this.unavailable().has(a.championId) ? a.championId : 0;
      const choice = intent || this.randomChampion();
      void this.later(() => {
        if (a.completed) return;
        a.championId = choice; // hover (only visible for allies)
        if (ally && a.type === 'pick') session.myTeam.find((m) => m.cellId === a.actorCellId)!.championId = choice;
        this.update();
      }, 1000 + Math.random() * 3000);
      void this.later(() => {
        if (!a.completed) this.completeAction(a, this.unavailable().has(choice) ? this.randomChampion() : choice);
      }, 4500 + Math.random() * 4000);
    }

    // If the phone never answers, the real client would dodge; the mock just picks something.
    const local = group.find((a) => a.actorCellId === session.localPlayerCellId);
    if (local) {
      this.localTimeout = setTimeout(() => {
        this.localTimeout = null;
        if (!local.completed) this.completeAction(local, local.championId || (local.type === 'ban' ? 0 : this.randomChampion()));
      }, duration / this.speed);
    }
  }

  private completeAction(a: LcuAction, championId: number) {
    const session = this.session;
    if (!session || a.completed) return;
    a.championId = championId;
    a.completed = true;
    a.isInProgress = false;
    if (a.type === 'pick') {
      const m = [...session.myTeam, ...session.theirTeam].find((x) => x.cellId === a.actorCellId);
      if (m) m.championId = championId;
    }
    if (a.type === 'ban' || a.type === 'ten_bans_reveal') {
      const bans = session.actions[0].filter((b) => b.completed && b.championId > 0);
      const revealed = session.actions[1][0].completed;
      session.bans = {
        myTeamBans: bans.filter((b) => b.isAllyAction).map((b) => b.championId),
        theirTeamBans: revealed ? bans.filter((b) => !b.isAllyAction).map((b) => b.championId) : [],
      };
    }
    const group = session.actions[this.groupIndex];
    if (group?.every((x) => x.completed)) this.nextGroup();
    else this.update();
  }

  private startGame() {
    this.session = null;
    this.pendingSwap = null;
    this.publish('/lol-champ-select/v1/session', 'Delete', null);
    this.setPhase('InProgress');
    void this.later(() => this.setPhase('EndOfGame'), 15000)
      .then(() => this.later(() => this.setPhase('Lobby'), 3000))
      .then(() => this.later(() => this.setPhase('Matchmaking'), 3000))
      .then(() => this.queue());
  }

  /** Handles PATCH /lol-champ-select/v1/session/actions/:id from the companion. */
  private patchAction(id: number, body: { championId?: number; completed?: boolean }) {
    const session = this.session;
    if (!session) throw new HttpError(404, 'No active delegate');
    const a = session.actions.flat().find((x) => x.id === id);
    if (!a) throw new HttpError(404, `Action ${id} not found`);
    if (a.actorCellId !== session.localPlayerCellId) throw new HttpError(400, 'Not your action');
    if (a.completed) throw new HttpError(400, 'Action already completed');
    const championId = body.championId ?? a.championId;
    if (championId) {
      const allowed = a.type === 'ban' ? this.bannable() : this.pickable();
      if (!allowed.includes(championId)) throw new HttpError(400, 'Champion is not available');
    }
    if (body.completed) {
      if (!a.isInProgress) throw new HttpError(400, 'Action is not in progress');
      this.completeAction(a, championId);
      return;
    }
    a.championId = championId;
    const me = session.myTeam.find((m) => m.cellId === a.actorCellId)!;
    if (a.type === 'pick') {
      me.championPickIntent = a.isInProgress ? me.championPickIntent : championId;
      if (a.isInProgress) me.championId = championId;
    }
    this.update();
  }

  /* ------------------------------- HTTP ------------------------------- */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const expected = 'Basic ' + Buffer.from(`riot:${this.password}`).toString('base64');
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const body = await readBody(req);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };

    try {
      const icon = /^\/lol-game-data\/assets\/v1\/champion-icons\/(-?\d+)\.png$/.exec(path);
      if (req.method === 'GET' && icon) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(await this.icon(Number(icon[1])));
        return;
      }
      const swap = /^\/lol-champ-select\/v1\/session\/(trades|pick-order-swaps|position-swaps)\/(\d+)\/(\w+)$/.exec(path);
      if (req.method === 'POST' && swap) {
        this.handleSwap(SWAP_ROUTES[swap[1]], Number(swap[2]), swap[3]);
        res.writeHead(204).end();
        return;
      }
      const action = /^\/lol-champ-select\/v1\/session\/actions\/(\d+)$/.exec(path);
      if (req.method === 'PATCH' && action) {
        this.patchAction(Number(action[1]), body ?? {});
        res.writeHead(204).end();
        return;
      }
      const summoner = /^\/lol-summoner\/v2\/summoners\/puuid\/(.+)$/.exec(path);
      if (req.method === 'GET' && summoner) {
        const m = this.session?.myTeam.find((x) => x.puuid === summoner[1]);
        if (!m) throw new HttpError(404, 'Summoner not found');
        return json(200, { gameName: m.gameName, tagLine: m.tagLine });
      }

      switch (`${req.method} ${path}`) {
        case 'GET /lol-game-data/assets/v1/champion-summary.json':
          return json(200, [{ id: -1, name: 'None', alias: 'None' }, ...this.champions]);
        case 'GET /lol-summoner/v1/current-summoner':
          return json(200, { gameName: 'You (Mock)', tagLine: 'MOCK' });
        case 'GET /lol-gameflow/v1/gameflow-phase':
          return json(200, this.phase);
        case 'GET /lol-matchmaking/v1/ready-check':
          if (!this.readyCheck) throw new HttpError(404, 'Not in ready check');
          return json(200, this.readyCheck);
        case 'POST /lol-matchmaking/v1/ready-check/accept':
          this.respondReadyCheck(true);
          return json(204, undefined);
        case 'POST /lol-matchmaking/v1/ready-check/decline':
          this.respondReadyCheck(false);
          return json(204, undefined);
        case 'GET /lol-champ-select/v1/session': {
          if (!this.session) throw new HttpError(404, 'No active delegate');
          this.session.timer.adjustedTimeLeftInPhase = Math.max(0, this.phaseEndsAt - Date.now());
          this.session.timer.internalNowInEpoch = Date.now();
          return json(200, this.publicSession());
        }
        case 'GET /lol-champ-select/v1/pickable-champion-ids':
          if (!this.session) throw new HttpError(404, 'No active delegate');
          return json(200, this.pickable());
        case 'GET /lol-champ-select/v1/bannable-champion-ids':
          if (!this.session) throw new HttpError(404, 'No active delegate');
          return json(200, this.bannable());
      }
      throw new HttpError(404, `Mock does not implement ${req.method} ${path}`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      json(status, { errorCode: 'RPC_ERROR', httpStatus: status, message: (err as Error).message });
    }
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}
