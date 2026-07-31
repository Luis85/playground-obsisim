import { describe, expect, it } from 'vitest';
import {
  CAMP_TILE, claimableAt, compareHaulCandidates, haulDistance, haulTicks, nextHaulTarget,
  type HaulCandidate,
} from '../../src/shared/haul';

function candidate(overrides: Partial<HaulCandidate> = {}): HaulCandidate {
  return { buildingId: 1, col: 4, row: 1, buffered: 4, claimed: 0, ...overrides };
}

describe('haul geometry', () => {
  it('measures from the camp tile', () => {
    expect(CAMP_TILE).toEqual({ col: 2, row: 0 });
    expect(haulDistance(CAMP_TILE.col, CAMP_TILE.row)).toBe(0);
  });

  it('is straight-line distance in tiles — the line the renderer walks', () => {
    expect(haulDistance(2, 3)).toBe(3);
    expect(haulDistance(5, 4)).toBe(5); // 3-4-5
  });

  it('never makes a trip free: even the camp tile costs a tick', () => {
    expect(haulTicks(CAMP_TILE.col, CAMP_TILE.row, 2)).toBe(1);
    expect(haulTicks(3, 0, 2)).toBe(1);
  });

  it('rounds up partial tiles but not exact multiples', () => {
    expect(haulTicks(2, 4, 2)).toBe(2); // distance 4, exactly 2 ticks
    expect(haulTicks(5, 4, 2)).toBe(3); // distance 5 -> ceil(2.5)
  });

  it('charges the far corner of the default map about thirteen ticks each way', () => {
    expect(haulTicks(22, 15, 2)).toBe(13); // distance 25
  });
});

describe('haul job selection', () => {
  it('counts only what earlier haulers have not spoken for', () => {
    expect(claimableAt(candidate({ buffered: 9, claimed: 6 }))).toBe(3);
    expect(claimableAt(candidate({ buffered: 6, claimed: 6 }))).toBe(0);
  });

  it('serves the fullest building first, even when it is farther', () => {
    const near = candidate({ buildingId: 1, col: 4, row: 1, buffered: 3 });
    const far = candidate({ buildingId: 2, col: 20, row: 10, buffered: 9 });
    expect(nextHaulTarget([near, far])?.buildingId).toBe(2);
  });

  it('breaks a tie on backlog by distance to the camp', () => {
    const near = candidate({ buildingId: 1, col: 4, row: 0, buffered: 5 });
    const far = candidate({ buildingId: 2, col: 10, row: 0, buffered: 5 });
    expect(nextHaulTarget([far, near])?.buildingId).toBe(1);
  });

  it('breaks a full tie by lowest building id, so selection cannot depend on order', () => {
    const a = candidate({ buildingId: 7, col: 2, row: 3, buffered: 4 }); // distance 3
    const b = candidate({ buildingId: 3, col: 5, row: 0, buffered: 4 }); // distance 3
    expect(nextHaulTarget([a, b])?.buildingId).toBe(3);
    expect(nextHaulTarget([b, a])?.buildingId).toBe(3);
  });

  it('ignores buildings whose backlog is fully claimed, and returns null when nothing is open', () => {
    const claimed = candidate({ buildingId: 1, buffered: 6, claimed: 6 });
    const open = candidate({ buildingId: 2, col: 20, row: 10, buffered: 1 });
    expect(nextHaulTarget([claimed, open])?.buildingId).toBe(2);
    expect(nextHaulTarget([claimed])).toBeNull();
    expect(nextHaulTarget([])).toBeNull();
  });

  it('sorts a list the same way it picks a single target', () => {
    const list = [
      candidate({ buildingId: 1, col: 4, row: 1, buffered: 2 }),
      candidate({ buildingId: 2, col: 6, row: 1, buffered: 8 }),
      candidate({ buildingId: 3, col: 5, row: 0, buffered: 8 }),
    ];
    const sorted = [...list].sort(compareHaulCandidates);
    expect(sorted.map((c) => c.buildingId)).toEqual([3, 2, 1]);
  });
});
