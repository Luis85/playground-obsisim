import { describe, expect, it } from 'vitest';
import type { RecipeDef } from '../../src/shared/content-types';
import { HaulTrip, InputBuffer } from '../../src/engine/components';
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

describe('HaulTrip (transfer)', () => {
  it('a transfer trip carries its whole intent in components', () => {
    // Every number below is pairwise distinct, so a field that read a
    // neighbour's value instead of its own could not pass by accident.
    const trip = new HaulTrip();
    trip.kind = 'transfer';
    trip.resource = 'wheat';
    trip.sourceSiteId = 3;
    trip.destSiteId = 8;
    trip.plannedAmount = 15;
    trip.staging = true;

    expect(trip.kind).toBe('transfer');
    expect(trip.resource).toBe('wheat');
    expect(trip.sourceSiteId).toBe(3);
    expect(trip.destSiteId).toBe(8);
    expect(trip.plannedAmount).toBe(15);
    expect(trip.staging).toBe(true);
    // A transfer never has a building target — targetId stays null for its
    // whole life, never set by hand above and never defaulted to anything else.
    expect(trip.targetId).toBeNull();
  });

  it('cancel() clears the staging flag', () => {
    // DISCRIMINATING: a `clearTrip` that omits `staging` passes every other
    // test in this suite, and the symptom would be a silently inflated
    // transfersStaging count once §4.2's measurement reads it back.
    const trip = new HaulTrip();
    trip.kind = 'transfer';
    trip.staging = true;

    trip.cancel();

    expect(trip.staging).toBe(false);
  });

  it('cancel() brings a transfer to a stop where it is standing', () => {
    // legPositionOf — the shared law every kind's cancellation goes through,
    // not a new branch for transfer. (2,0) to (19,0) is 17 ticks at 1
    // tile/tick; released with 6 of those left, the hauler is 11/17 of the
    // way along, which lands on tile (13, 0) — strictly between the two
    // endpoints and not equal to either.
    const trip = new HaulTrip();
    trip.kind = 'transfer';
    trip.startLeg('outbound', { col: 2, row: 0 }, { col: 19, row: 0 }, 1);
    expect(trip.legTicks).toBe(17);
    trip.ticksLeft = 6;

    trip.cancel();

    expect(trip.phase).toBe('idle');
    expect(trip.atCol).toBeCloseTo(13, 10);
    expect(trip.atRow).toBeCloseTo(0, 10);
    expect(trip.atCol).toBeGreaterThan(2);
    expect(trip.atCol).toBeLessThan(19);
  });
});
