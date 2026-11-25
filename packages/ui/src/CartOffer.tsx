import { useCallback, useEffect, useRef, useState } from 'react';
import { formatINRFromPaise, type CartLine } from '@market/core';
import { Pressable, Text, View } from 'react-native';
import type { ActiveOffer, OfferError, OfferNudge, OrderQuote, PricingTerms } from '@market/services';
import { MarketButton, MarketField } from './components';
import { MarketIcon } from './MarketIcons';
import { bannerText, nudgeText, offerChangedMessage, offerErrorMessage } from './offer-model';
import { useMarketFonts, useMarketTheme } from './theme';

/** A small strip with the restaurant's active automatic offer, for signed-out visitors (top of the menu and in the cart). */
export function OfferBanner({ offers }: { offers: readonly ActiveOffer[] }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const text = bannerText(offers);
  if (!text) return null;
  return <View role="status" accessibilityLabel={`Offer: ${text}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14, backgroundColor: colors.tint, borderWidth: 1, borderColor: colors.border }}>
    <MarketIcon name="check" color={colors.primary} size={16} />
    <Text style={{ flex: 1, color: colors.ink, fontSize: 15, lineHeight: 22, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{text}</Text>
  </View>;
}

export type CartOfferProps = {
  signedIn: boolean; offers: readonly ActiveOffer[]; pricing: PricingTerms | null; nudge: OfferNudge | null;
  code: string | null; message: string; applying: boolean; disabled: boolean;
  onApply: (code: string) => void; onRemove: () => void; onSignIn: () => void;
};

/**
 * The cart's offer row (#182): the offer that applies with its saving, a removable code, a "Have a code?" entry, the server's nudge
 * and the reason a code was refused. Signed out: the banner and "Sign in to apply", with no code entry. Presentation only: the server prices.
 */
export function CartOffer(p: CartOfferProps) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const [open, setOpen] = useState(false), [entry, setEntry] = useState('');
  useEffect(() => { if (p.code) { setOpen(false); setEntry(''); } }, [p.code]);
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const body = { color: colors.ink, fontSize: 15, lineHeight: 22 };
  const applied = p.signedIn ? p.pricing?.offer : undefined;
  const link = (label: string, onPress: () => void, name = label) => <Pressable accessibilityRole="button" accessibilityLabel={name} disabled={p.disabled} onPress={onPress} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: colors.primary, fontSize: 15, ...bold }}>{label}</Text></Pressable>;
  const card = { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 16, gap: 8 };
  if (!p.signedIn) {
    if (!p.offers.length) return null;
    return <View style={card}><OfferBanner offers={p.offers} />{link('Sign in to apply', p.onSignIn)}</View>;
  }
  return <View style={card}>
    {applied ? <View style={{ gap: 4 }}>
      <Text role="status" style={{ ...body, ...bold }}>{`Offer applied: ${applied.name}`}</Text>
      <Text style={{ color: colors.primary, fontSize: 14, lineHeight: 20, ...bold }}>{`Saves ${formatINRFromPaise(p.pricing?.discount_paise ?? 0)}`}</Text>
      {applied.code ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.muted, fontSize: 14 }}>{`Code ${applied.code}`}</Text>{link('Remove', p.onRemove, `Remove code ${applied.code}`)}
      </View> : null}
    </View> : null}
    {p.nudge ? <Text style={{ color: colors.primary, fontSize: 14, lineHeight: 20, ...bold }}>{nudgeText(p.nudge)}</Text> : null}
    {!open ? link('Have a code?', () => setOpen(true)) : <View style={{ gap: 8 }}>
      <MarketField label="Offer code" value={entry} autoCapitalize="characters" autoCorrect={false} maxLength={15} editable={!p.disabled && !p.applying} onChangeText={setEntry} onSubmitEditing={() => p.onApply(entry)} />
      <MarketButton label={p.applying ? 'Checking…' : 'Apply'} disabled={p.disabled || p.applying || !entry.trim()} onPress={() => p.onApply(entry)} />
    </View>}
    {p.message ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 15, lineHeight: 22 }}>{p.message}</Text> : null}
  </View>;
}


type OfferServices = { quoteOrder(lines: readonly CartLine[], code?: string | null): Promise<OrderQuote>; listActiveOffers(): Promise<ActiveOffer[]> };
type Held = { signature: string; code: string | null; quote: OrderQuote | null };
const debounceMs = 350;

/**
 * The server's pricing for the cart (#182). Signed in with items, the cart is quoted (debounced) with the applied code, and the discount,
 * offer and nudge come from that quote. A code the server refuses is dropped at once and never sent again: every rejected lookup counts toward
 * the customer's 10-per-10-minutes limit, so a cart that kept re-quoting a bad code would lock them out of all codes. Signed out, only the
 * public list of automatic offers is read. Nothing here places an order.
 */
export function useOfferQuote(p: { services: OfferServices; quoting: boolean; listing: boolean; lines: CartLine[]; signature: string; identityKey: string }) {
  const { services, quoting, listing, lines, signature, identityKey } = p;
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [held, setHeld] = useState<Held | null>(null);
  const [applying, setApplying] = useState(false);
  const [active, setActive] = useState<ActiveOffer[]>([]);
  const latest = useRef({ lines, signature, held, code }); latest.current = { lines, signature, held, code };
  const seq = useRef(0);

  useEffect(() => { seq.current++; setCode(null); setMessage(''); setHeld(null); }, [identityKey]);
  useEffect(() => {
    if (!listing) { setActive([]); return; }
    let live = true;
    services.listActiveOffers().then(offers => { if (live) setActive(offers); }).catch(() => { if (live) setActive([]); });
    return () => { live = false; };
  }, [services, listing, identityKey]);
  useEffect(() => {
    const id = ++seq.current;
    if (!quoting) { setHeld(null); return; }
    const have = latest.current.held;
    if (have && have.signature === signature && have.code === code && have.quote) return; // already priced for exactly this
    const timer = setTimeout(() => {
      services.quoteOrder(latest.current.lines, code).then(quote => {
        if (id !== seq.current) return;
        if (quote.offerError) { setCode(null); setMessage(offerErrorMessage(quote.offerError)); setHeld({ signature, code: null, quote }); } // the quote is already priced without the code
        else setHeld({ signature, code, quote });
      }).catch(() => { if (id === seq.current) setHeld({ signature, code, quote: null }); });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [services, quoting, signature, code]);

  /** One call both checks the code and prices the cart with it (so a minimum order is reported with its shortfall). */
  const apply = useCallback(async (raw: string) => {
    const entered = raw.trim().toUpperCase();
    if (!entered) { setMessage('Enter a code'); return; }
    const at = latest.current.signature; setApplying(true); setMessage('');
    try {
      const quote = await services.quoteOrder(latest.current.lines, entered);
      if (quote.offerError) { setMessage(offerErrorMessage(quote.offerError)); setHeld({ signature: at, code: null, quote }); }
      else { setCode(entered); setHeld({ signature: at, code: entered, quote }); }
    } catch { setMessage('Could not check the code. Try again.'); } finally { setApplying(false); }
  }, [services]);
  const remove = useCallback(() => { setCode(null); setMessage(''); }, []);
  /** place_order refused the quoted offer: nothing was ordered. Drop the code, show why with the repriced total, and wait for another tap. */
  const rejected = useCallback((e: OfferError) => {
    seq.current++; setCode(null);
    setMessage(offerChangedMessage(e, e.pricing?.total_paise ?? null));
    if (e.pricing) setHeld({ signature: latest.current.signature, code: null, quote: { pricing: e.pricing, offerError: null, nudge: null } });
  }, []);

  const current = held && held.signature === signature && held.code === code ? held : null;
  return {
    code, message, applying, active, apply, remove, rejected,
    /** The server's quote for this cart and code, or null while it is being fetched (or when it could not be). */
    quote: quoting ? current?.quote ?? null : null,
    /** A quote is on its way: the cart is not priced yet, so ordering waits. */
    pending: quoting && !current,
    /** The quote call failed: without a code the cart falls back to its own prices (the server revises them if an offer applies). */
    failed: quoting && !!current && !current.quote,
  };
}
