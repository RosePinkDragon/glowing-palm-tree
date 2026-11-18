// Theme data for both restaurants, kept free of JSX so tests can check the real values.
import { businesses, type BusinessSlug } from '@market/core';

export type MarketTheme = {
  businessId: BusinessSlug;
  name: string;
  /** Customer order status header (#47): Ammu Sammu uses a status pill on the page, Kokani Dine Inn a dark band. */
  statusHeader: 'pill' | 'band';
  /** Customer menu layout (#39): Ammu Sammu a searchable 2-column photo grid; Kokani Dine Inn a signature carousel on a dark header and a text à la carte list with dotted price leaders. */
  menuLayout: 'photo-grid' | 'carta';
  /** How the restaurant speaks in customer copy: by name ("Call Ammu Sammu") or as "we" ("Call us", "our kitchen"). */
  voice: 'restaurant' | 'we';
  /** Line above a receipt total: Ammu Sammu dashed, Kokani Dine Inn solid. */
  receiptRule: 'dashed' | 'solid';
  /** Owners' header (#53): Ammu Sammu keeps a light header, Kokani Dine Inn a deep green one with gold-outlined chips. */
  ownerHeader: 'light' | 'dark';
  colors: {
    background: string; surface: string; ink: string; muted: string; primary: string;
    onPrimary: string; accent: string; border: string; inputBorder: string; tint: string; danger: string;
    /** Semantic on/off state for switches (owners' p. 8–10: green on, warm grey off, both brands). */
    switchOn: string; switchOff: string;
    /** Status pills: positive (Live) text and tint, and a neutral tint (unavailable, paused). */
    positive: string; positiveTint: string; neutralTint: string;
    /** Amber notices (e.g. live updates paused): text/icon colour and its background. */
    warning: string; warningTint: string;
    /** Order status band (#47): background, eyebrow/progress colour, and the cancelled variant. */
    band: string; bandAccent: string; bandMuted: string; bandMutedAccent: string;
    /** "Get updates on this order" card background and bell. */
    updatesTint: string; updatesIcon: string;
    /** Closed-restaurant notice (#58 on the #39 design): background and the text and icon on it. */
    notice: string; onNotice: string;
    /** Owners' shell (#53): contrasting page surface, header fill and its text, the open/closed bands and their text, and the signed-out hero. */
    page: string; ownerHeader: string; onOwnerHeader: string; openBand: string; onOpenBand: string; closedBand: string; onClosedBand: string; loginHero: string; /** Live-dot green on the dark owners' header. */ liveDot: string;
  };
};

export const marketThemes: Record<BusinessSlug, MarketTheme> = {
  'ammu-sammu': {
    businessId: 'ammu-sammu', name: businesses['ammu-sammu'].name, statusHeader: 'pill', menuLayout: 'photo-grid', voice: 'restaurant', receiptRule: 'dashed', ownerHeader: 'light',
    colors: { background: '#FFF8F0', surface: '#FFFFFF', ink: '#332522', muted: '#6E5750', primary: '#A83E32', onPrimary: '#FFFFFF', accent: '#F3AA8E', border: '#E9D7CC', inputBorder: '#6E5750', tint: '#FCE5D9', danger: '#A12828', switchOn: '#2E7D32', switchOff: '#857873', positive: '#1F5B37', positiveTint: '#E3F1E7', neutralTint: '#ECE6E2', warning: '#7A4B00', warningTint: '#FFF1D6', band: '#A83E32', bandAccent: '#FCE5D9', bandMuted: '#5E4E49', bandMutedAccent: '#F1E7E3', updatesTint: '#F6E9E2', updatesIcon: '#A83E32', notice: '#2E211E', onNotice: '#FFFFFF', page: '#F4EEE8', ownerHeader: '#FFF8F0', onOwnerHeader: '#332522', openBand: '#E3F1E7', onOpenBand: '#1F5B37', closedBand: '#2E211E', onClosedBand: '#FFFFFF', loginHero: '#2E211E', liveDot: '#7BD389' },
  },
  'kokani-dine-inn': {
    businessId: 'kokani-dine-inn', name: businesses['kokani-dine-inn'].name, statusHeader: 'band', menuLayout: 'carta', voice: 'we', receiptRule: 'solid', ownerHeader: 'dark',
    colors: { background: '#F8F5EA', surface: '#FFFFFF', ink: '#1E3431', muted: '#526A64', primary: '#165C54', onPrimary: '#FFFFFF', accent: '#C8B47C', border: '#D7DFD6', inputBorder: '#526A64', tint: '#DDECE5', danger: '#A12828', switchOn: '#2E7D32', switchOff: '#857873', positive: '#1F5B37', positiveTint: '#E3F1E7', neutralTint: '#E6EAE4', warning: '#7A4B00', warningTint: '#FFF1D6', band: '#10302B', bandAccent: '#C6AC70', bandMuted: '#3B4A46', bandMutedAccent: '#DCE3E0', updatesTint: '#ECE6D6', updatesIcon: '#8A6D2F', notice: '#C8B47C', onNotice: '#10302B', page: '#F1EEE4', ownerHeader: '#10302B', onOwnerHeader: '#F8F5EA', openBand: '#DDECE5', onOpenBand: '#0F4F47', closedBand: '#1E3431', onClosedBand: '#FFFFFF', loginHero: '#10302B', liveDot: '#7BD389' },
  },
};

/** WCAG relative-luminance contrast ratio between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}
