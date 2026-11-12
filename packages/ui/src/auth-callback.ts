const authKeys = ['code', 'access_token', 'refresh_token', 'token_type', 'expires_in', 'expires_at', 'type', 'error', 'error_code', 'error_description'];

/** Keep the app's deployed base path while excluding callback secrets from redirect URLs. */
export function webRedirectUrl(href: string): string {
  const url = new URL(href);
  return `${url.origin}${url.pathname}`;
}

export function parseAuthCallback(href: string) {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const hasAuth = authKeys.some(key => url.searchParams.has(key) || hash.has(key));
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error_description') ?? hash.get('error_description') ?? url.searchParams.get('error') ?? hash.get('error') ?? url.searchParams.get('error_code') ?? hash.get('error_code');
  for (const key of authKeys) { url.searchParams.delete(key); hash.delete(key); }
  url.hash = hash.toString();
  return { code, error, hasAuth, cleanUrl: `${url.pathname}${url.search}${url.hash}` };
}
