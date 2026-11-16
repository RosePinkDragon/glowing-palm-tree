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
