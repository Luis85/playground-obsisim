import { describe, expect, it } from 'vitest';
import type { RecipeDef } from '../../src/shared/content-types';
import { InputBuffer } from '../../src/engine/components';
import { RESOURCE_IDS } from '../../src/engine/content';

describe('InputBuffer.shortestOf', () => {
  it('picks the input the building is proportionally shortest of, not simply the smallest amount held', () => {
    // wheat: 4 held against 7 wanted -> ratio 4/7 ~= 0.571.
    // wood: 9 held against 100 wanted -> ratio 9/100 = 0.09, the smaller ratio.
    // wheat holds the smaller ABSOLUTE amount (4 < 9); wood is the one the
    // recipe is proportionally shortest of. A `shortestOf` that compared held
    // amounts instead of ratios against `recipe.inputs` would pick wheat here
    // — the two answers disagree, so this fixture actually exercises the
    // ratio, not just whichever pile happens to be smaller.
    const buffer = new InputBuffer();
    buffer.add('wheat', 4);
    buffer.add('wood', 9);
    const recipe: RecipeDef = { inputs: { wheat: 7, wood: 100 }, outputs: {}, ticksPerBatch: 1 };
    expect(buffer.shortestOf(recipe, RESOURCE_IDS)).toBe('wood');
  });

  it('breaks a tied ratio by catalog order, not by insertion order', () => {
    // Both wanted 12, both held 3 -> ratio 0.25 apiece: a genuine tie. Wood is
    // added first (so Map insertion order would favor it) but wheat comes
    // first in RESOURCE_IDS and must win instead.
    const buffer = new InputBuffer();
    buffer.add('wood', 3);
    buffer.add('wheat', 3);
    expect([...buffer.amounts.keys()]).toEqual(['wood', 'wheat']); // the order the tie must NOT follow
    const recipe: RecipeDef = { inputs: { wheat: 12, wood: 12 }, outputs: {}, ticksPerBatch: 1 };
    expect(buffer.shortestOf(recipe, RESOURCE_IDS)).toBe('wheat');
  });
});
