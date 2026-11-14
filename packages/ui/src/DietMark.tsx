import { StyleSheet, Text, View } from 'react-native';
import { dietLabels, isDiet, type Diet } from '@market/core';

/** Shape and text carry the meaning independently of colour. Unknown has no mark. */
export function DietMark({ diet }: { diet?: Diet | null }) {
  if (!isDiet(diet)) return null;
  const color = diet === 'veg' ? '#23733A' : diet === 'egg' ? '#946000' : '#75442F';
  return <View accessible accessibilityRole="image" accessibilityLabel={dietLabels[diet]} style={styles.mark}>
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.square, { borderColor: color }]}>
      <View style={diet === 'non_veg' ? [styles.triangle, { borderBottomColor: color }] : [diet === 'egg' ? styles.oval : styles.dot, { backgroundColor: color }]} />
    </View>
    <Text accessible={false} aria-hidden style={[styles.label, { color }]}>{dietLabels[diet]}</Text>
  </View>;
}

const styles = StyleSheet.create({
  mark: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  square: { width: 22, height: 22, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  oval: { width: 8, height: 13, borderRadius: 5 },
  triangle: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  label: { fontSize: 14, lineHeight: 22 },
});
