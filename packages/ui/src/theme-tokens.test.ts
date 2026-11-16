import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, marketThemes } from './theme-tokens.ts';

test('contrast ratio follows WCAG', () => {
  assert.equal(contrastRatio('#FFFFFF', '#000000'), 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.ok(Math.abs(contrastRatio('#2E7D32', '#FFFFFF') - 5.13) < 0.01);
});

test('both restaurant themes give switches visible on/off states (WCAG 1.4.11, 3:1)', () => {
  for (const theme of Object.values(marketThemes)) {
    const { switchOn, switchOff, surface, background } = theme.colors;
    for (const ground of [surface, background]) {
      assert.ok(contrastRatio(switchOn, ground) >= 3, `${theme.name}: on track vs ${ground}`);
      assert.ok(contrastRatio(switchOff, ground) >= 3, `${theme.name}: off track vs ${ground}`);
    }
    assert.ok(contrastRatio(surface, switchOn) >= 3 && contrastRatio(surface, switchOff) >= 3, `${theme.name}: thumb vs track`);
    assert.equal(switchOn, marketThemes['ammu-sammu'].colors.switchOn, 'the approved green is the same in both brands');
  }
});

test('pill and chip text stays readable on its background in both themes (WCAG 1.4.3, 4.5:1)', () => {
  for (const theme of Object.values(marketThemes)) {
    const c = theme.colors;
    const pairs: [string, string, string][] = [
      ['brand pill', c.primary, c.tint], ['positive pill', c.positive, c.positiveTint], ['neutral pill', c.ink, c.neutralTint],
      ['quiet pill', c.muted, c.neutralTint], ['outline pill', c.muted, c.surface], ['danger pill', c.danger, c.background],
      ['warning banner', c.warning, c.warningTint], ['warning banner body', c.ink, c.warningTint],
      ['selected chip', c.surface, c.ink], ['chip', c.ink, c.surface], ['chip count', c.primary, c.tint], ['selected chip count', c.onPrimary, c.primary],
    ];
    for (const [name, text, ground] of pairs) assert.ok(contrastRatio(text, ground) >= 4.5, `${theme.name}: ${name} ${text} on ${ground} = ${contrastRatio(text, ground).toFixed(2)}`);
  }
});
