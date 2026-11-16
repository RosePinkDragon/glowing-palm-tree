import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { brandLogos } from './brand-logos.ts';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

test('embedded logos are byte-identical to the owner-supplied SVG files', () => {
  assert.equal(sha256(brandLogos['ammu-sammu'].xml), '467b3ed4a35ee0a38375c6bdfdf227ee117a3cb6df6bacaf4ae90dec239baf91');
  assert.equal(sha256(brandLogos['kokani-dine-inn'].xml), 'b02410d0c324fffd694b6d5ebcf3ff3fb7428624a6b01d6c81274622c3e35ec3');
});

test('each business has only its own logo with the artwork aspect ratio', () => {
  assert.deepEqual(Object.keys(brandLogos).sort(), ['ammu-sammu', 'kokani-dine-inn']);
  assert.match(brandLogos['ammu-sammu'].xml, /<title id="title">Ammu Sammu<\/title>/);
  assert.match(brandLogos['kokani-dine-inn'].xml, /<title id="title">Kokani Dine Inn/);
  for (const logo of Object.values(brandLogos)) {
    const [, , width, height] = /viewBox="(\S+) (\S+) (\S+) (\S+)"/.exec(logo.xml)!.slice(1).map(Number);
    assert.equal(logo.width / logo.height, width / height);
  }
});
