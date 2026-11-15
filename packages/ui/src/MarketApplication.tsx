import type { AppAudience, BusinessSlug } from '@market/core';
import { CustomerArea } from './CustomerArea';
import { AdminShell } from './AdminShell';

export function MarketApplication({ businessId, audience }: { businessId: BusinessSlug; audience: AppAudience }) {
  if (audience === 'customer') return <CustomerArea key={businessId} businessId={businessId} />;
  return <AdminShell key={businessId} businessId={businessId} />;
}
