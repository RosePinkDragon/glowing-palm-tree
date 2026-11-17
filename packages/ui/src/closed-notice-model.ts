import type { BusinessSlug } from '@market/core';

/** The closed-restaurant notice copy (#58, customer p. 28): a bold lead and a plain follow-up, per brand voice. */
export const closedParts = (slug: BusinessSlug): { lead: string; rest: string } => slug === 'ammu-sammu'
  ? { lead: 'Not taking orders right now.', rest: 'You can still look at the menu. Check back a little later.' }
  : { lead: "The kitchen isn't taking orders right now.", rest: 'Browse the menu and check back a little later.' };

/** The full sentence, used wherever the notice is read as one line (ordering errors, dish details). */
export const closedMessage = (slug: BusinessSlug) => { const { lead, rest } = closedParts(slug); return `${lead} ${rest}`; };
