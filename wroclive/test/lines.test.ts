import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LINE_COLOR } from '../src/lib/lines.ts';

/**
 * Invariant 11: line colours carry white text and must clear WCAG AA (4.5:1).
 *
 * The original palette put white on `#F8E71C` at roughly 1.4:1 — illegible in
 * the sunlight you are standing in at a stop. `server/test/map.test.js` already
 * compares this table against the browser map's copy, but a comparison only
 * proves the two agree; it cannot tell you both are wrong. This computes the
 * ratio, so a new colour is checked rather than merely matched.
 */

const WCAG_AA = 4.5;

/** Relative luminance per WCAG 2.1. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Contrast of white text on `hex`. */
const contrastOnWhite = (hex: string): number => 1.05 / (luminance(hex) + 0.05);

describe('LINE_COLOR', () => {
  it('is a table of six-digit hex colours', () => {
    const entries = Object.entries(LINE_COLOR);
    assert.ok(entries.length > 5, `only ${entries.length} colours parsed`);
    for (const [name, value] of entries) {
      assert.match(value, /^#[0-9A-Fa-f]{6}$/, `${name} is ${value}`);
    }
  });

  it('clears 4.5:1 against white text', () => {
    const failures = Object.entries(LINE_COLOR)
      .map(([name, value]) => [name, value, contrastOnWhite(value)] as const)
      .filter(([, , ratio]) => ratio < WCAG_AA)
      .map(([name, value, ratio]) => `${name} (${value}) at ${ratio.toFixed(2)}:1`);

    assert.deepEqual(failures, [], `below ${WCAG_AA}:1 with white text`);
  });

  it('rejects the pre-2026 yellow that started this rule', () => {
    // Guards the check itself: if this passes, the computation is not measuring
    // anything.
    assert.ok(contrastOnWhite('#F8E71C') < WCAG_AA);
    assert.ok(
      !Object.values(LINE_COLOR).includes('#F8E71C'),
      'the illegible yellow is back in the palette',
    );
  });
});
