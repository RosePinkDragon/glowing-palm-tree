import type { Pending, Ports } from './finish.ts';

export type Config = { supabaseUrl: string; serviceKey: string; fetch?: typeof fetch; log?: (line: string) => void };

// Real ports over Supabase's REST and Auth admin endpoints. Errors carry fixed words only, never a response body or a header.
export function makePorts(config: Config): Ports {
  const supabase = config.supabaseUrl.replace(/\/+$/, '');
  const key = config.serviceKey;
  const doFetch = config.fetch ?? fetch;
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const timed = (url: string, init: RequestInit) => doFetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  async function rpc(name: string, payload: object): Promise<unknown> {
    if (!supabase || !key) throw new Error('not configured');
    const res = await timed(`${supabase}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!res.ok) { await res.body?.cancel(); throw new Error('database unavailable'); }
    return await res.json();
  }
  return {
    list: async (limit) => {
      const rows = await rpc('list_accounts_pending_auth_deletion', { p_limit: limit });
      if (!Array.isArray(rows)) throw new Error('unexpected list result');
      return rows.map((r): Pending => ({ customerId: String(r?.customer_id ?? ''), requestedAt: typeof r?.requested_at === 'string' ? r.requested_at : null }));
    },
    prepare: async (id) => {
      const state = await rpc('prepare_account_auth_deletion', { p_customer_id: id });
      if (state !== 'pending' && state !== 'gone' && state !== 'not_pending') throw new Error('unexpected prepare result');
      return state;
    },
    // The Auth admin API (what auth.admin.deleteUser calls). A user that is already gone is the goal, not a failure.
    deleteAuthUser: async (id) => {
      if (!supabase || !key) throw new Error('not configured');
      const res = await timed(`${supabase}/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', headers, body: JSON.stringify({ should_soft_delete: false }) });
      await res.body?.cancel();
      if (res.status === 404) return 'not_found';
      if (!res.ok) throw new Error('auth refused');
      return 'deleted';
    },
    complete: async (id, requestedAt) => (await rpc('complete_account_auth_deletion', { p_customer_id: id, p_requested_at: requestedAt })) === true,
    log: config.log ?? ((line) => console.error(line)),
  };
}
