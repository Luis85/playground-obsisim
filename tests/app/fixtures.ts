import { vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import type { ResourceStats, Snapshot } from '../../src/shared/snapshot';
import { RESOURCE_IDS } from '../../src/engine/content/resources';
import { BALANCE } from '../../src/engine/content/balance';
import type { ResourceId } from '../../src/shared/content-types';
import type { BuildingSnapshot, ColonistSnapshot } from '../../src/shared/snapshot';
import { CAMP_TILE } from '../../src/shared/haul';
import App from '../../src/app/App.vue';
import { createGameRouter } from '../../src/app/router';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { WORLD_RENDERER_KEY, type WorldRenderer, type WorldRendererFactory } from '../../src/app/world/renderer-key';

/**
 * A full stockpile with the given resources' `stock` set, everything else at
 * zero. Every RESOURCE_IDS entry is always present (with deliveredRate,
 * madeRate, consumptionRate, netFlow, and stockValue all zeroed) so a test can
 * index any ResourceId on the result without an extra existence check — the
 * real Snapshot.stockpile is a complete Record too, never a sparse partial one.
 */
export function stockedWith(stocks: Partial<Record<ResourceId, number>> = {}): Record<ResourceId, ResourceStats> {
  return Object.fromEntries(
    RESOURCE_IDS.map((id) => [id, { stock: stocks[id] ?? 0, deliveredRate: 0, madeRate: 0, consumptionRate: 0, netFlow: 0, stockValue: 0 }]),
  ) as Record<ResourceId, ResourceStats>;
}

/** A minimal, valid Snapshot for app-layer tests, overridable field by field. */
export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tick: 0, lastRecruitTick: -30, lastBirthTick: -50, map: { cols: 24, rows: 16 }, stockpile: stockedWith(), colonyWealth: 0,
    mealsPerHead: 0,
    population: 0, idleAdults: 0, homeless: 0, beds: { total: 0, occupied: 0 },
    demographics: { children: 0, adults: 0, elders: 0 },
    buildings: [], colonists: [], notices: [],
    ...overrides,
  };
}

/** A building snapshot on an id-keyed default tile (the legacy plot pattern,
 * unique per id < 41) so multi-building fixtures never stack. */
export function makeBuilding(id: number, overrides: Partial<BuildingSnapshot> = {}): BuildingSnapshot {
  return {
    id, defId: 'farm', col: 4 + 2 * ((id - 1) % 5), row: 1 + 2 * (Math.floor((id - 1) / 5) % 8),
    workers: 0, workerSlots: 4, state: 'unstaffed',
    progress: 0, batchActive: false, progressPct: 0, tooledWorkers: 0, workPower: 0, buffered: 0,
    inputBuffered: 0, stored: 0, storage: 0, relocatingTicks: 0, constructionTicks: 0,
    beds: 0, occupants: 0, constructionNeeds: {},
    ...overrides,
  };
}

export function makeWorker(id: number, overrides: Partial<ColonistSnapshot> = {}): ColonistSnapshot {
  return {
    id, hunger: 0, starvingTicks: 0, efficiency: 1, buildingId: null, hauling: false,
    haulTargetId: null, haulPhase: 'idle', haulTicksLeft: 0,
    haulKind: null, haulPickedUp: false, haulLegTicks: 0,
    haulLegFromCol: 0, haulLegFromRow: 0, haulLegToCol: 0, haulLegToRow: 0,
    // The camp tile, never (0, 0) — `HaulTrip` seeds an idle hauler's resting
    // position there for the same reason (see its own doc comment), and a
    // fixture defaulting to the map's corner would make a layout case that
    // draws an idle hauler pass against a tile no hauler ever stands on.
    haulAtCol: CAMP_TILE.col, haulAtRow: CAMP_TILE.row,
    carrying: 0, toolTicks: 0, ageTicks: BALANCE.lifeBands.matureTicks, stage: 'adult', homeId: null,
    // Consistent with `homeId: null` above: a homeless colonist has no bed to
    // measure a distance from, and takes the flat homeless charge instead. A
    // fixture claiming full work power for a homeless worker would be a lie
    // the next case built on.
    commuteTiles: 0, commuteFactor: BALANCE.homelessFactor,
    // Consistent with `buildingId: null` above: nobody is assigned by
    // default, so there is no building this colonist delivers work power to.
    deliveredWorkPower: null,
    ...overrides,
  };
}

/**
 * A fake WorldRenderer whose factory always succeeds, returning the same
 * renderer instance every call — so `factory` mock-call assertions (criterion
 * 5: built exactly once) and `renderer` method assertions (start/stop/dispose)
 * read the one object the component under test actually holds. Shared by
 * world-screen.test.ts and ledger-view.test.ts rather than each keeping its
 * own copy of this object literal, which is what fallow's clone detector
 * would otherwise see as one control duplicated twice.
 */
export function makeFake(): { renderer: WorldRenderer; factory: WorldRendererFactory } {
  const renderer: WorldRenderer = {
    sync: vi.fn(), pick: vi.fn(() => null), tileAt: vi.fn(() => null),
    setGhost: vi.fn(), setSelection: vi.fn(), setHighlight: vi.fn(),
    onFatal: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn(),
  };
  return { renderer, factory: vi.fn(() => renderer) };
}

/**
 * Criterion 3 needs both of §2.5's two renderer failures, and they are
 * reached through this one factory shape, toggled by `shouldThrow`: a
 * throwing factory never returns a renderer at all (the BOOT failure —
 * `renderer` is null because `WorldStage`'s `onMounted` never gets past the
 * `try`), while a succeeding factory hands back `makeFake()`'s renderer,
 * whose captured `onFatal` callback the caller can invoke by hand to drive
 * the POST-boot failure — the one a throwing factory can never reach, because
 * that callback is registered only after the factory succeeds
 * (`WorldStage.vue`'s own comment on `created.onFatal`).
 */
export function makeFakeFactory(shouldThrow: boolean): { renderer: WorldRenderer | null; factory: WorldRendererFactory } {
  if (shouldThrow) return { renderer: null, factory: vi.fn(() => { throw new Error('no webgl'); }) };
  return makeFake();
}

/**
 * Mounts the real `App.vue` behind the real router (`createGameRouter`) —
 * the one mount neither `world-screen.test.ts`'s `mountScreen` (WorldScreen
 * alone, no router) nor `dock-panels.test.ts`'s panel mounts reach, and the
 * one criterion 3 and criterion 5 both need: criterion 3 because `App.vue` is
 * the component that watches `ui.rendererFailure` and owns the persistent
 * banner: criterion 5 because a real `/` -> `/ledger` -> `/` round trip only
 * exists through the real router, not a hand-built `KeepAlive` harness.
 * `attachTo: document.body` because `App.vue`'s `keydown` listener and the
 * banner's `document.querySelector` lookups both need a live document, the
 * same reason `mountScreen` in world-screen.test.ts attaches too.
 */
export async function mountApp(factory: WorldRendererFactory) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  useGameStore(pinia).ingest(makeSnapshot({ idleAdults: 1, buildings: [makeBuilding(1)] }), { paused: true, speed: 1, error: null });
  const router = createGameRouter();
  await router.push('/');
  const wrapper = mount(App, {
    attachTo: document.body,
    global: {
      plugins: [pinia, router],
      provide: {
        [WORLD_RENDERER_KEY as symbol]: factory,
        [ENGINE_KEY as symbol]: { dispatch: vi.fn() },
      },
    },
  });
  return { wrapper, router };
}
