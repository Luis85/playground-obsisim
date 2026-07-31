import { describe, expect, it, vi } from 'vitest';
import { decideLoad, initialSave } from '../../src/engine/world';
import * as saveMigration from '../../src/shared/save-migration';

// Wrapping (not replacing) the real implementation: every ordinary test below
// gets the genuine migration+guard behavior, and only the one test that needs
// to probe the pipeline overrides a single call with mockReturnValueOnce.
vi.mock('../../src/shared/save-migration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/save-migration')>();
  return { ...actual, migrateSaveToLatest: vi.fn(actual.migrateSaveToLatest) };
});

// decideLoad is main.ts's loadSave()'s only piece of decision logic, pulled
// out into src/engine/world.ts (which IS in vitest.config.ts's coverage
// `include`, unlike src/main.ts) specifically so this call site — previously
// coverable only by clicking through Obsidian by hand — has unit tests at all.
describe('decideLoad', () => {
  it('restores a valid latest-version save', () => {
    const save = initialSave();
    expect(decideLoad(save)).toEqual({ kind: 'restore', save });
  });

  it('restores a genuine v1 save by migrating it (positions on the legacy pattern)', () => {
    const v1 = {
      version: 1, tick: 10, lastRecruitTick: -30, stockpile: { wood: 5 },
      buildings: [
        { id: 4, defId: 'forester', progress: 0, batchActive: false },
        { id: 5, defId: 'farm', progress: 0, batchActive: false },
      ],
      workers: [{ id: 1, hunger: 0, buildingId: 4, toolTicks: 0 }],
      nextEntityId: 6,
    };
    const decision = decideLoad(v1);
    expect(decision.kind).toBe('restore');
    if (decision.kind !== 'restore') return;
    expect(decision.save.version).toBe(2);
    expect(decision.save.map).toEqual({ cols: 24, rows: 16 });
    expect(decision.save.buildings.map((b) => [b.col, b.row])).toEqual([[4, 1], [6, 1]]);
  });

  it('routes a save with an unknown version to backup', () => {
    expect(decideLoad({ ...initialSave(), version: 99 })).toEqual({ kind: 'backup' });
  });

  it('routes a missing or null save to fresh', () => {
    expect(decideLoad(undefined)).toEqual({ kind: 'fresh' });
    expect(decideLoad(null)).toEqual({ kind: 'fresh' });
  });

  it('routes a structurally valid save with an unknown building id to backup', () => {
    const save = initialSave();
    save.buildings = [{ id: 99, defId: 'notABuilding' as never, progress: 0, batchActive: false, col: 4, row: 1 }];
    save.nextEntityId = 100;
    expect(decideLoad(save)).toEqual({ kind: 'backup' });
  });

  it('restores only through the migration pipeline, not a bare structural guard', () => {
    // `{ version: 1, garbage: true }` is not a SaveGameV1 shape at all, so
    // isLoadableSave(data) called directly on it would reject outright, with
    // no chance to upgrade it first. Mocking migrateSaveToLatest to "heal" it
    // into a real save and asserting decideLoad still restores THAT healed
    // object proves the restore branch is reachable only via the
    // migration-aware prepareLoadedSave: swapping decideLoad's internals to
    // call isLoadableSave(data) directly instead (bypassing this mock
    // entirely) would reject the raw input and this assertion would fail.
    const healed = initialSave();
    vi.mocked(saveMigration.migrateSaveToLatest).mockReturnValueOnce(healed);
    expect(decideLoad({ version: 1, garbage: true })).toEqual({ kind: 'restore', save: healed });
  });
});
