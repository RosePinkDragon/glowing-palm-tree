import { useEffect, useRef, useState } from 'react';
import type { CartLine, DeliveryDetails, LocationFix, Order } from '@market/core';
/** Lives above screen mounts. Guest-to-login preserves drafts; leaving an identity clears private delivery data. */
export function useCustomerCart(userId: string | null) {
  const previousUser = useRef(userId);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [details, setDetails] = useState<DeliveryDetails>({ name: '', phone: '', addressLine: '' });
  const [location, setLocation] = useState<LocationFix | null>(null);
  const [eligible, setEligible] = useState(false);
  const [receiptState, setReceiptState] = useState<{ userId: string | null; order: Order | null }>({ userId, order: null });
  const setReceipt = (order: Order | null) => setReceiptState({ userId, order });
  useEffect(() => {
    if (previousUser.current && previousUser.current !== userId) { setReceipt(null); setDetails({ name: '', phone: '', addressLine: '' }); setLocation(null); setEligible(false); }
    previousUser.current = userId;
  }, [userId]);
  return { cart, setCart, details, setDetails, location, setLocation, eligible, setEligible, receipt: userId && receiptState.userId === userId ? receiptState.order : null, setReceipt };
}
