import { Platform } from 'react-native';
import Svg, { Path } from 'react-native-svg';

// Shared owner icons (#116): simple 24px outline glyphs, always decorative. The text beside
// them carries the meaning, so they are hidden from assistive technology.
const paths = {
  phone: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
  pin: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  map: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z M8 2v16 M16 6v16',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0',
  check: 'M20 6L9 17l-5-5',
  close: 'M18 6L6 18 M6 6l12 12',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  work: 'M4 7h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16',
  edit: 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M10 11v6 M14 11v6',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2',
  cash: 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 10v4 M18 10v4',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35',
  back: 'M19 12H5 M12 19l-7-7 7-7',
  chevronRight: 'M9 18l6-6-6-6',
  locate: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 1v3 M12 20v3 M1 12h3 M20 12h3',
  offline: 'M1 1l22 22 M16.72 11.06A10.94 10.94 0 0 1 19 12.55 M5 12.55a10.94 10.94 0 0 1 5.17-2.39 M10.71 5.05A16 16 0 0 1 22.58 9 M1.42 9a15.91 15.91 0 0 1 4.7-2.88 M8.53 16.11a6 6 0 0 1 6.95 0 M12 20h.01',
} as const;

export type MarketIconName = keyof typeof paths;

/** Decorative line icon: always hidden from assistive tech, so the text beside it must carry the meaning. `nudge` drops it a few px to sit on the first text line; `inline` centres it on the text line when it sits inside a Text (web; native already centres inline views). */
export function MarketIcon({ name, color, size = 18, nudge = 0, inline = false }: { name: MarketIconName; color: string; size?: number; nudge?: number; inline?: boolean }) {
  const style = inline && Platform.OS === 'web' ? ({ verticalAlign: 'middle', marginTop: -2 } as object) : nudge ? { marginTop: nudge } : undefined;
  return <Svg aria-hidden accessible={false} importantForAccessibility="no" width={size} height={size} viewBox="0 0 24 24" style={style}>
    <Path d={paths[name]} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>;
}
