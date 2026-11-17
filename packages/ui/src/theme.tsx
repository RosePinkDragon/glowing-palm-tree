import type { BusinessSlug } from '@market/core';
import { createContext, useContext, type ReactNode } from 'react';
import { marketThemes, type MarketTheme } from './theme-tokens';

export { contrastRatio, marketThemes, type MarketTheme } from './theme-tokens';

const ThemeContext = createContext<MarketTheme>(marketThemes['ammu-sammu']);
export function MarketThemeProvider({ businessId, children }: { businessId: BusinessSlug; children: ReactNode }) {
  return <ThemeContext.Provider value={marketThemes[businessId]}>{children}</ThemeContext.Provider>;
}
export function useMarketTheme() { return useContext(ThemeContext); }

/** Brand font families that have finished loading. Empty (system fonts) unless a shell has loaded them. */
export type MarketFonts = { heading?: string; body?: string; bodySemiBold?: string; bodyBold?: string };
const FontContext = createContext<MarketFonts>({});
export const MarketFontsProvider = FontContext.Provider;
export function useMarketFonts() { return useContext(FontContext); }
