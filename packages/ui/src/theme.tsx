import { businesses, type BusinessSlug } from '@market/core';
import { createContext, useContext, type ReactNode } from 'react';

export type MarketTheme = {
  businessId: BusinessSlug;
  name: string;
  colors: {
    background: string; surface: string; ink: string; muted: string; primary: string;
    onPrimary: string; accent: string; border: string; inputBorder: string; tint: string; danger: string;
  };
};

export const marketThemes: Record<BusinessSlug, MarketTheme> = {
  'ammu-sammu': {
    businessId: 'ammu-sammu', name: businesses['ammu-sammu'].name,
    colors: { background: '#FFF8F0', surface: '#FFFFFF', ink: '#332522', muted: '#6E5750', primary: '#A83E32', onPrimary: '#FFFFFF', accent: '#F3AA8E', border: '#E9D7CC', inputBorder: '#6E5750', tint: '#FCE5D9', danger: '#A12828' },
  },
  'konkan-fine-dine': {
    businessId: 'konkan-fine-dine', name: businesses['konkan-fine-dine'].name,
    colors: { background: '#F8F5EA', surface: '#FFFFFF', ink: '#1E3431', muted: '#526A64', primary: '#165C54', onPrimary: '#FFFFFF', accent: '#C8B47C', border: '#D7DFD6', inputBorder: '#526A64', tint: '#DDECE5', danger: '#A12828' },
  },
};

const ThemeContext = createContext<MarketTheme>(marketThemes['ammu-sammu']);
export function MarketThemeProvider({ businessId, children }: { businessId: BusinessSlug; children: ReactNode }) {
  return <ThemeContext.Provider value={marketThemes[businessId]}>{children}</ThemeContext.Provider>;
}
export function useMarketTheme() { return useContext(ThemeContext); }
