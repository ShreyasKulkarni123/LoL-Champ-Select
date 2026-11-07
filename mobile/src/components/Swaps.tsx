import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { ChampionInfo, ChampSelectView, PlayerSlot, SwapKind, SwapOperation, SwapOption } from '../protocol';
import type { CommandResult } from '../useCompanion';
import type { Pairing } from '../pairing';
import { ChampIcon } from './ChampIcon';
import { colors, POSITION_LABEL } from '../theme';

export type SendSwap = (cmd: {
  type: 'swap';
  kind: SwapKind;
  swapId: number;
  op: SwapOperation;
}) => Promise<CommandResult>;

const KIND_TITLE: Record<SwapKind, string> = {
  pickOrder: 'Swap pick order',
  position: 'Swap roles',
  champion: 'Trade champions',
};
const KIND_NOUN: Record<SwapKind, string> = {
  pickOrder: 'pick order swap',
  position: 'role swap',
  champion: 'champion trade',
};
const KIND_ORDER: SwapKind[] = ['position', 'pickOrder', 'champion'];

const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
export const teammateName = (p: PlayerSlot | undefined) => p?.name ?? 'Teammate';

/** What the local player ends up with if the swap goes through. */
export function describeSwap(
  kind: SwapKind,
  me: PlayerSlot | undefined,
  them: PlayerSlot | undefined,
  byId: Map<number, ChampionInfo>,
): string {
  if (!me || !them) return '';
  switch (kind) {
    case 'position':
      return `You'd play ${POSITION_LABEL[them.position] || '?'}, they'd play ${POSITION_LABEL[me.position] || '?'}`;
    case 'pickOrder':
      return them.pickOrder && me.pickOrder
        ? `You'd pick ${ordinal(them.pickOrder)} instead of ${ordinal(me.pickOrder)}`
        : 'Exchange your pick turns';
    case 'champion':
      return `You'd get ${byId.get(them.championId)?.name ?? 'their champion'}, they'd get ${byId.get(me.championId)?.name ?? 'yours'}`;
  }
}

/** Sends a swap command and tracks busy / error state. */
function useSwapCommand(send: SendSwap) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (s: SwapOption, op: SwapOperation) => {
    setBusy(`${s.kind}-${s.id}-${op}`);
    setError(null);
    const r = await send({ type: 'swap', kind: s.kind, swapId: s.id, op });
    setBusy(null);
    if (!r.ok) setError(r.error ?? 'Swap failed');
    else if (op === 'accept') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    return r.ok;
  };
  return { busy, error, run };
}

/**
 * Shows an incoming request (Accept / Decline) or our own pending request (Cancel).
 * Renders nothing when no swap is pending.
 */
export function SwapBanner({
  view,
  byId,
  send,
}: {
  view: ChampSelectView;
  byId: Map<number, ChampionInfo>;
  send: SendSwap;
}) {
  const incoming = view.swaps.find((s) => s.state === 'RECEIVED');
  const outgoing = view.swaps.find((s) => s.state === 'SENT');
  const { busy, error, run } = useSwapCommand(send);

  // Buzz when a teammate asks for a swap.
  const lastIncoming = useRef<string | null>(null);
  const incomingKey = incoming ? `${incoming.kind}-${incoming.id}` : null;
  useEffect(() => {
    if (incomingKey && incomingKey !== lastIncoming.current) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
    lastIncoming.current = incomingKey;
  }, [incomingKey]);

  const swap = incoming ?? outgoing;
  if (!swap) return error ? <Text style={styles.error}>{error}</Text> : null;

  const me = view.myTeam.find((p) => p.isLocalPlayer);
  const them = view.myTeam.find((p) => p.cellId === swap.cellId);
  const detail = describeSwap(swap.kind, me, them, byId);

  return (
    <View style={[styles.banner, incoming ? styles.bannerIncoming : styles.bannerOutgoing]}>
      <Text style={styles.bannerTitle}>
        {incoming
          ? `${teammateName(them)} wants a ${KIND_NOUN[swap.kind]}`
          : `Waiting for ${teammateName(them)} to respond to your ${KIND_NOUN[swap.kind]}…`}
      </Text>
      {detail ? <Text style={styles.bannerDetail}>{detail}</Text> : null}
      <View style={styles.bannerButtons}>
        {incoming ? (
          <>
            <SmallButton label="Decline" busy={busy?.endsWith('decline')} onPress={() => run(swap, 'decline')} />
            <SmallButton label="Accept" primary busy={busy?.endsWith('accept')} onPress={() => run(swap, 'accept')} />
          </>
        ) : (
          <SmallButton label="Cancel request" busy={busy?.endsWith('cancel')} onPress={() => run(swap, 'cancel')} />
        )}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/** Bottom sheet listing the swaps possible with one teammate. */
export function SwapSheet({
  pairing,
  view,
  cellId,
  byId,
  send,
  onClose,
}: {
  pairing: Pairing;
  view: ChampSelectView;
  cellId: number | null;
  byId: Map<number, ChampionInfo>;
  send: SendSwap;
  onClose: () => void;
}) {
  const { busy, error, run } = useSwapCommand(send);
  const me = view.myTeam.find((p) => p.isLocalPlayer);
  const them = view.myTeam.find((p) => p.cellId === cellId);
  const options = view.swaps
    .filter((s) => s.cellId === cellId)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

  return (
    <Modal visible={cellId !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHeader}>
          {them && (
            <ChampIcon
              pairing={pairing}
              championId={them.championId || them.hoverChampionId}
              size={40}
              faded={!them.championId}
            />
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.sheetTitle}>{teammateName(them)}</Text>
            <Text style={styles.sheetSub}>
              {[POSITION_LABEL[them?.position ?? ''], them?.pickOrder ? `${ordinal(them.pickOrder)} pick` : '']
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Close</Text>
          </Pressable>
        </View>

        {options.length === 0 && <Text style={styles.none}>No swaps with this player right now.</Text>}

        {options.map((s) => {
          const key = `${s.kind}-${s.id}`;
          let action: React.ReactNode;
          if (s.state === 'AVAILABLE') {
            action = <SmallButton label="Request" primary busy={busy === `${key}-request`} onPress={() => run(s, 'request')} />;
          } else if (s.state === 'SENT') {
            action = <SmallButton label="Cancel" busy={busy === `${key}-cancel`} onPress={() => run(s, 'cancel')} />;
          } else if (s.state === 'RECEIVED') {
            action = (
              <View style={styles.row}>
                <SmallButton label="Decline" busy={busy === `${key}-decline`} onPress={() => run(s, 'decline')} />
                <SmallButton
                  label="Accept"
                  primary
                  busy={busy === `${key}-accept`}
                  onPress={async () => {
                    if (await run(s, 'accept')) onClose();
                  }}
                />
              </View>
            );
          } else {
            action = <Text style={styles.stateText}>{s.state === 'BUSY' ? 'Busy' : s.state.toLowerCase()}</Text>;
          }
          return (
            <View key={key} style={styles.option}>
              <View style={{ flex: 1 }}>
                <Text style={styles.optionTitle}>{KIND_TITLE[s.kind]}</Text>
                <Text style={styles.optionDetail}>
                  {s.state === 'SENT' ? 'Request sent — waiting…' : describeSwap(s.kind, me, them, byId)}
                </Text>
              </View>
              {action}
            </View>
          );
        })}
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    </Modal>
  );
}

function SmallButton({
  label,
  primary,
  busy,
  onPress,
}: {
  label: string;
  primary?: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={({ pressed }) => [styles.small, primary ? styles.smallPrimary : styles.smallSecondary, pressed && { opacity: 0.7 }]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={primary ? colors.bg : colors.gold} />
      ) : (
        <Text style={[styles.smallText, primary && { color: colors.bg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: { borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1 },
  bannerIncoming: { backgroundColor: colors.goldDark + '40', borderColor: colors.gold },
  bannerOutgoing: { backgroundColor: colors.panel, borderColor: colors.border },
  bannerTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  bannerDetail: { color: colors.textDim, fontSize: 13, marginTop: 3 },
  bannerButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    backgroundColor: colors.panel,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  sheetSub: { color: colors.textDim, fontSize: 13 },
  close: { color: colors.gold, fontSize: 15, fontWeight: '600' },
  none: { color: colors.textDim, paddingVertical: 16, textAlign: 'center' },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  optionTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  optionDetail: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  row: { flexDirection: 'row', gap: 8 },
  stateText: { color: colors.textDim, fontSize: 13 },
  small: { borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14, minWidth: 76, alignItems: 'center' },
  smallPrimary: { backgroundColor: colors.gold },
  smallSecondary: { borderWidth: 1.5, borderColor: colors.border },
  smallText: { color: colors.gold, fontSize: 14, fontWeight: '700' },
  error: { color: colors.danger, textAlign: 'center', marginTop: 8 },
});
