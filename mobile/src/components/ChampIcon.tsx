import { memo } from 'react';
import { Image, StyleSheet, View, type ViewStyle } from 'react-native';
import { iconUrl, type Pairing } from '../pairing';
import { colors } from '../theme';

interface Props {
  pairing: Pairing;
  championId: number;
  size: number;
  /** Render semi-transparent (hover / intent rather than locked). */
  faded?: boolean;
  /** Greyed out with a strike-through (banned / unavailable). */
  disabled?: boolean;
  borderColor?: string;
  style?: ViewStyle;
}

export const ChampIcon = memo(function ChampIcon({
  pairing,
  championId,
  size,
  faded,
  disabled,
  borderColor,
  style,
}: Props) {
  const box = {
    width: size,
    height: size,
    borderRadius: size * 0.12,
    borderColor: borderColor ?? colors.border,
  };
  return (
    <View style={[styles.box, box, style]}>
      {championId > 0 && (
        <Image
          source={{ uri: iconUrl(pairing, championId) }}
          style={[StyleSheet.absoluteFill, { opacity: faded ? 0.45 : disabled ? 0.3 : 1 }]}
        />
      )}
      {disabled && <View style={[styles.slash, { width: size * 1.3 }]} />}
    </View>
  );
});

const styles = StyleSheet.create({
  box: {
    overflow: 'hidden',
    borderWidth: 1.5,
    backgroundColor: colors.panelRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slash: {
    position: 'absolute',
    height: 2,
    backgroundColor: colors.danger,
    transform: [{ rotate: '-45deg' }],
  },
});
