import type { CartLine } from '@market/core';

export type Removal = { line: CartLine; index: number };

/** The one dish whose last unit a cart change took away, or null (several lines, a bigger quantity or an unavailable dish are not undoable). */
export function soleRemoval(before: readonly CartLine[], after: readonly CartLine[]): Removal | null {
  const kept = new Set(after.map(line => line.item.id));
  const gone = before.map((line, index) => ({ line, index })).filter(entry => !kept.has(entry.line.item.id));
  return gone.length === 1 && gone[0].line.quantity === 1 && gone[0].line.item.isAvailable ? gone[0] : null;
}

/** Put a removed dish back where it was, keeping any dish already in the cart as it is now. */
export function restoreLine(lines: readonly CartLine[], line: CartLine, index: number): CartLine[] {
  if (lines.some(current => current.item.id === line.item.id)) return [...lines];
  const at = Math.min(index, lines.length);
  return [...lines.slice(0, at), line, ...lines.slice(at)];
}
