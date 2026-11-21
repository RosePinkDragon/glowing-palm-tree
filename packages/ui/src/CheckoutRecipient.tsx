import { Text, View } from 'react-native';
import { MarketField } from './components';
import { MarketChip } from './MarketChips';
import type { Contact, RecipientMode } from './recipient-model';
import { useMarketFonts, useMarketTheme } from './theme';

/**
 * The cart's "Delivery details" card (#187): who the order is for. "Me" (default) shows the account holder's Name and Mobile;
 * "Someone else" shows separate, empty recipient fields. Presentation only: the state lives in useCustomerCart.
 */
export function CheckoutRecipient({ mode, setMode, details, setDetails, locked }: { mode: RecipientMode; setMode: (mode: RecipientMode) => void; details: Contact; setDetails: (details: Contact) => void; locked: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const other = mode === 'other';
  return <View style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 16, gap: 12 }}>
    <Text accessibilityRole="header" aria-level={2} style={{ color: colors.muted, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, textTransform: 'uppercase', ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>Delivery details</Text>
    <View accessibilityRole="radiogroup" accessibilityLabel="Who is this order for?" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
      <MarketChip radio label="Me" selected={!other} onPress={() => { if (!locked) setMode('me'); }} />
      <MarketChip radio label="Someone else" selected={other} onPress={() => { if (!locked) setMode('other'); }} />
    </View>
    <MarketField key={mode} label={other ? 'Recipient name' : 'Name'} value={details.name} editable={!locked} onChangeText={value => setDetails({ ...details, name: value })} />
    <MarketField key={`${mode}-phone`} label={other ? 'Recipient mobile number' : 'Mobile number'} value={details.phone} editable={!locked} keyboardType="phone-pad" onChangeText={value => setDetails({ ...details, phone: value })} />
  </View>;
}
