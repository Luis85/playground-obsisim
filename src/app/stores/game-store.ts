import { defineStore } from 'pinia';
import { toRaw } from 'vue';
import type { EngineStatus, NoticeKind, Snapshot } from '../../shared/snapshot';
// Aliased: the getter below is deliberately named after the predicate it
// delegates to, and the alias keeps the two readable side by side.
import { nomadBlocker as blockerForNomad, type PopulationBlocker } from '../../shared/population';
import {
  BALANCE, BUILDINGS, BUILDING_IDS, MEAL_WEIGHTS, RESOURCE_IDS, RESOURCES,
  type BuildingDefId, type ResourceId,
} from '../../engine/content';

interface DefStaffing {
  total: number;
  staffed: number;
  /** Buildings currently starved of their recipe input. */
  starved: number;
}

// The store-side shape of a rendered notice: a NoticeMessage (kind, message)
// plus the tick it arrived on and a locally-assigned id, neither of which
// exist on the wire — NoticeBanner renders this, not Snapshot['notices'].
export interface NoticeEntry {
  id: number;
  tick: number;
  kind: NoticeKind;
  message: string;
}

// Newest-first, capped at this many entries; NoticeBanner renders exactly
// this list, so the cap is also the visible history depth in the UI.
const MAX_NOTICES = 5;

// How many ticks of per-worker consumption the stockpile must cover before
// lowFood clears; today's inline `* 2` given a name, not a behavior change.
const LOW_FOOD_TICKS_OF_COVER = 2;

/**
 * Beds nobody has a claim on, restated over a Snapshot.
 *
 * This is the engine's own `spareBeds` (population-handlers.ts): `total` minus
 * every living colonist, NOT minus `beds.occupied`. A homeless colonist is
 * still owed a bed, so counting only the occupied ones would offer a nomad a
 * bed a resident is already queueing for. `beds.total` has relocating houses
 * excluded upstream, which is the other half of what spareBeds does.
 *
 * Clamped at 0 for the same reason recruitCooldownRemaining is: a view binds
 * it directly, and the gate below only ever asks whether it is above zero.
 */
function spareBedsIn(snapshot: Snapshot | null): number {
  if (snapshot === null) return 0;
  return Math.max(0, snapshot.beds.total - snapshot.population);
}

/** The stockpile as the shared meal arithmetic wants it: bare amounts per
 * resource id, every id present, zeroed before the first snapshot. */
function stockAmounts(snapshot: Snapshot | null): Record<string, number> {
  const stock: Record<string, number> = {};
  for (const id of RESOURCE_IDS) stock[id] = snapshot?.stockpile[id].stock ?? 0;
  return stock;
}

// The single read-model store the whole app layer subscribes to: GameEngine
// stays headless and knows nothing about Vue or Pinia, and this is the only
// place a Snapshot gets translated into what the views actually bind to.
export const useGameStore = defineStore('game', {
  state: () => ({
    snapshot: null as Snapshot | null,
    paused: true,
    speed: 1 as 1 | 2 | 4,
    error: null as string | null,
    recentNotices: [] as NoticeEntry[],
    nextNoticeId: 1,
  }),
  getters: {
    lowFood(state): boolean {
      if (!state.snapshot) return false;
      // Edible comes from the catalog (ResourceDef.edible), not a hardcoded
      // bread+berries pair: a future increment can add a new edible resource
      // (increment 2 adds foods) and this getter picks it up without a change
      // here. Content is frozen this increment, so today's edible set is
      // exactly bread and berries — but the logic no longer says so directly.
      const edible = RESOURCE_IDS.reduce(
        (sum, id) => sum + (RESOURCES[id].edible ? state.snapshot!.stockpile[id].stock : 0),
        0,
      );
      return edible < state.snapshot.population * LOW_FOOD_TICKS_OF_COVER;
    },
    // Ticks until the next recruitWorker command would be accepted; 0 once
    // the cooldown has fully elapsed. Clamped at 0 rather than going negative
    // so TopBar can render it directly without its own extra check.
    recruitCooldownRemaining(state): number {
      if (!state.snapshot) return 0;
      return Math.max(
        0,
        state.snapshot.lastRecruitTick + BALANCE.recruitCooldownTicks - state.snapshot.tick,
      );
    },
    /** Beds nobody has a claim on — see spareBedsIn above. */
    bedsFree(state): number {
      return spareBedsIn(state.snapshot);
    },
    /**
     * Which gate would refuse a nomad right now, or null when one may join.
     *
     * Goes through the SAME shared predicate handleRecruitWorker rejects with,
     * fed from the same quantities, so the reason on the disabled button and
     * the notice a click would produce cannot disagree. Before this getter the
     * button read only the recruit cooldown and rendered enabled against a
     * colony with no bed and no food, promising an arrival the engine was
     * always going to refuse.
     *
     * Food comes from the STOCKPILE, not from the published
     * `Snapshot.mealsPerHead`: that figure is an OUTPUT of this same
     * calculation (meals over population + 1), so reading it back would be a
     * second derivation that agrees only by luck.
     *
     * There is no early return for the pre-first-snapshot case. A zeroed gate
     * has no free bed, and the predicate says 'noBed' on its own — one code
     * path, which is the whole point of sharing it. A hand-written early
     * return would be an answer the engine never gives.
     */
    nomadBlocker(state): PopulationBlocker {
      return blockerForNomad({
        stock: stockAmounts(state.snapshot),
        weights: MEAL_WEIGHTS,
        population: state.snapshot?.population ?? 0,
        freeBeds: spareBedsIn(state.snapshot),
        tick: state.snapshot?.tick ?? 0,
        lastRecruitTick: state.snapshot?.lastRecruitTick ?? 0,
        cooldown: BALANCE.recruitCooldownTicks,
        perHead: BALANCE.nomadFoodPerHead,
      });
    },
    /** Ticks until a draining resource runs out; absent while not draining. */
    runways(state): Partial<Record<ResourceId, number>> {
      const runways: Partial<Record<ResourceId, number>> = {};
      for (const [id, stats] of Object.entries(state.snapshot?.stockpile ?? {})) {
        if (stats.netFlow < 0) runways[id as ResourceId] = Math.ceil(stats.stock / -stats.netFlow);
      }
      return runways;
    },
    /** Per building def: how many exist, are staffed, and starve for input. */
    staffingByDef(state): Partial<Record<BuildingDefId, DefStaffing>> {
      const byDef: Partial<Record<BuildingDefId, DefStaffing>> = {};
      for (const b of state.snapshot?.buildings ?? []) {
        const entry = byDef[b.defId] ?? { total: 0, staffed: 0, starved: 0 };
        entry.total += 1;
        if (b.workers > 0) entry.staffed += 1;
        if (b.state === 'waitingForInput') entry.starved += 1;
        byDef[b.defId] = entry;
      }
      return byDef;
    },
    /**
     * Chain-stage verdict per existing def — starvation is the engine's own
     * waitingForInput truth, which is exactly "the stage before is too slow"
     * (the PRD's bottleneck view). Defs with no buildings are simply absent;
     * the chain view renders those as "not built".
     */
    stageStatuses(): Partial<Record<BuildingDefId, { label: string; starved: boolean }>> {
      const statuses: Partial<Record<BuildingDefId, { label: string; starved: boolean }>> = {};
      for (const [defId, staffing] of Object.entries(this.staffingByDef)) {
        let label = 'ok';
        if (staffing.starved > 0) label = '⚠ starved';
        else if (staffing.staffed === 0) label = 'unstaffed';
        statuses[defId as BuildingDefId] = { label, starved: staffing.starved > 0 };
      }
      return statuses;
    },
    /** One affordability flag per catalog def — the construct table and the
     * build palette bind to this, so the check exists exactly once. */
    affordableDefs(state): Record<BuildingDefId, boolean> {
      const snapshot = state.snapshot;
      return Object.fromEntries(
        BUILDING_IDS.map((id) => [
          id,
          snapshot !== null &&
            Object.entries(BUILDINGS[id].cost).every(
              ([res, amount]) => snapshot.stockpile[res as ResourceId].stock >= amount,
            ),
        ]),
      ) as Record<BuildingDefId, boolean>;
    },
    /** Colonists currently assigned to hauling rather than to a building. */
    haulerCount(state): number {
      return state.snapshot?.colonists.filter((w) => w.hauling).length ?? 0;
    },
    /** Goods produced but not yet carried to the store — the haul backlog. */
    unitsWaiting(state): number {
      return state.snapshot?.buildings.reduce((sum, b) => sum + b.buffered, 0) ?? 0;
    },
    /** Buildings that have stopped because they cannot bank another batch. */
    stalledBuildings(state): number {
      return state.snapshot?.buildings.filter((b) => b.state === 'outputFull').length ?? 0;
    },
  },
  actions: {
    ingest(snapshot: Snapshot | null, status: EngineStatus) {
      // GameEngine.publish() re-sends the CURRENT snapshot object on start(),
      // pause(), setSpeed(), and on listener registration — none of those are
      // a new tick, so only a genuinely new snapshot object should append
      // notices; a status-only republish must leave recentNotices untouched.
      // toRaw is required here: Pinia hands back a reactive Proxy from
      // useGameStore(), so a bare `this.snapshot !== snapshot` comparison
      // would always be true even for the identical underlying object
      // (verified against this codebase's Pinia setup, not a hypothetical).
      const isNewSnapshot = snapshot !== null && toRaw(this.snapshot) !== snapshot;
      this.snapshot = snapshot;
      this.paused = status.paused;
      this.speed = status.speed;
      this.error = status.error;
      if (!isNewSnapshot) return;
      for (const { kind, message } of snapshot.notices) {
        // id, not tick+kind+message: one tick can drain two byte-identical
        // commands (two assignWorker clicks on the same building while
        // paused), which would otherwise collide as a Vue :key downstream.
        this.recentNotices.unshift({ id: this.nextNoticeId++, tick: snapshot.tick, kind, message });
      }
      // splice(MAX_NOTICES) trims from the tail; the list is newest-first
      // (unshift above), so this keeps the newest 5 regardless of how many
      // notices this one tick's drain produced.
      this.recentNotices.splice(MAX_NOTICES);
    },
  },
});
