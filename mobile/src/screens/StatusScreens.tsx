import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import type { ReadyCheckView } from '../protocol';
import type { CommandResult } from '../useCompanion';
import { useCountdown } from '../useCompanion';
import { colors } from '../theme';

const PHASE_TEXT: Record<string, [string, string]> = {
  None: ['At home screen', 'Open a lobby on your computer. This screen updates automatically.'],
  Lobby: ['In lobby', 'Start queueing on your computer — you can accept the match from here.'],
  Matchmaking: ['In queue', "Finding a match… You'll be able to accept it here."],
  CheckedIntoTournament: ['Checked into tournament', 'Waiting for the tournament to start.'],
  ReadyCheck: ['Match found!', 'Loading the accept screen…'],
  ChampSelect: ['Champ select', 'Loading champ select…'],
  GameStart: ['Game starting', 'Head back to your computer!'],
  InProgress: ['Game in progress', 'Good luck, have fun!'],
  WaitingForStats: ['Waiting for stats', ''],
  PreEndOfGame: ['Game over', ''],
  EndOfGame: ['Game over', 'Queue up again from your computer.'],
  Reconnect: ['Reconnect available', 'Reconnect to your game from your computer.'],
};

export function MessageScreen({
  title,
  detail,
  busy,
  footer,
}: {
  title: string;
  detail?: string;
  busy?: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <View style={styles.center}>
      {busy && <ActivityIndicator color={colors.gold} size="large" style={{ marginBottom: 20 }} />}
      <Text style={styles.title}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      {footer}
    </View>
  );
}

export function PhaseScreen({ phase, summonerName }: { phase: string; summonerName: string | null }) {
  const [title, detail] = PHASE_TEXT[phase] ?? [phase, ''];
  return (
    <MessageScreen
      title={title}
      detail={detail}
      busy={phase === 'Matchmaking' || phase === 'ChampSelect'}
      footer={summonerName ? <Text style={styles.small}>Signed in as {summonerName}</Text> : null}
    />
  );
}

export function ReadyCheckScreen({
  readyCheck,
  receivedAt,
  send,
}: {
  readyCheck: ReadyCheckView;
  receivedAt: number;
  send: (cmd: { type: 'acceptReadyCheck' } | { type: 'declineReadyCheck' }) => Promise<CommandResult>;
}) {
  const left = useCountdown(readyCheck.timeLeftMs, receivedAt);
  const [error, setError] = useState<string | null>(null);
  const responded = readyCheck.playerResponse !== 'None';

  // Buzz repeatedly until you accept or decline (or the ready check ends), so you notice the queue pop.
  useEffect(() => {
    if (responded) return;
    Vibration.vibrate([0, 700, 400, 700, 400, 700, 1200], true);
    return () => Vibration.cancel();
  }, [responded]);

  const respond = async (type: 'acceptReadyCheck' | 'declineReadyCheck') => {
    setError(null);
    const r = await send({ type });
    if (!r.ok) setError(r.error ?? 'Something went wrong');
  };

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Match found!</Text>
      {readyCheck.timeLeftMs > 0 ? (
        <Text style={styles.timer}>{Math.ceil(left / 1000)}</Text>
      ) : (
        <View style={{ height: 40 }} />
      )}
      {responded ? (
        <Text style={[styles.detail, { color: readyCheck.playerResponse === 'Accepted' ? colors.success : colors.danger }]}>
          {readyCheck.playerResponse === 'Accepted' ? 'Accepted — waiting for other players…' : 'Declined'}
        </Text>
      ) : (
        <>
          <Pressable style={[styles.button, styles.accept]} onPress={() => respond('acceptReadyCheck')}>
            <Text style={styles.acceptText}>ACCEPT</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.decline]} onPress={() => respond('declineReadyCheck')}>
            <Text style={styles.declineText}>Decline</Text>
          </Pressable>
        </>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  title: { color: colors.text, fontSize: 26, fontWeight: '800', textAlign: 'center' },
  detail: { color: colors.textDim, fontSize: 16, textAlign: 'center', marginTop: 12, lineHeight: 22 },
  small: { color: colors.textDim, fontSize: 13, marginTop: 32 },
  timer: { color: colors.gold, fontSize: 64, fontWeight: '800', marginVertical: 24, fontVariant: ['tabular-nums'] },
  button: { alignSelf: 'stretch', borderRadius: 10, paddingVertical: 18, alignItems: 'center', marginTop: 12 },
  accept: { backgroundColor: colors.gold },
  acceptText: { color: colors.bg, fontSize: 22, fontWeight: '800', letterSpacing: 2 },
  decline: { borderWidth: 1.5, borderColor: colors.border },
  declineText: { color: colors.textDim, fontSize: 17, fontWeight: '600' },
  error: { color: colors.danger, marginTop: 16, textAlign: 'center' },
});
