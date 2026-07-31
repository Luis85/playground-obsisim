import { defineStore } from 'pinia';
import { toRaw } from 'vue';
import type { EngineStatus, NoticeKind, Snapshot } from '../../shared/snapshot';
import {
  BALANCE, BUILDINGS, BUILDING_IDS, RESOURCE_IDS, RESOURCES,
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
