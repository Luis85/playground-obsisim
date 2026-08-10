import { describe, expect, it } from 'vitest';
import { cheapestHaulerToRelease } from '../../../src/engine/systems/command-handlers';
import type { WorkerRow } from '../../../src/engine/systems/command-handlers';
import { HaulTrip, Home, JobAssignment } from '../../../src/engine/components';
import type { HaulKind, HaulPhase } from '../../../src/engine/components';

// The removal rule OBS-4-08 asked for, unit-tested directly: the integration
// test in command-system.test.ts pins the headline case (idle over loaded) but
// cannot distinguish the carrying term from the ticksLeft tiebreak, because an
// idle hauler has ticksLeft 0 and so wins on either rule.
//
// Since Task 8 the term is `trip.amount` rather than the phase. Every fixture
// below therefore states an amount, and the phase and kind are chosen to
// DISAGREE with it wherever the two could be confused — a `supply`/`outbound`
// trip holding 0 is exactly the drained-source hauler a kind- or phase-based
// ranking would misfile as loaded.

let nextId = 1;
function hauler(phase: HaulPhase, ticksLeft: number, amount: number, kind: HaulKind = 'collect', hauling = true): WorkerRow & { id: number } {
  // stage and home are both irrelevant to release cost (amount/ticksLeft
  // only) — 'adult' and a fresh, homeless Home() are valid, arbitrary
  // fixture values, not a case this file is testing.
  return {
    id: nextId++, job: new JobAssignment(null, hauling),
    trip: new HaulTrip(phase, kind, null, ticksLeft, amount > 0 ? 'wheat' : null, amount),
    home: new Home(), stage: 'adult',
  };
}

describe('cheapestHaulerToRelease', () => {
  it('returns undefined when nobody is hauling', () => {
    expect(cheapestHaulerToRelease([hauler('idle', 0, 0, 'collect', false), hauler('idle', 0, 0, 'collect', false)])).toBeUndefined();
  });

  it('ignores workers who are not haulers', () => {
    const onDuty = hauler('returning', 9, 5);
    // The non-haulers are idle and empty with 0 ticks left, so they would win
    // every ordering rule below if the `hauling` filter were dropped.
    const picked = cheapestHaulerToRelease([
      hauler('idle', 0, 0, 'collect', false), onDuty, hauler('idle', 0, 0, 'collect', false),
    ]);
    expect(picked).toBe(onDuty);
  });

  it('prefers an idle hauler over any working one', () => {
    const idle = hauler('idle', 0, 0);
    expect(cheapestHaulerToRelease([hauler('outbound', 1, 4), hauler('returning', 1, 7), idle])).toBe(idle);
  });

  // Step 3b's inversion, in the shape that actually occurs: an EMPTY hauler is
  // the cheaper release however far it still has to walk, because there is
  // nothing in its hands to strand. Under the old phase ordering the returning
  // hauler here — nearer home, but loaded — was released instead, teleporting
  // its seven units back while the empty one stayed on duty.
  it('prefers a distant empty hauler over a loaded one nearly home', () => {
    const empty = hauler('outbound', 8, 0);
    const loaded = hauler('returning', 3, 7);
    expect(cheapestHaulerToRelease([loaded, empty])).toBe(empty);
    expect(cheapestHaulerToRelease([empty, loaded])).toBe(empty);
  });

  // The mixed-phase case, which a fixture with one phase present cannot catch:
  // `fetching` was not in the old phase ordering AT ALL, so it fell through to
  // the `returning` arm — the most expensive rank there is — while the outbound
  // hauler beside it, carrying a real supply load, ranked cheaper and went.
  it('releases a fetching hauler ahead of a loaded outbound one', () => {
    const fetching = hauler('fetching', 6, 0, 'supply');
    const loadedOutbound = hauler('outbound', 2, 5, 'supply');
    expect(cheapestHaulerToRelease([fetching, loadedOutbound])).toBe(fetching);
    expect(cheapestHaulerToRelease([loadedOutbound, fetching])).toBe(fetching);
  });

  // The fixture the rule cannot be told from a kind-based one without: an
  // aggregate spend drained this hauler's source before it arrived, so
  // fetchArrival set `amount` to 0 and the trip carries on as a collect run —
  // a `supply`/`outbound` trip that is genuinely empty. Ranking on the kind
  // files it as loaded and releases the `collect` hauler that really is.
  it('releases the supply hauler whose source drained ahead of a loaded collect one', () => {
    const drained = hauler('outbound', 9, 0, 'supply');
    const loaded = hauler('returning', 4, 3, 'collect');
    expect(cheapestHaulerToRelease([drained, loaded])).toBe(drained);
    expect(cheapestHaulerToRelease([loaded, drained])).toBe(drained);
  });

  it('among empty haulers takes the one with least walking left to lose', () => {
    const almostThere = hauler('outbound', 2, 0);
    expect(cheapestHaulerToRelease([hauler('fetching', 6, 0, 'supply'), almostThere])).toBe(almostThere);
  });

  it('among loaded haulers takes the one closest to home', () => {
    const nearlyHome = hauler('returning', 1, 8);
    expect(cheapestHaulerToRelease([hauler('returning', 7, 5), nearlyHome, hauler('outbound', 4, 2, 'supply')])).toBe(nearlyHome);
  });

  it('breaks exact ties by iteration order, so the choice is deterministic', () => {
    const first = hauler('returning', 5, 6);
    const second = hauler('returning', 5, 6);
    expect(cheapestHaulerToRelease([first, second])).toBe(first);
    expect(cheapestHaulerToRelease([second, first])).toBe(second);
  });
});
