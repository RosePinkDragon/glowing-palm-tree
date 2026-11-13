import { useEffect, useState, type RefObject } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import type { createMarketServices } from '@market/services';
import { parseAuthCallback } from './auth-callback';
import { nextIdentity, sameIdentity, type Identity } from './checkout-state';

type Services = ReturnType<typeof createMarketServices>;
type Session = Awaited<ReturnType<Services['auth']['session']>>;
export function useMarketAuth(services: Services, identity: RefObject<Identity>, setError: (error: string) => void) {
  const [session, setSession] = useState<Session>(null);
  const [authReady, setAuthReady] = useState(false);
  const [identityVersion, setIdentityVersion] = useState(0);
  const [recovery, setRecovery] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    setAuthReady(false);
    if (services.mode === 'backend') {
      const started = identity.current; let authEventSeen = false;
      const applySession = (s: Session) => { const next = nextIdentity(identity.current, s?.user.id ?? null); if (next !== identity.current) { identity.current = next; setIdentityVersion(next.generation); } setSession(s); setAuthReady(true); };
      void services.auth.session().then(s => { if (active && !authEventSeen && sameIdentity(started, identity.current)) applySession(s); }).catch(e => { if (active && !authEventSeen && sameIdentity(started, identity.current)) { setError(messageOf(e)); setAuthReady(true); } });
      const unsubscribe = services.auth.onChange(async (event, s) => { if (active) { authEventSeen = true; applySession(s); if (event === 'PASSWORD_RECOVERY') setRecovery(true); } });
      const handledUrls = new Set<string>();
      const handleUrl = async (url: string) => {
        if (handledUrls.has(url)) return;
        handledUrls.add(url);
        let callback: ReturnType<typeof parseAuthCallback> | undefined;
        try {
          callback = parseAuthCallback(url);
          if (callback.error) throw new Error(`Email link could not be completed: ${callback.error}. Request a new link and try again.`);
          if (!callback.code) { if (callback.hasAuth) throw new Error('This email link is incomplete or expired. Request a new link and try again.'); return; }
          await services.auth.exchangeCodeForSession(callback.code);
          if (active) setNotice('Email link confirmed.');
        } catch (e) { if (active) setError(messageOf(e)); }
        finally {
          if (callback?.hasAuth && Platform.OS === 'web' && typeof window !== 'undefined') window.history.replaceState(window.history.state, '', callback.cleanUrl);
        }
      };
      if (Platform.OS === 'web' && typeof window !== 'undefined') void handleUrl(window.location.href);
      else void Linking.getInitialURL().then(url => { if (url) void handleUrl(url); });
      const link = Linking.addEventListener('url', ({ url }) => { void handleUrl(url); });
      return () => { active = false; link.remove(); unsubscribe(); services.dispose(); };
    }
    setAuthReady(true);
    return () => { active = false; services.dispose(); };
  }, [services, identity, setError]);
  return { session, authReady, identityVersion, recovery, setRecovery, notice, setNotice };
}
function messageOf(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
