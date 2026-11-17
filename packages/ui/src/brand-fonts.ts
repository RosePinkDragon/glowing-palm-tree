import { useMemo } from 'react';
import { useFonts } from 'expo-font';
import type { BusinessSlug } from '@market/core';
import { Eczar_600SemiBold } from '@expo-google-fonts/eczar/600SemiBold';
import { Mukta_400Regular } from '@expo-google-fonts/mukta/400Regular';
import { Mukta_600SemiBold } from '@expo-google-fonts/mukta/600SemiBold';
import { Mukta_700Bold } from '@expo-google-fonts/mukta/700Bold';
import { TiroDevanagariMarathi_400Regular } from '@expo-google-fonts/tiro-devanagari-marathi/400Regular';
import { MartelSans_400Regular } from '@expo-google-fonts/martel-sans/400Regular';
import { MartelSans_600SemiBold } from '@expo-google-fonts/martel-sans/600SemiBold';
import { MartelSans_700Bold } from '@expo-google-fonts/martel-sans/700Bold';
import type { MarketFonts } from './theme';

// Each app loads only its own restaurant's typefaces (from the final design PDFs).
const brandFonts: Record<BusinessSlug, { files: Record<string, number>; families: Required<MarketFonts> }> = {
  'ammu-sammu': {
    files: { Eczar_600SemiBold, Mukta_400Regular, Mukta_600SemiBold, Mukta_700Bold },
    families: { heading: 'Eczar_600SemiBold', body: 'Mukta_400Regular', bodySemiBold: 'Mukta_600SemiBold', bodyBold: 'Mukta_700Bold' },
  },
  'kokani-dine-inn': {
    files: { TiroDevanagariMarathi_400Regular, MartelSans_400Regular, MartelSans_600SemiBold, MartelSans_700Bold },
    families: { heading: 'TiroDevanagariMarathi_400Regular', body: 'MartelSans_400Regular', bodySemiBold: 'MartelSans_600SemiBold', bodyBold: 'MartelSans_700Bold' },
  },
};

/** Families are exposed only once loaded; until then, or if loading fails, system fonts are used (the app never waits on fonts). */
export function useBrandFonts(businessId: BusinessSlug): MarketFonts {
  const brand = brandFonts[businessId];
  const [loaded, error] = useFonts(brand.files);
  return useMemo(() => loaded && !error ? brand.families : {}, [loaded, error, brand]);
}
