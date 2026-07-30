import { defineStore } from 'pinia';
import { toRaw } from 'vue';
import type { EngineStatus, NoticeKind, Snapshot } from '../../shared/snapshot';
import { BALANCE } from '../../engine/content/balance';
import { RESOURCE_IDS, RESOURCES } from '../../engine/content/resources';

// The store-side shape of a rendered notice: a NoticeMessage (kind, message)
// plus the tick it arrived on and a locally-assigned id, neither of which
// exist on the wire — NoticeBanner renders this, not Snapshot['notices'].
interface NoticeEntry {
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
