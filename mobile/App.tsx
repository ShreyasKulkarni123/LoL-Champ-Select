import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { clearPairing, loadPairing, parsePairingUrl, savePairing, type Pairing } from './src/pairing';
import { useCompanion } from './src/useCompanion';
import { PairScreen } from './src/screens/PairScreen';
import { ChampSelectScreen } from './src/screens/ChampSelectScreen';
import { MessageScreen, PhaseScreen, ReadyCheckScreen } from './src/screens/StatusScreens';
import { colors } from './src/theme';

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    void loadPairing().then((p) => {
      setPairing(p);
      setLoaded(true);
    });
    // Scanning the companion's QR with the phone's own camera opens lolcs://connect?... (standalone builds).
    const handle = (url: string | null | undefined) => {
      const p = url ? parsePairingUrl(url) : null;
      if (p) void savePairing(p).then(() => setPairing(p));
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        {!loaded ? null : !pairing || editing ? (
          <PairScreen
            initial={pairing}
            onPaired={(p) => {
              setPairing(p);
              setEditing(false);
            }}
          />
        ) : (
          <Connected
            pairing={pairing}
            onChangeComputer={() => setEditing(true)}
            onUnpair={() => void clearPairing().then(() => setPairing(null))}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function KeepAwake() {
  useKeepAwake();
  return null;
}

function Connected({
  pairing,
  onChangeComputer,
  onUnpair,
}: {
  pairing: Pairing;
  onChangeComputer: () => void;
  onUnpair: () => void;
}) {
  const { status, state, receivedAt, champions, send } = useCompanion(pairing);
  const live = status === 'open';

  let body: React.ReactNode;
  if (!state) {
    body = (
      <MessageScreen
        title="Connecting to your computer…"
        detail={`Looking for the companion at ${pairing.host}:${pairing.port}.\nMake sure it's running and you're on the same network.`}
        busy
        footer={
          <View style={styles.linkRow}>
            <Pressable onPress={onChangeComputer}>
              <Text style={styles.link}>Edit connection</Text>
            </Pressable>
            <Pressable onPress={onUnpair}>
              <Text style={styles.link}>Unpair</Text>
            </Pressable>
          </View>
        }
      />
    );
  } else if (!state.clientConnected) {
    body = (
      <MessageScreen
        title="League isn't running"
        detail="Start the League of Legends client on your computer. The companion will pick it up automatically."
        busy
      />
    );
  } else if (state.readyCheck) {
    body = <ReadyCheckScreen readyCheck={state.readyCheck} receivedAt={receivedAt} send={send} />;
  } else if (state.champSelect) {
    body = (
      <ChampSelectScreen
        pairing={pairing}
        view={state.champSelect}
        receivedAt={receivedAt}
        champions={champions}
        send={send}
      />
    );
  } else {
    body = <PhaseScreen phase={state.gameflowPhase} summonerName={state.summonerName} />;
  }

  const stayAwake =
    !!state && (state.champSelect !== null || state.readyCheck !== null || state.gameflowPhase === 'Matchmaking');

  return (
    <View style={styles.root}>
      {stayAwake && <KeepAwake />}
      <View style={styles.topBar}>
        <View style={[styles.dot, { backgroundColor: live ? colors.success : colors.danger }]} />
        <Text style={styles.topText} numberOfLines={1}>
          {live ? `Connected to ${pairing.host}` : 'Reconnecting…'}
        </Text>
        <Pressable onPress={onChangeComputer} hitSlop={12}>
          <Text style={styles.topLink}>Settings</Text>
        </Pressable>
      </View>
      <View style={[styles.root, !live && state ? { opacity: 0.6 } : null]}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 6, gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  topText: { color: colors.textDim, fontSize: 12, flex: 1 },
  topLink: { color: colors.gold, fontSize: 13, fontWeight: '600' },
  linkRow: { flexDirection: 'row', gap: 24, marginTop: 32 },
  link: { color: colors.gold, fontSize: 15, fontWeight: '600' },
});
