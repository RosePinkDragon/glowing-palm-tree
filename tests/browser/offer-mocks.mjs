// Default mocks for the two offer RPCs (#182 slice C). `json` is the suite's own responder, `json(value)`.
// Returns the fulfilled response for an offer RPC, or null so the caller keeps routing.
export const offerRpcMock = (url, json) => {
  if (url.pathname === '/rest/v1/rpc/list_active_offers') return json([]);
  if (url.pathname === '/rest/v1/rpc/quote_order') return json({ outcome: 'quoted', pricing: null, offer_error: null, nudge: null });
  return null;
};
