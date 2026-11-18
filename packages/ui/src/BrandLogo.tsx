import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { brandLogos } from './brand-logos';
import { useMarketTheme } from './theme';

/** The active restaurant's original logo. Pass a label when no adjacent text names the restaurant. */
export function BrandLogo({ height, label }: { height: number; label?: string }) {
  const { businessId } = useMarketTheme();
  const logo = brandLogos[businessId];
  const width = Math.round(height * logo.width / logo.height);
  const art = <SvgXml xml={logo.xml} width={width} height={height} />;
  return label
    ? <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width, height }}>{art}</View>
    : <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width, height }}>{art}</View>;
}
