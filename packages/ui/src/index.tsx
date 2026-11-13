import type { AppAudience, BusinessSlug } from '@market/core';
import { MarketApplication } from './MarketApplication';
import { MarketThemeProvider } from './theme';
export * from './components';
export * from './theme';
export function MarketApp({ businessId, audience }: { businessId: BusinessSlug; audience: AppAudience }) {
  return <MarketThemeProvider businessId={businessId}><MarketApplication businessId={businessId} audience={audience} /></MarketThemeProvider>;
}
