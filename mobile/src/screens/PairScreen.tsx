import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { checkPairing, normalizeCode, parsePairingUrl, savePairing, type Pairing } from '../pairing';
import { colors } from '../theme';

interface Props {
  initial: Pairing | null;
  onPaired: (p: Pairing) => void;
}

export function PairScreen({ initial, onPaired }: Props) {
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(String(initial?.port ?? 8787));
  const [token, setToken] = useState(initial?.token ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  const tryPair = async (p: Pairing) => {
    setBusy(true);
    setError(null);
    const result = await checkPairing(p);
    setBusy(false);
    if (result === 'ok') {
      await savePairing(p);
      onPaired(p);
    } else if (result === 'bad-token') {
      setError('Wrong pairing code. Check the code shown by the companion on your computer.');
    } else if (result === 'locked') {
      setError('Too many wrong codes. Wait a minute, then try again.');
    } else {
      setError(
        `Can't reach ${p.host}:${p.port}. Make sure the companion is running and your phone is on the same Wi-Fi.`,
      );
    }
  };

  const startScan = async () => {
    setError(null);
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        setError('Camera permission is needed to scan the QR code. You can enter the details manually instead.');
        return;
      }
    }
    setScanning(true);
  };

  if (scanning) {
    return (
      <View style={styles.scanner}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            const p = parsePairingUrl(data);
            if (!p) return;
            setScanning(false);
            setHost(p.host);
            setPort(String(p.port));
            setToken(p.token);
            void tryPair(p);
          }}
        />
        <View style={styles.scanFrame} pointerEvents="none" />
        <Text style={styles.scanHint}>Point at the QR code in the companion window</Text>
        <Pressable style={[styles.button, styles.secondary, styles.scanCancel]} onPress={() => setScanning(false)}>
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const portNum = Number(port);
  const code = normalizeCode(token);
  const valid = host.trim().length > 0 && code.length > 0 && Number.isInteger(portNum) && portNum > 0;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Champ Select Remote</Text>
        <Text style={styles.subtitle}>
          Run the companion on the computer that has League of Legends, then pair this phone with it.
        </Text>

        <Pressable style={[styles.button, styles.primary]} onPress={startScan} disabled={busy}>
          <Text style={styles.primaryText}>Scan QR code</Text>
        </Pressable>

        <Text style={styles.or}>or enter the details manually</Text>

        <Text style={styles.label}>Computer address</Text>
        <TextInput
          style={styles.input}
          value={host}
          onChangeText={setHost}
          placeholder="192.168.1.20"
          placeholderTextColor={colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
        />
        <Text style={styles.label}>Port</Text>
        <TextInput
          style={styles.input}
          value={port}
          onChangeText={setPort}
          keyboardType="number-pad"
          placeholderTextColor={colors.textDim}
        />
        <Text style={styles.label}>Pairing code</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="4 characters, e.g. K7MQ"
          placeholderTextColor={colors.textDim}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={6}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.button, styles.secondary, !valid && styles.disabled]}
          disabled={!valid || busy}
          onPress={() => tryPair({ host: host.trim(), port: portNum, token: code })}
        >
          {busy ? <ActivityIndicator color={colors.gold} /> : <Text style={styles.secondaryText}>Connect</Text>}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 24, paddingTop: 48, gap: 8 },
  title: { color: colors.gold, fontSize: 28, fontWeight: '800', letterSpacing: 0.5 },
  subtitle: { color: colors.textDim, fontSize: 15, lineHeight: 21, marginBottom: 16 },
  or: { color: colors.textDim, textAlign: 'center', marginVertical: 16 },
  label: { color: colors.textDim, fontSize: 13, marginTop: 8 },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  error: { color: colors.danger, marginTop: 12, lineHeight: 20 },
  button: { borderRadius: 8, paddingVertical: 15, alignItems: 'center', marginTop: 16 },
  primary: { backgroundColor: colors.gold },
  primaryText: { color: colors.bg, fontSize: 17, fontWeight: '700' },
  secondary: { borderWidth: 1.5, borderColor: colors.gold },
  secondaryText: { color: colors.gold, fontSize: 17, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  scanner: { flex: 1, backgroundColor: 'black', alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: 240, height: 240, borderWidth: 3, borderColor: colors.gold, borderRadius: 16 },
  scanHint: { color: 'white', marginTop: 24, fontSize: 15 },
  scanCancel: { position: 'absolute', bottom: 48, left: 24, right: 24, backgroundColor: 'rgba(0,0,0,0.6)' },
});
