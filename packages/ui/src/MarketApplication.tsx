import { Component, type ReactNode } from 'react';
import { Platform, ScrollView } from 'react-native';
import type { AppAudience, BusinessSlug } from '@market/core';
import { reportError } from '@market/notifications';
import { CustomerArea } from './CustomerArea';
import { AdminShell } from './AdminShell';
import { MarketButton, MarketStatus } from './components';

/** Shows the app's usual error screen when a screen fails to render, and passes the error to error reports (a no-op unless the user opted in). */
class RenderErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { reportError(error); }
  render() {
    if (!this.state.failed) return this.props.children;
    const retry = () => { if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.reload(); else this.setState({ failed: false }); };
    return <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}><MarketStatus kind="error" title="Something went wrong" message="This screen could not be shown. Please try again." action={<MarketButton label="Try again" onPress={retry} />} /></ScrollView>;
  }
}

export function MarketApplication({ businessId, audience }: { businessId: BusinessSlug; audience: AppAudience }) {
  return <RenderErrorBoundary>{audience === 'customer' ? <CustomerArea key={businessId} businessId={businessId} /> : <AdminShell key={businessId} businessId={businessId} />}</RenderErrorBoundary>;
}
