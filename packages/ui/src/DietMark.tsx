import { StyleSheet, Text, View } from 'react-native';
import { dietLabels, isDiet, type Diet } from '@market/core';

/** Shape and text carry the meaning independently of colour. Unknown has no mark. `compact` keeps only the shape (still labelled for assistive tech). */
export function DietMark({ diet, compact = false }: { diet?: Diet | null; compact?: boolean }) {
  if (!isDiet(diet)) return null;
  const color = diet === 'veg' ? '#23733A' : diet === 'egg' ? '#946000' : '#75442F';
  return <View accessible accessibilityRole="image" accessibilityLabel={dietLabels[diet]} style={compact ? undefined : styles.mark}>
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.square, compact && small.square, { borderColor: color }]}>
      <View style={diet === 'non_veg' ? [styles.triangle, compact && small.triangle, { borderBottomColor: color }] : [diet === 'egg' ? styles.oval : styles.dot, compact && (diet === 'egg' ? small.oval : small.dot), { backgroundColor: color }]} />
    </View>
    {compact ? null : <Text accessible={false} aria-hidden style={[styles.label, { color }]}>{dietLabels[diet]}</Text>}
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
const small = StyleSheet.create({
  square: { width: 16, height: 16 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  oval: { width: 6, height: 9, borderRadius: 3 },
  triangle: { borderLeftWidth: 4.5, borderRightWidth: 4.5, borderBottomWidth: 8 },
});
