import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LcuClient, type LcuEvent } from './lcu.js';
import { findCredentials } from './lockfile.js';
import { buildChampSelectView, type LcuSession } from './champSelect.js';
import type { AppState, ChampionInfo, ReadyCheckView, SwapKind, SwapOperation } from './protocol.js';

const READY_CHECK_DURATION_S = 12;

const SWAP_PATHS: Record<SwapKind, { route: string; field: 'trades' | 'pickOrderSwaps' | 'positionSwaps' }> = {
  pickOrder: { route: 'pick-order-swaps', field: 'pickOrderSwaps' },
  position: { route: 'position-swaps', field: 'positionSwaps' },
  // The session still lists champion trades under `trades`, but the endpoint is `champion-swaps`.
  champion: { route: 'champion-swaps', field: 'trades' },
};
const SWAP_OPS: SwapOperation[] = ['request', 'accept', 'decline', 'cancel'];

interface LcuReadyCheck {
  state: string;
  playerResponse: string;
  timer: number;
}

/**
 * Keeps a live connection to the League Client, maintains an {@link AppState}
 * and exposes the actions the phone can perform.
 *
 * Emits: 'state' (AppState), 'champions' (ChampionInfo[]), 'log' (string).
 */
export class Bridge extends EventEmitter {
  private lcu: LcuClient | null = null;
  private session: LcuSession | null = null;
  private readyCheck: LcuReadyCheck | null = null;
  private gameflowPhase = 'None';
  private summonerName: string | null = null;
  private champions: ChampionInfo[] = [];
  private names = new Map<string, string | null>();
  private pickable: number[] = [];
  private bannable: number[] = [];
  private subset: number[] = [];
  private stopped = false;
  private emitTimer: NodeJS.Timeout | null = null;
  private refreshSeq = 0;
  private readyCheckPoll: NodeJS.Timeout | null = null;

  constructor(private readonly options: { lockfile?: string; pollMs?: number; debug?: boolean } = {}) {
    super();
  }

  get client(): LcuClient | null {
    return this.lcu;
  }

  getChampions(): ChampionInfo[] {
    return this.champions;
  }

  getState(): AppState {
    let readyCheck: ReadyCheckView | null = null;
    if (this.gameflowPhase === 'ReadyCheck') {
      // Some clients never publish ready-check events; the gameflow phase alone is enough to show Accept.
      const rc = this.readyCheck;
      readyCheck = {
        state: rc?.state ?? 'InProgress',
        playerResponse: rc?.playerResponse ?? 'None',
        timeLeftMs: rc ? Math.max(0, (READY_CHECK_DURATION_S - (rc.timer ?? 0)) * 1000) : 0,
      };
    }
    return {
      clientConnected: this.lcu !== null,
      gameflowPhase: this.gameflowPhase,
      summonerName: this.summonerName,
      readyCheck,
      champSelect: this.session
        ? buildChampSelectView(this.session, {
            names: this.names,
            pickableChampionIds: this.pickable,
            bannableChampionIds: this.bannable,
            subsetChampionIds: this.subset,
          })
        : null,
    };
  }

  /** Starts the connect / reconnect loop. Resolves immediately. */
  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.stopReadyCheckPoll();
    this.lcu?.close();
  }

  private log(msg: string) {
    this.emit('log', msg);
  }

  private async loop() {
    let announcedWaiting = false;
    while (!this.stopped) {
      const creds = await findCredentials(this.options.lockfile);
      if (creds) {
        const lcu = new LcuClient(creds);
        try {
          await lcu.connectEvents();
          this.lcu = lcu;
          announcedWaiting = false;
          this.log(`Connected to League Client on port ${creds.port}`);
          await this.onConnected();
          await new Promise<void>((resolve) => lcu.once('close', resolve));
          this.log('League Client connection closed');
        } catch (err) {
          this.log(`Could not connect to League Client: ${(err as Error).message}`);
        }
        this.lcu = null;
        this.stopReadyCheckPoll();
        this.session = null;
        this.readyCheck = null;
        this.gameflowPhase = 'None';
        this.emitState();
      } else if (!announcedWaiting) {
        this.log('Waiting for the League Client to start…');
        announcedWaiting = true;
      }
      await new Promise((r) => setTimeout(r, this.options.pollMs ?? 3000));
    }
  }

  private async onConnected() {
    const lcu = this.lcu!;
    lcu.on('event', (e: LcuEvent) => void this.onEvent(e));

    // The client accepts connections before all plugins are ready; retry the champion list briefly.
    for (let i = 0; i < 10 && this.champions.length === 0; i++) {
      try {
        const summary = await lcu.get<Array<{ id: number; name: string; alias: string }>>(
          '/lol-game-data/assets/v1/champion-summary.json',
        );
        this.champions = summary
          .filter((c) => c.id > 0)
          .map((c) => ({ id: c.id, name: c.name, alias: c.alias }))
          .sort((a, b) => a.name.localeCompare(b.name));
        this.emit('champions', this.champions);
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    try {
      const me = await lcu.get<{ gameName?: string; displayName?: string }>('/lol-summoner/v1/current-summoner');
      this.summonerName = me.gameName || me.displayName || null;
    } catch {
      /* not logged in yet */
    }

    try {
      this.gameflowPhase = await lcu.get<string>('/lol-gameflow/v1/gameflow-phase');
    } catch {
      this.gameflowPhase = 'None';
    }
    await this.fetchReadyCheck();
    this.syncReadyCheckPoll();
    try {
      this.session = await lcu.get<LcuSession>('/lol-champ-select/v1/session');
      await this.refreshChampSelectExtras();
    } catch {
      this.session = null;
    }
    this.emitState();
  }

  private async onEvent(e: LcuEvent) {
    if (this.options.debug) this.log(`event ${e.eventType} ${e.uri}`);
    if (e.uri === '/lol-champ-select/v1/session') {
      this.session = e.eventType === 'Delete' ? null : (e.data as LcuSession);
      if (!this.session) this.subset = [];
      else if (this.options.debug) void this.dumpSession(this.session);
      this.emitState();
      if (this.session) await this.refreshChampSelectExtras();
    } else if (e.uri === '/lol-gameflow/v1/gameflow-phase') {
      this.gameflowPhase = typeof e.data === 'string' ? e.data : 'None';
      this.emitState();
      this.syncReadyCheckPoll();
      // Don't depend on the session event alone either: fetch it as soon as champ select starts.
      if (this.gameflowPhase === 'ChampSelect' && !this.session) {
        try {
          this.session = await this.lcu!.get<LcuSession>('/lol-champ-select/v1/session');
          this.emitState();
          await this.refreshChampSelectExtras();
        } catch {
          /* the session event will follow */
        }
      }
    } else if (e.uri === '/lol-matchmaking/v1/ready-check') {
      this.readyCheck = e.eventType === 'Delete' ? null : (e.data as LcuReadyCheck);
      this.emitState();
    }
  }

  private async fetchReadyCheck() {
    const lcu = this.lcu;
    if (!lcu) return;
    try {
      this.readyCheck = await lcu.get<LcuReadyCheck>('/lol-matchmaking/v1/ready-check');
    } catch {
      this.readyCheck = null;
    }
  }

  /** While a ready check is open, poll it every second (timer and accept state) instead of relying on events. */
  private syncReadyCheckPoll() {
    if (this.gameflowPhase !== 'ReadyCheck') {
      this.stopReadyCheckPoll();
      return;
    }
    if (this.readyCheckPoll) return;
    const tick = async () => {
      await this.fetchReadyCheck();
      this.emitState();
    };
    void tick();
    this.readyCheckPoll = setInterval(() => void tick(), 1000);
  }

  private stopReadyCheckPoll() {
    if (this.readyCheckPoll) clearInterval(this.readyCheckPoll);
    this.readyCheckPoll = null;
  }

  /** Pickable / bannable lists and teammate names change during champ select; refresh them. */
  private async refreshChampSelectExtras() {
    const lcu = this.lcu;
    const session = this.session;
    if (!lcu || !session) return;
    const seq = ++this.refreshSeq;

    const [pickable, bannable, subset] = await Promise.all([
      lcu.get<number[]>('/lol-champ-select/v1/pickable-champion-ids').catch(() => this.pickable),
      lcu.get<number[]>('/lol-champ-select/v1/bannable-champion-ids').catch(() => this.bannable),
      // ARAM champion cards: the champions you are offered to choose from.
      session.allowSubsetChampionPicks
        ? lcu.get<number[]>('/lol-lobby-team-builder/champ-select/v1/subset-champion-list').catch(() => this.subset)
        : Promise.resolve([] as number[]),
    ]);

    const unknown = [...session.myTeam, ...session.theirTeam].filter(
      (m) => m.puuid && !m.gameName && !this.names.has(m.puuid),
    );
    await Promise.all(
      unknown.map(async (m) => {
        try {
          const s = await lcu.get<{ gameName?: string; displayName?: string }>(
            `/lol-summoner/v2/summoners/puuid/${m.puuid}`,
          );
          this.names.set(m.puuid!, s.gameName || s.displayName || null);
        } catch {
          this.names.set(m.puuid!, null);
        }
      }),
    );

    if (seq !== this.refreshSeq) return; // a newer refresh superseded this one
    this.pickable = pickable;
    this.bannable = bannable;
    if (this.options.debug && subset.join() !== this.subset.join()) this.log(`champion cards: ${subset.join(', ')}`);
    this.subset = Array.isArray(subset) ? subset : [];
    this.emitState();
  }

  /** Coalesces bursts of LCU events into a single broadcast. */
  private emitState() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('state', this.getState());
    }, 30);
  }

  /* ----------------------------- actions ----------------------------- */

  private requireLcu(): LcuClient {
    if (!this.lcu) throw new Error('League Client is not connected');
    return this.lcu;
  }

  private requireSession(): LcuSession {
    if (!this.session) throw new Error('Not in champ select');
    return this.session;
  }

  /** Picks the action to operate on: the in-progress one, or (for hovering) the next pick. */
  private targetAction(forLock: boolean) {
    const session = this.requireSession();
    const mine = session.actions.flat().filter((a) => a.actorCellId === session.localPlayerCellId && !a.completed);
    const current = mine.find((a) => a.isInProgress && (a.type === 'pick' || a.type === 'ban'));
    if (current) return current;
    if (forLock) throw new Error("It's not your turn yet");
    const nextPick = mine.find((a) => a.type === 'pick');
    if (!nextPick) throw new Error('You have no pick left to hover');
    return nextPick;
  }

  async hover(championId: number) {
    const action = this.targetAction(false);
    await this.requireLcu().request('PATCH', `/lol-champ-select/v1/session/actions/${action.id}`, { championId });
  }

  async lock(championId: number) {
    const action = this.targetAction(true);
    const lcu = this.requireLcu();
    await lcu.request('PATCH', `/lol-champ-select/v1/session/actions/${action.id}`, { championId, completed: true });
  }

  /** Requests, accepts, declines or cancels a pick order / role / champion swap with a teammate. */
  async swap(kind: SwapKind, swapId: number, op: SwapOperation) {
    const paths = SWAP_PATHS[kind];
    if (!paths) throw new Error(`Unknown swap kind ${kind}`);
    if (!SWAP_OPS.includes(op)) throw new Error(`Unknown swap operation ${op}`);
    const session = this.requireSession();
    const entry = (session[paths.field] ?? []).find((s) => s.id === swapId);
    if (!entry) throw new Error('That swap is no longer available');
    if (!Number.isInteger(swapId)) throw new Error('Invalid swap');
    await this.requireLcu().request('POST', `/lol-champ-select/v1/session/${paths.route}/${swapId}/${op}`);
  }

  /** ARAM: take a champion from the shared bench. */
  async benchSwap(championId: number) {
    const session = this.requireSession();
    if (!session.benchEnabled) throw new Error('This mode has no bench');
    if (!Number.isInteger(championId) || championId <= 0) throw new Error('Invalid champion');
    await this.requireLcu().request('POST', `/lol-champ-select/v1/session/bench/swap/${championId}`);
  }

  /** ARAM (older reroll system): reroll your random champion. */
  async reroll() {
    const session = this.requireSession();
    if (!session.allowRerolling) throw new Error('Rerolling is not available in this mode');
    await this.requireLcu().request('POST', '/lol-champ-select/v1/session/my-selection/reroll');
  }

  /** --debug: keep the latest raw session on disk so unfamiliar modes can be inspected. */
  private async dumpSession(session: LcuSession) {
    try {
      const dir = path.join(process.env.LOLCS_CONFIG_DIR ?? path.join(os.homedir(), '.lol-champ-select'), 'debug');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'champ-select-session.json'), JSON.stringify(session, null, 2));
    } catch {
      /* debugging aid only */
    }
  }

  async acceptReadyCheck() {
    await this.requireLcu().request('POST', '/lol-matchmaking/v1/ready-check/accept');
  }

  async declineReadyCheck() {
    await this.requireLcu().request('POST', '/lol-matchmaking/v1/ready-check/decline');
  }
}
