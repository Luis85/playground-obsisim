import { defineStore } from 'pinia';
import type { EngineStatus, Snapshot } from '../../shared/snapshot';
import { BALANCE } from '../../engine/content/balance';

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
