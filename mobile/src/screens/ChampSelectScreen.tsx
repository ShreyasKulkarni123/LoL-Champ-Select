import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import type { ChampionInfo, ChampSelectView, PlayerSlot } from '../protocol';
import type { Pairing } from '../pairing';
import { ChampIcon } from '../components/ChampIcon';
import { useCountdown, type Command, type CommandResult } from '../useCompanion';
import { colors, POSITION_LABEL, POSITION_SHORT } from '../theme';
import { SwapBanner, SwapSheet } from '../components/Swaps';

interface Props {
  pairing: Pairing;
  view: ChampSelectView;
  receivedAt: number;
  champions: ChampionInfo[];
  send: (cmd: Command) => Promise<CommandResult>;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function ChampSelectScreen({ pairing, view, receivedAt, champions, send }: Props) {
  const { width } = useWindowDimensions();
  const left = useCountdown(view.timeLeftMs, receivedAt);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Teammate whose swap sheet is open. */
  const [sheetCell, setSheetCell] = useState<number | null>(null);

  const me = view.myTeam.find((p) => p.isLocalPlayer);
  const action = view.currentAction;
  const mode: 'ban' | 'pick' = action?.type === 'ban' ? 'ban' : 'pick';
  const lockedChampion = me?.championId ?? 0;
  const byId = useMemo(() => new Map(champions.map((c) => [c.id, c])), [champions]);

  // Per teammate: is a swap possible ('available') or in flight ('pending')?
  const swapHints = useMemo(() => {
    const hints = new Map<number, 'available' | 'pending'>();
    for (const s of view.swaps) {
      if (s.state === 'SENT' || s.state === 'RECEIVED') hints.set(s.cellId, 'pending');
      else if (s.state === 'AVAILABLE' && !hints.has(s.cellId)) hints.set(s.cellId, 'available');
    }
    return hints;
  }, [view.swaps]);
  const openSheet = useMemo(() => (cellId: number) => setSheetCell(cellId), []);

  // Buzz when it becomes your turn.
  const lastActionId = useRef<number | null>(null);
  useEffect(() => {
    const id = action?.id ?? null;
    if (id !== null && id !== lastActionId.current) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
    lastActionId.current = id;
  }, [action?.id]);

  // When switching between ban and pick turns, start from whatever is hovered on the server.
  const actionKey = `${action?.id ?? 'none'}-${mode}`;
  useEffect(() => {
    const serverHover = action?.championId || (mode === 'pick' ? me?.hoverChampionId : 0) || 0;
    setSelected(serverHover || null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionKey]);

  const unavailable = useMemo(() => new Set(view.unavailableChampionIds), [view.unavailableChampionIds]);
  const allowedIds = mode === 'ban' ? view.bannableChampionIds : view.pickableChampionIds;

  const grid = useMemo(() => {
    const allowed = new Set(allowedIds);
    const q = normalize(query);
    return champions.filter(
      (c) =>
        (allowed.size === 0 || allowed.has(c.id)) &&
        !unavailable.has(c.id) &&
        (!q || normalize(c.name).includes(q) || normalize(c.alias).includes(q)),
    );
  }, [champions, allowedIds, unavailable, query]);

  const canHover = !lockedChampion && (action !== null || view.nextPickAction !== null) && !view.isSpectating;
  const selectionValid = selected !== null && !unavailable.has(selected);

  const choose = async (championId: number) => {
    if (!canHover) return;
    setSelected(championId);
    setError(null);
    void Haptics.selectionAsync().catch(() => {});
    const r = await send({ type: 'hover', championId });
    if (!r.ok) setError(r.error ?? 'Could not hover champion');
  };

  const lock = async () => {
    if (!action || selected === null) return;
    setBusy(true);
    setError(null);
    const r = await send({ type: 'lock', championId: selected });
    setBusy(false);
    if (r.ok) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    else setError(r.error ?? 'Could not lock in');
  };

  const columns = Math.max(4, Math.floor((width - 24) / 62));
  const tile = Math.floor((width - 24) / columns);
  const myTurn = action !== null;
  // 10 ban slots + label must fit on one row, even on small phones.
  const banSize = Math.min(28, Math.floor((width - 24 - 44) / 10) - 3);
  const actingLabel = view.activeActionType === 'ban' ? 'Banning…' : 'Picking…';
  const progress = view.totalTimeMs > 0 ? Math.min(1, left / view.totalTimeMs) : 0;
  const selectedName = selected ? (byId.get(selected)?.name ?? '') : '';

  let buttonLabel: string;
  let buttonEnabled = false;
  if (view.isSpectating) buttonLabel = 'Spectating';
  else if (action) {
    buttonEnabled = selectionValid && !busy;
    buttonLabel = selected
      ? `${mode === 'ban' ? 'BAN' : 'LOCK IN'} ${selectedName.toUpperCase()}`
      : mode === 'ban'
        ? 'Choose a champion to ban'
        : 'Choose your champion';
  } else if (lockedChampion) buttonLabel = `Locked in: ${byId.get(lockedChampion)?.name ?? ''}`;
  else if (view.nextPickAction) buttonLabel = selected ? `Hovering ${selectedName} — not your turn yet` : 'Tap a champion to hover it';
  else buttonLabel = 'Waiting…';

  return (
    <View style={styles.root}>
      {/* Header: phase + timer */}
      <View style={[styles.header, myTurn && styles.headerActive]}>
        <View style={styles.headerRow}>
          <Text style={[styles.turn, myTurn && { color: colors.gold }]} numberOfLines={1}>
            {view.turnDescription}
          </Text>
          <Text style={[styles.time, left < 10_000 && myTurn && { color: colors.danger }]}>
            {Math.ceil(left / 1000)}
          </Text>
        </View>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${progress * 100}%`, backgroundColor: myTurn ? colors.gold : colors.textDim },
            ]}
          />
        </View>
      </View>

      {/* Bans */}
      <View style={styles.bans}>
        <BanRow pairing={pairing} bans={view.myTeamBans} color={colors.ally} size={banSize} />
        <Text style={styles.bansLabel}>BANS</Text>
        <BanRow pairing={pairing} bans={view.theirTeamBans} color={colors.enemy} size={banSize} alignEnd />
      </View>

      {/* Teams */}
      <View style={styles.teams}>
        <View style={styles.team}>
          {view.myTeam.map((p) => (
            <PlayerRow
              key={p.cellId}
              pairing={pairing}
              player={p}
              byId={byId}
              side="ally"
              actingLabel={actingLabel}
              swapHint={p.isLocalPlayer ? null : (swapHints.get(p.cellId) ?? null)}
              onPress={p.isLocalPlayer || !swapHints.has(p.cellId) ? undefined : openSheet}
            />
          ))}
        </View>
        <View style={styles.team}>
          {view.theirTeam.map((p) => (
            <PlayerRow key={p.cellId} pairing={pairing} player={p} byId={byId} side="enemy" actingLabel={actingLabel} />
          ))}
        </View>
      </View>

      {/* Champion picker */}
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder={`Search ${grid.length} ${mode === 'ban' ? 'bannable' : 'unlocked'} champions`}
        placeholderTextColor={colors.textDim}
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
      />
      <FlatList
        key={columns}
        style={[styles.grid, !canHover && !action && { opacity: 0.45 }]}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12 }}
        data={grid}
        numColumns={columns}
        keyExtractor={(c) => String(c.id)}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={40}
        renderItem={({ item }) => (
          <GridTile
            pairing={pairing}
            champion={item}
            size={tile}
            selected={item.id === selected}
            disabled={!canHover}
            ban={mode === 'ban'}
            onPress={choose}
          />
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>{champions.length === 0 ? 'Loading champions…' : 'No champions match'}</Text>
        }
      />

      {/* Action bar */}
      <View style={styles.footer}>
        <SwapBanner view={view} byId={byId} send={send} />
        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable
          onPress={lock}
          disabled={!buttonEnabled}
          style={({ pressed }) => [
            styles.lockButton,
            action && mode === 'ban' ? styles.banButton : null,
            !buttonEnabled && styles.lockDisabled,
            pressed && { opacity: 0.8 },
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text
              style={[styles.lockText, !buttonEnabled && { color: colors.textDim }]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {buttonLabel}
            </Text>
          )}
        </Pressable>
      </View>

      <SwapSheet
        pairing={pairing}
        view={view}
        cellId={sheetCell}
        byId={byId}
        send={send}
        onClose={() => setSheetCell(null)}
      />
    </View>
  );
}

function BanRow({
  pairing,
  bans,
  color,
  size,
  alignEnd,
}: {
  pairing: Pairing;
  bans: number[];
  color: string;
  size: number;
  alignEnd?: boolean;
}) {
  const slots = Array.from({ length: Math.max(5, bans.length) }, (_, i) => bans[i] ?? 0);
  return (
    <View style={[styles.banRow, alignEnd && { justifyContent: 'flex-end' }]}>
      {slots.map((id, i) => (
        <ChampIcon key={i} pairing={pairing} championId={id} size={size} disabled={id > 0} borderColor={color + '66'} />
      ))}
    </View>
  );
}

const PlayerRow = memo(function PlayerRow({
  pairing,
  player,
  byId,
  side,
  actingLabel,
  swapHint = null,
  onPress,
}: {
  pairing: Pairing;
  player: PlayerSlot;
  byId: Map<number, ChampionInfo>;
  side: 'ally' | 'enemy';
  actingLabel: string;
  swapHint?: 'available' | 'pending' | null;
  onPress?: (cellId: number) => void;
}) {
  const shownId = player.championId || player.hoverChampionId;
  const champName = shownId ? (byId.get(shownId)?.name ?? '') : '';
  const accent = side === 'ally' ? colors.ally : colors.enemy;
  const label = player.isLocalPlayer ? 'You' : (player.name ?? (side === 'enemy' ? `Enemy ${POSITION_LABEL[player.position] || ''}` : 'Ally'));
  const enemy = side === 'enemy';
  const role = POSITION_SHORT[player.position] ?? '';
  const status = champName ? `${champName}${player.championId ? '' : '…'}` : player.isActing ? actingLabel : '';
  // Allies show their role too, so role swaps are visible at a glance.
  const sub = enemy ? status || POSITION_LABEL[player.position] || ' ' : [role, status].filter(Boolean).join(' · ') || ' ';
  return (
    <Pressable
      onPress={onPress ? () => onPress(player.cellId) : undefined}
      disabled={!onPress}
      accessibilityLabel={onPress ? `Swap with ${label}` : undefined}
      style={({ pressed }) => [
        styles.player,
        enemy && { flexDirection: 'row-reverse' },
        player.isActing && { borderColor: accent, backgroundColor: accent + '22' },
        player.isLocalPlayer && { borderColor: colors.gold },
        pressed && { opacity: 0.7 },
      ]}
    >
      <ChampIcon
        pairing={pairing}
        championId={shownId}
        size={30}
        faded={!player.championId && player.hoverChampionId > 0}
        borderColor={player.championId ? accent : colors.border}
      />
      <View style={[styles.playerText, enemy && { alignItems: 'flex-end' }]}>
        <Text style={[styles.playerName, player.isLocalPlayer && { color: colors.gold }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.playerSub} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      {swapHint && (
        <View style={[styles.swapBadge, swapHint === 'pending' && styles.swapBadgePending]}>
          <Text style={[styles.swapBadgeText, swapHint === 'pending' && { color: colors.bg }]}>⇄</Text>
        </View>
      )}
    </Pressable>
  );
});

const GridTile = memo(function GridTile({
  pairing,
  champion,
  size,
  selected,
  disabled,
  ban,
  onPress,
}: {
  pairing: Pairing;
  champion: ChampionInfo;
  size: number;
  selected: boolean;
  disabled: boolean;
  ban: boolean;
  onPress: (id: number) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(champion.id)}
      disabled={disabled}
      style={({ pressed }) => [styles.tile, { width: size }, pressed && { opacity: 0.6 }]}
    >
      <ChampIcon
        pairing={pairing}
        championId={champion.id}
        size={size - 12}
        borderColor={selected ? (ban ? colors.danger : colors.gold) : colors.border}
        style={selected ? { borderWidth: 3 } : undefined}
      />
      <Text style={[styles.tileName, selected && { color: ban ? colors.danger : colors.gold }]} numberOfLines={1}>
        {champion.name}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, borderBottomWidth: 1, borderColor: colors.border },
  headerActive: { backgroundColor: colors.goldDark + '33' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  turn: { color: colors.text, fontSize: 18, fontWeight: '700', flex: 1 },
  time: { color: colors.text, fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'], marginLeft: 12 },
  progressTrack: { height: 4, backgroundColor: colors.panelRaised, borderRadius: 2, marginTop: 8, overflow: 'hidden' },
  progressFill: { height: 4 },
  bans: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  banRow: { flex: 1, flexDirection: 'row', gap: 3 },
  bansLabel: { color: colors.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginHorizontal: 4 },
  teams: { flexDirection: 'row', paddingHorizontal: 8, gap: 8 },
  team: { flex: 1, gap: 3 },
  player: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 3,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.panel,
  },
  playerText: { flex: 1, minWidth: 0 },
  playerName: { color: colors.text, fontSize: 13, fontWeight: '600' },
  playerSub: { color: colors.textDim, fontSize: 11 },
  swapBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swapBadgePending: { backgroundColor: colors.gold },
  swapBadgeText: { color: colors.gold, fontSize: 12, fontWeight: '800', lineHeight: 14 },
  search: {
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 6,
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
  },
  grid: { flex: 1 },
  tile: { alignItems: 'center', paddingVertical: 4 },
  tileName: { color: colors.textDim, fontSize: 10, marginTop: 2, maxWidth: '94%' },
  empty: { color: colors.textDim, textAlign: 'center', marginTop: 24 },
  footer: { padding: 12, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  error: { color: colors.danger, textAlign: 'center', marginBottom: 8 },
  lockButton: {
    backgroundColor: colors.gold,
    borderRadius: 10,
    paddingVertical: 16,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  banButton: { backgroundColor: colors.danger },
  lockDisabled: { backgroundColor: colors.panelRaised },
  lockText: { color: colors.bg, fontSize: 17, fontWeight: '800', letterSpacing: 1 },
});
