import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { formatINRFromPaise, type MenuItem } from '@market/core';
import type { MarketServices } from '@market/services';
import { MarketButton, MarketCard, MarketField, MarketStatus, MarketText } from './components';
import { parseRupees, rupeesInput } from './admin-model';

type Draft = { id?: string; name: string; description: string; category: string; price: string; isAvailable: boolean; isDemo: boolean };
const blank = (): Draft => ({ name: '', description: '', category: '', price: '', isAvailable: true, isDemo: false });
const message = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
export function AdminMenu({ services }: { services: MarketServices }) {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [remove, setRemove] = useState<MenuItem | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState(false);
  const load = async () => { try { setItems(await services.getMenu()); setError(''); } catch (e) { setError(message(e)); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, [services]);
  const save = async () => {
    if (!draft) return;
    const pricePaise = parseRupees(draft.price);
    if (!draft.name.trim() || !draft.category.trim() || pricePaise === null) { setValidation(true); return; }
    setBusy(true); setError('');
    try { await services.saveMenuItem({ id: draft.id, name: draft.name.trim(), description: draft.description.trim(), category: draft.category.trim(), pricePaise, isAvailable: draft.isAvailable, isDemo: draft.isDemo }); setDraft(null); await load(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const deleteItem = async () => {
    if (!remove) return;
    setBusy(true); setError('');
    try { await services.deleteMenuItem(remove.id); setRemove(null); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <View style={{ gap: 16 }}>
    <MarketText variant="heading">Menu</MarketText>
    <MarketText variant="muted">Manage availability and prices. Sample items are clearly labelled.</MarketText>
    {services.mode === 'demo' ? <MarketText>Sample mode: connect the backend to make menu changes.</MarketText> : null}
    {error ? <MarketStatus kind="error" title="Could not complete the request" message={error} action={<MarketButton label="Retry loading menu" variant="secondary" onPress={() => void load()} />} /> : null}
    {loading ? <MarketStatus kind="loading" title="Loading menu" /> : null}
    {draft ? <MarketCard>
      <MarketText variant="heading">{draft.id ? 'Edit item' : 'Add item'}</MarketText>
      <MarketField label="Name" value={draft.name} onChangeText={name => setDraft({ ...draft, name })} error={validation && !draft.name.trim() ? 'Enter a name.' : undefined} />
      <MarketField label="Category" value={draft.category} onChangeText={category => setDraft({ ...draft, category })} error={validation && !draft.category.trim() ? 'Enter a category.' : undefined} />
      <MarketField label="Description" value={draft.description} onChangeText={description => setDraft({ ...draft, description })} multiline />
      <MarketField label="Price in rupees" value={draft.price} onChangeText={price => setDraft({ ...draft, price })} keyboardType="decimal-pad" error={validation && parseRupees(draft.price) === null ? 'Enter a non-negative amount with up to two decimal places.' : undefined} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><MarketText>Available</MarketText><Switch accessibilityLabel="Available" value={draft.isAvailable} onValueChange={isAvailable => setDraft({ ...draft, isAvailable })} /></View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><MarketText>Sample item</MarketText><Switch accessibilityLabel="Sample item" value={draft.isDemo} onValueChange={isDemo => setDraft({ ...draft, isDemo })} /></View>
      <MarketButton label={busy ? 'Saving…' : 'Save item'} onPress={() => void save()} disabled={busy || services.mode === 'demo'} />
      <MarketButton label="Cancel" variant="secondary" onPress={() => setDraft(null)} disabled={busy} />
    </MarketCard> : <MarketButton label="Add item" onPress={() => { setValidation(false); setDraft(blank()); }} disabled={services.mode === 'demo'} />}
    {remove ? <MarketCard><MarketText variant="heading">Delete {remove.name}?</MarketText><MarketText>This removes the item from the menu.</MarketText><MarketButton label={busy ? 'Deleting…' : 'Confirm delete'} onPress={() => void deleteItem()} disabled={busy} /><MarketButton label="Keep item" variant="secondary" onPress={() => setRemove(null)} disabled={busy} /></MarketCard> : null}
    {!loading && !items.length && !error ? <MarketStatus kind="empty" title="No menu items yet" message="Add an item to get started." /> : null}
    {items.map(item => <MarketCard key={item.id}><MarketText variant="heading">{item.name}</MarketText><MarketText>{item.category} · {formatINRFromPaise(item.pricePaise)}</MarketText><MarketText variant="muted">{item.isAvailable ? 'Available' : 'Unavailable'}{item.isDemo ? ' · Sample item' : ''}</MarketText>{item.description ? <MarketText>{item.description}</MarketText> : null}<MarketButton label={`Edit ${item.name}`} variant="secondary" disabled={services.mode === 'demo' || busy} onPress={() => { setValidation(false); setDraft({ ...item, price: rupeesInput(item.pricePaise) }); }} /><MarketButton label={`Delete ${item.name}`} variant="secondary" disabled={services.mode === 'demo' || busy} onPress={() => setRemove(item)} /></MarketCard>)}
  </View>;
}
