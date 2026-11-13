const authKeys = ['code', 'access_token', 'refresh_token', 'token_type', 'expires_in', 'expires_at', 'type', 'error', 'error_code', 'error_description'];

/** Keep the app's deployed base path while excluding callback secrets from redirect URLs. */
export function webRedirectUrl(href: string): string {
  const url = new URL(href);
  const next = url.searchParams.get('next');
  const allowed = next && /^\/(?:cart|account|orders(?:\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})?)$/.test(next);
  return `${url.origin}${url.pathname}${allowed ? `?next=${encodeURIComponent(next)}` : ''}`;
}

export function parseAuthCallback(href: string) {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const hasAuth = authKeys.some(key => key !== 'type' && (url.searchParams.has(key) || hash.has(key)));
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error_description') ?? hash.get('error_description') ?? url.searchParams.get('error') ?? hash.get('error') ?? url.searchParams.get('error_code') ?? hash.get('error_code');
  if (hasAuth) {
    for (const key of authKeys) { url.searchParams.delete(key); hash.delete(key); }
    url.hash = hash.toString();
  }
  return { code, error, hasAuth, cleanUrl: `${url.pathname}${url.search}${url.hash}` };
}
