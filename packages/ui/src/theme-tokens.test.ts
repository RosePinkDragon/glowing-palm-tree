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
      ['brand pill', c.primary, c.tint], ['info pill (Accepted)', c.info, c.infoTint], ['positive pill', c.positive, c.positiveTint], ['neutral pill', c.ink, c.neutralTint],
      ['quiet pill', c.muted, c.neutralTint], ['outline pill', c.muted, c.surface], ['danger pill', c.danger, c.background],
      ['selected chip', c.surface, c.ink], ['chip', c.ink, c.surface], ['chip count', c.primary, c.tint], ['selected chip count', c.onPrimary, c.primary],
    ];
    for (const [name, text, ground] of pairs) assert.ok(contrastRatio(text, ground) >= 4.5, `${theme.name}: ${name} ${text} on ${ground} = ${contrastRatio(text, ground).toFixed(2)}`);
  }
});

test('the amber paused banner keeps its title and body readable in both themes (WCAG 1.4.3, 4.5:1)', () => {
  for (const theme of Object.values(marketThemes)) {
    const c = theme.colors;
    for (const [name, text] of [['title', c.warning], ['body', c.ink]] as const) assert.ok(contrastRatio(text, c.warningTint) >= 4.5, `${theme.name}: banner ${name} ${text} on ${c.warningTint}`);
  }
});

test('the order status band keeps its text readable in both themes (WCAG 1.4.3, 4.5:1)', () => {
  for (const theme of Object.values(marketThemes)) {
    const c = theme.colors;
    for (const [name, text, ground] of [['eyebrow', c.bandAccent, c.band], ['headline and detail', c.onPrimary, c.band], ['cancelled eyebrow', c.bandMutedAccent, c.bandMuted], ['cancelled headline', c.onPrimary, c.bandMuted],
      ['updates title', c.ink, c.updatesTint], ['updates detail', c.muted, c.updatesTint], ['warning pill', c.warning, c.warningTint]] as const) assert.ok(contrastRatio(text, ground) >= 4.5, `${theme.name}: ${name} ${text} on ${ground}`);
    assert.ok(contrastRatio(c.updatesIcon, c.updatesTint) >= 3, `${theme.name}: updates bell`);
  }
});

test('the closed-restaurant notice keeps its text readable in both themes (WCAG 1.4.3, 4.5:1)', () => {
  for (const theme of Object.values(marketThemes)) {
    const c = theme.colors;
    assert.ok(contrastRatio(c.onNotice, c.notice) >= 4.5, `${theme.name}: notice ${c.onNotice} on ${c.notice}`);
  }
});

test('owners shell (#53): header, chips on the dark header, bands and page keep text readable in both themes', () => {
  for (const theme of Object.values(marketThemes)) {
    const c = theme.colors;
    const text: [string, string, string][] = [
      ['header title', c.onOwnerHeader, c.ownerHeader], ['open band', c.onOpenBand, c.openBand], ['closed band', c.onClosedBand, c.closedBand],
      ['page muted text', c.muted, c.page], ['page ink', c.ink, c.page], ['login heading', c.background, c.loginHero],
      ['filled OWNERS badge', c.onPrimary, c.primary], ['error on open band', c.danger, c.openBand], ['error on closed band', c.onClosedBand, c.closedBand],
      ...(theme.ownerHeader === 'dark' ? [['selected chip on gold', c.ownerHeader, c.accent], ['dark chip', c.onOwnerHeader, c.ownerHeader]] as [string, string, string][] : []),
    ];
    for (const [name, fg, bg] of text) assert.ok(contrastRatio(fg, bg) >= 4.5, `${theme.name}: ${name} ${fg} on ${bg} = ${contrastRatio(fg, bg).toFixed(2)}`);
    const graphics: [string, string, string][] = [
      ['switch on open band', c.switchOn, c.openBand], ['switch off on closed band', c.switchOff, c.closedBand], ['thumb on off track', c.surface, c.switchOff],
      ...(theme.ownerHeader === 'dark' ? [['gold outline on header', c.accent, c.ownerHeader] as [string, string, string]] : []),
    ];
    for (const [name, fg, bg] of graphics) assert.ok(contrastRatio(fg, bg) >= 3, `${theme.name}: ${name} ${contrastRatio(fg, bg).toFixed(2)}`);
    assert.ok(contrastRatio(c.page, c.ownerHeader) > 1, `${theme.name}: page differs from header`);
    assert.notEqual(c.page, c.surface);
  }
  assert.equal(marketThemes['kokani-dine-inn'].ownerHeader, 'dark');
  assert.equal(marketThemes['ammu-sammu'].ownerHeader, 'light');
});
