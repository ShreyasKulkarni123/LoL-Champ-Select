/**
 * Wire protocol between the desktop companion and the mobile app.
 *
 * NOTE: this file is mirrored in `mobile/src/protocol.ts`. Keep them in sync.
 */

export type Position = 'top' | 'jungle' | 'middle' | 'bottom' | 'utility' | '';

export interface ChampionInfo {
  id: number;
  name: string;
  alias: string;
}

export interface PlayerSlot {
  cellId: number;
  /** Display name, or null if hidden (e.g. enemy team in ranked). */
  name: string | null;
  position: Position;
  /** Locked-in champion (0 = none). */
  championId: number;
  /** Champion currently hovered / intended (0 = none). */
  hoverChampionId: number;
  isLocalPlayer: boolean;
  /** True if this player currently has an in-progress action. */
  isActing: boolean;
  spell1Id: number;
  spell2Id: number;
}

export type ActionType = 'pick' | 'ban';

export interface MyAction {
  id: number;
  type: ActionType;
  /** Champion currently set on the action (hover). */
  championId: number;
  isInProgress: boolean;
}

export type ChampSelectPhase = 'PLANNING' | 'BAN_PICK' | 'FINALIZATION' | 'GAME_STARTING' | string;

export interface ChampSelectView {
  phase: ChampSelectPhase;
  /** Milliseconds left in the current phase at the moment this view was produced. */
  timeLeftMs: number;
  totalTimeMs: number;
  myTeam: PlayerSlot[];
  theirTeam: PlayerSlot[];
  myTeamBans: number[];
  theirTeamBans: number[];
  /** The local player's current (in-progress) action, if it's their turn. */
  currentAction: MyAction | null;
  /** The local player's next pick action, even if not active (used for pre-hovering). */
  nextPickAction: MyAction | null;
  /** Champions the local player may pick right now (owned + free rotation, minus unavailable). */
  pickableChampionIds: number[];
  bannableChampionIds: number[];
  /** Champions already picked or banned by anyone (cannot be chosen). */
  unavailableChampionIds: number[];
  isSpectating: boolean;
  /** Type of the action(s) currently in progress, if any. */
  activeActionType: ActionType | null;
  /** Short human-readable description of whose turn it is. */
  turnDescription: string;
}

export interface ReadyCheckView {
  state: string; // 'InProgress' | 'EveryoneReady' | 'StrangerNotReady' | ...
  playerResponse: 'None' | 'Accepted' | 'Declined' | string;
  timeLeftMs: number;
}

export interface AppState {
  /** Whether the companion is connected to the League Client. */
  clientConnected: boolean;
  /** e.g. 'None' | 'Lobby' | 'Matchmaking' | 'ReadyCheck' | 'ChampSelect' | 'InProgress' ... */
  gameflowPhase: string;
  summonerName: string | null;
  readyCheck: ReadyCheckView | null;
  champSelect: ChampSelectView | null;
}

/** Messages sent from the companion to the phone. */
export type ServerMessage =
  | { type: 'hello'; companionVersion: string }
  | { type: 'state'; state: AppState }
  | { type: 'champions'; champions: ChampionInfo[] }
  | { type: 'result'; requestId: string; ok: boolean; error?: string };

/** Messages sent from the phone to the companion. */
export type ClientMessage =
  | { type: 'hover'; requestId: string; championId: number }
  | { type: 'lock'; requestId: string; championId: number }
  | { type: 'acceptReadyCheck'; requestId: string }
  | { type: 'declineReadyCheck'; requestId: string }
  | { type: 'ping'; requestId: string };
