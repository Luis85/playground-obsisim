import { describe, expect, it } from 'vitest';
import { cheapestHaulerToRelease } from '../../../src/engine/systems/command-handlers';
import type { WorkerRow } from '../../../src/engine/systems/command-handlers';
import { HaulTrip, JobAssignment } from '../../../src/engine/components';
import type { HaulPhase } from '../../../src/engine/components';

// The removal rule OBS-4-08 asked for, unit-tested directly: the integration
// test in command-system.test.ts pins the headline case (idle over loaded) but
// cannot distinguish the phase term from the ticksLeft tiebreak, because an
// idle hauler has ticksLeft 0 and so wins on either rule.

let nextId = 1;
function hauler(phase: HaulPhase, ticksLeft: number, hauling = true): WorkerRow & { id: number } {
  return { id: nextId++, job: new JobAssignment(null, hauling), trip: new HaulTrip(phase, null, ticksLeft) };
}

describe('cheapestHaulerToRelease', () => {
  it('returns undefined when nobody is hauling', () => {
    expect(cheapestHaulerToRelease([hauler('idle', 0, false), hauler('idle', 0, false)])).toBeUndefined();
  });

  it('ignores workers who are not haulers', () => {
    const onDuty = hauler('returning', 9);
    // The non-haulers are idle with 0 ticks left, so they would win every
    // ordering rule below if the `hauling` filter were dropped.
    const picked = cheapestHaulerToRelease([hauler('idle', 0, false), onDuty, hauler('idle', 0, false)]);
    expect(picked).toBe(onDuty);
  });

  it('prefers an idle hauler over any working one', () => {
    const idle = hauler('idle', 0);
    expect(cheapestHaulerToRelease([hauler('outbound', 1), hauler('returning', 1), idle])).toBe(idle);
  });

  // The case the integration test cannot see: an outbound hauler with MORE
  // walking left is still the cheaper release, because it carries nothing —
  // only the walk out is wasted, whereas interrupting a returning hauler throws
  // away a walk that has already earned a load.
  it('prefers a distant outbound hauler over a returning one nearly home', () => {
    const outbound = hauler('outbound', 8);
    const returning = hauler('returning', 3);
    expect(cheapestHaulerToRelease([returning, outbound])).toBe(outbound);
    expect(cheapestHaulerToRelease([outbound, returning])).toBe(outbound);
  });

  it('among returning haulers takes the one closest to home', () => {
    const nearlyHome = hauler('returning', 1);
    expect(cheapestHaulerToRelease([hauler('returning', 7), nearlyHome, hauler('returning', 4)])).toBe(nearlyHome);
  });

  it('among outbound haulers takes the one with least walking left to lose', () => {
    const almostThere = hauler('outbound', 2);
    expect(cheapestHaulerToRelease([hauler('outbound', 6), almostThere])).toBe(almostThere);
  });

  it('breaks exact ties by iteration order, so the choice is deterministic', () => {
    const first = hauler('returning', 5);
    const second = hauler('returning', 5);
    expect(cheapestHaulerToRelease([first, second])).toBe(first);
    expect(cheapestHaulerToRelease([second, first])).toBe(second);
  });
});
