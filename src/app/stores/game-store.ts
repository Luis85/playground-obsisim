import { defineStore } from 'pinia';
import type { EngineStatus, Snapshot } from '../../shared/snapshot';
import { BALANCE, type BuildingDefId, type ResourceId } from '../../engine/content';

// Pure read-model over engine snapshots (PRD §2.1): ingest() is the only
// mutation, called from the engine's update listener; everything else is a
// derived getter. Views never mutate this store — player intent goes through
// engine.dispatch() and comes back as the next snapshot.

interface DefStaffing {
  total: number;
  staffed: number;
  /** Buildings currently starved of their recipe input. */
  starved: number;
}

interface NoticeEntry {
  tick: number;
  message: string;
}

const MAX_NOTICES = 5;

export const useGameStore = defineStore('game', {
  state: () => ({
    snapshot: null as Snapshot | null,
    paused: true,
    speed: 1 as 1 | 2 | 4,
    error: null as string | null,
    recentNotices: [] as NoticeEntry[],
  }),
  getters: {
    lowFood(state): boolean {
      if (!state.snapshot) return false;
      const edible = state.snapshot.stockpile.bread.stock + state.snapshot.stockpile.berries.stock;
      return edible < state.snapshot.population * 2;
    },
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
  },
  actions: {
    ingest(snapshot: Snapshot | null, status: EngineStatus) {
      this.snapshot = snapshot;
      this.paused = status.paused;
      this.speed = status.speed;
      this.error = status.error;
      if (snapshot) {
        for (const message of snapshot.notices) {
          this.recentNotices.unshift({ tick: snapshot.tick, message });
        }
        this.recentNotices.splice(MAX_NOTICES);
      }
    },
  },
});
