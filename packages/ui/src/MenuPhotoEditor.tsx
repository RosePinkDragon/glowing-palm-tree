import { useEffect, useRef, useState } from 'react';
import { Image, Platform, View } from 'react-native';
import { getDocumentAsync, type DocumentPickerAsset } from 'expo-document-picker';
import type { MenuItem } from '@market/core';
import type { MarketServices } from '@market/services';
import { AccessiblePanel } from './AccessiblePanel';
import { MarketButton, MarketStatus, MarketText } from './components';
import { useMarketTheme } from './theme';

export function MenuPhotoEditor({ item, services, onSaved, onClose }: {
  item: MenuItem; services: MarketServices; onSaved: (message: string) => Promise<void>; onClose: () => void;
}) {
  const { colors } = useMarketTheme();
  const [selected, setSelected] = useState<DocumentPickerAsset | null>(null);
  const [preview, setPreview] = useState<string | undefined>(item.imageUrl);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!selected) { setPreview(item.imageUrl); return; }
    const uri = Platform.OS === 'web' && selected.file ? URL.createObjectURL(selected.file) : selected.uri;
    setPreview(uri); setBroken(false);
    return () => { if (uri.startsWith('blob:')) URL.revokeObjectURL(uri); };
  }, [selected, item.imageUrl]);
  const choose = async () => {
    if (active.current) return;
    setError('');
    try {
      const result = await getDocumentAsync({ type: ['image/jpeg', 'image/png', 'image/webp'], multiple: false, copyToCacheDirectory: true, base64: false });
      if (result.canceled) return;
      const asset = result.assets[0];
      if ((asset.size ?? asset.file?.size ?? 0) > 5 * 1024 * 1024) { setError('Choose a photo up to 5 MB.'); return; }
      setSelected(asset);
    } catch { setError('The photo picker could not open. Please try again.'); }
  };
  const save = async (remove = false) => {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    let sent = false;
    try {
      let bytes: ArrayBuffer | undefined;
      if (!remove) {
        if (!selected) throw new Error('Choose a photo first.');
        if (Platform.OS === 'web') {
          if (!selected.file) throw new Error('Choose this photo again.');
          bytes = await selected.file.arrayBuffer();
        } else {
          const { File } = await import('expo-file-system');
          bytes = await new File(selected.uri).arrayBuffer();
        }
        if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) throw new Error('Choose a photo up to 5 MB.');
      }
      sent = true;
      const result = remove ? await services.removeMenuPhoto(item) : await services.uploadMenuPhoto(item, bytes!);
      await onSaved(`${remove ? 'Photo removed.' : 'Photo saved.'}${result.cleanupComplete ? '' : ' Old photos are queued for cleanup; use Retry photo cleanup.'}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The photo could not be saved.');
      // A lost HTTP response may follow a successful attachment. Require a fresh
      // dish snapshot before retrying, preserving optimistic concurrency.
      setUncertain(sent);
    } finally { active.current = false; setBusy(false); }
  };
  return <AccessiblePanel title={`Photo for ${item.name}`} onClose={() => { if (!busy) onClose(); }}>
    <View style={{ height: 200, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' }}>
      {preview && !broken ? <Image accessibilityLabel={item.name} source={{ uri: preview }} onError={() => setBroken(true)} style={{ width: '100%', height: '100%' }} resizeMode="contain" /> : <MarketText variant="muted">No photo</MarketText>}
    </View>
    <MarketText variant="muted">Use your restaurant’s own JPEG, PNG or WebP, up to 5 MB and 16 megapixels. Photos are checked and resized before saving.</MarketText>
    {selected ? <MarketText>Selected: {selected.name}</MarketText> : null}
    {error ? <MarketStatus kind="error" title="Could not save photo" message={error} /> : null}
    {uncertain ? <><MarketText>Reload the dish to check its current photo before trying again.</MarketText><MarketButton label="Reload dish photo" disabled={busy} onPress={() => { void onSaved('Current photo reloaded.').then(onClose).catch(() => setError('Could not reload the menu. Close and retry loading it.')); }} /></> : <>
      <MarketButton label={selected || item.imageUrl ? 'Choose another photo' : 'Choose photo'} variant="secondary" disabled={busy} onPress={() => void choose()} />
      <MarketButton label={busy ? 'Saving photo…' : item.imageUrl ? 'Replace photo' : 'Upload photo'} disabled={busy || !selected} onPress={() => void save()} />
      {item.imageUrl ? <MarketButton label="Remove photo" variant="secondary" disabled={busy} onPress={() => void save(true)} /> : null}
    </>}
    <MarketButton label={busy ? 'Please wait…' : 'Close photo editor'} variant="secondary" disabled={busy} onPress={onClose} />
  </AccessiblePanel>;
}
