import { defineStore } from 'pinia';
import { toRaw } from 'vue';
import type { EngineStatus, NoticeKind, Snapshot } from '../../shared/snapshot';
// Aliased: the getter below is deliberately named after the predicate it
// delegates to, and the alias keeps the two readable side by side.
import { nomadBlocker as blockerForNomad, type PopulationBlocker } from '../../shared/population';
import {
  BALANCE, batchInputUnits, BUILDINGS, BUILDING_IDS, MEAL_WEIGHTS, RESOURCE_IDS, RESOURCES, unitsOf,
  type BuildingDefId, type ResourceId,
} from '../../engine/content';
import type { Selection } from './ui-store';
import { needsLabel } from '../labels';

/**
 * One line of the Attention panel. Every field is derived from a Snapshot
 * field that already exists — this increment adds no engine data (spec §2.4).
 *
 * `subject` is what a click selects and `highlight` what it pulses; a row may
 * have neither, which is how a resource row stays inert (§2.3's table) rather
 * than quietly doing nothing by accident.
 */
export interface AttentionRow {
  id: string;
  severity: 'warn' | 'danger';
  message: string;
  subject: Selection | null;
  highlight: Selection[];
}

/** Ticks of runway at or below which a resource is worth naming. The same 30
 * DashboardView already colours a runway cell at — one number, not two. */
const RUNWAY_WARN_TICKS = 30;

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

/**
 * What every construction site the colony already has going still needs, per
 * resource — summed straight off `BuildingSnapshot.constructionNeeds`, the
 * SAME per-material shortfall the Buildings table reads, not a second
 * derivation of it (spec §2.10).
 *
 * This was once the app-side half of the engine's own order-time check
 * (`outstandingMaterials`, `placement-handlers.ts`) — the two summed the
 * identical figure so a refusal here and a refusal at order time always
 * agreed. Increment 10 §2.1 deletes that engine check outright: an order is
 * a request now, not a claim, so nothing refuses. This function keeps its
 * job anyway, because `affordableDefs` below still uses it to tell the
 * player which def a queue has already spoken for — advisory, not a gate.
 */
function outstandingSiteDemand(snapshot: Snapshot | null): Partial<Record<ResourceId, number>> {
  const outstanding: Partial<Record<ResourceId, number>> = {};
  for (const b of snapshot?.buildings ?? []) {
    for (const [resource, amount] of Object.entries(b.constructionNeeds)) {
      const id = resource as ResourceId;
      outstanding[id] = (outstanding[id] ?? 0) + amount;
    }
  }
  return outstanding;
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
    /**
     * One affordability flag per catalog def. Through increment 9 the
     * construct table AND the build palette bound their `:disabled` to this,
     * so the check existed exactly once; increment 10 §2.1 makes ordering a
     * request instead of a claim, and drops the check everywhere it gated —
     * BuildPalette, WorldView's `tileValid`, and this getter's own reader in
     * BuildingsView's `:disabled`. What survives is the tooltip: the getter
     * is unchanged, and BuildingsView's Construct button still reads it to
     * TELL the player what a def is still short of, even though clicking it
     * now works either way.
     *
     * CUMULATIVE: ordering a building deliberately leaves `snapshot.stockpile`
     * untouched (§2.3), so a getter comparing a fresh def's cost against stock
     * alone would keep calling a second house affordable after the first has
     * already claimed that exact stock. `outstandingSiteDemand` is subtracted
     * first — the colony's whole queue, summed once — and then each def is
     * checked against ONLY ITS OWN cost resources, never the whole catalog:
     * outstanding demand already counts material in transit twice (picked up,
     * not yet delivered), which is deliberate PESSIMISM rather than a safety
     * margin — over-counting was the safe direction while this gated a refusal,
     * and for advice there is no safe direction, only accurate or gloomy — and
     * spreading that pessimism across resources a def does not even want would
     * call orders the colony can plainly cover unaffordable.
     */
    affordableDefs(state): Record<BuildingDefId, boolean> {
      const snapshot = state.snapshot;
      const outstanding = outstandingSiteDemand(snapshot);
      return Object.fromEntries(
        BUILDING_IDS.map((id) => [
          id,
          snapshot !== null &&
            Object.entries(BUILDINGS[id].cost).every(
              ([res, amount]) => snapshot.stockpile[res as ResourceId].stock >= (outstanding[res as ResourceId] ?? 0) + amount,
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
    /**
     * Buildings stopped for want of inputs — the input-side twin of
     * `stalledBuildings`, and half the answer to "why is my bakery stopped?".
     *
     * `waitingForInput` is the engine's own verdict, not a re-derivation from
     * buffers: it already accounts for staffing and for an output stall, so a
     * building counted here is genuinely one a delivery would restart.
     */
    buildingsWaitingForInput(state): number {
      return state.snapshot?.buildings.filter((b) => b.state === 'waitingForInput').length ?? 0;
    },
    /**
     * Units the colony still owes those buildings: for each one, what one batch
     * of its recipe wants beyond what its in-tray already holds. The input
     * backlog, symmetric with `unitsWaiting`'s output backlog (§2.10).
     *
     * Derived HERE rather than in each view, and gated on the same
     * `waitingForInput` set as the count above, so the Economy view's two
     * figures describe one set of buildings rather than two overlapping ones.
     * A building mid-batch is not short of anything — it has already paid its
     * inputs — and `waitingForInput` is precisely "staffed, unblocked, and no
     * batch running".
     *
     * Every recipe takes one input resource today, so `inputBuffered`'s
     * TOTAL and the per-resource amount coincide; a two-input recipe would
     * read "not short" while starved of one of them, because
     * `BuildingSnapshot` publishes only the total.
     */
    unitsShort(state): number {
      return (state.snapshot?.buildings ?? []).reduce(
        (sum, b) => (b.state === 'waitingForInput'
          ? sum + Math.max(0, batchInputUnits(BUILDINGS[b.defId].recipe) - b.inputBuffered)
          : sum),
        0,
      );
    },
    /**
     * Sites currently under construction — the Economy view's build backlog,
     * beside the input and output backlogs above (§2.10). Symmetric with
     * `buildingsWaitingForInput`: a straight count, gated on the engine's own
     * `underConstruction` verdict rather than a re-derivation of it.
     */
    buildingsUnderConstruction(state): number {
      return state.snapshot?.buildings.filter((b) => b.state === 'underConstruction').length ?? 0;
    },
    /**
     * Units the colony still owes every site — `unitsShort`'s build-backlog
     * twin, and the SAME per-material figure `outstandingSiteDemand` sums for
     * `affordableDefs` above, just totalled across resources instead of kept
     * per-resource. One source (`constructionNeeds`), two reductions of it,
     * never two derivations.
     */
    unitsNeededForConstruction(state): number {
      return (state.snapshot?.buildings ?? []).reduce((sum, b) => sum + unitsOf(b.constructionNeeds), 0);
    },
    /** Colonists whose starvation clock is running — the figure the Attention
     * panel names and PopulationSummary's cell shows, derived once. */
    starvingCount(state): number {
      return state.snapshot?.colonists.filter((c) => c.starvingTicks > 0).length ?? 0;
    },
    /**
     * The problem list, newest concern first by severity then by kind. Pure
     * derivation over the current snapshot: nothing here is remembered
     * between ticks, so a fixed problem leaves the list by itself.
     */
    attention(state): AttentionRow[] {
      const snapshot = state.snapshot;
      if (!snapshot) return [];
      // A row is EITHER a subject or a highlight set, never both: §2.3's table
      // gives single-building rows a selection and reserves the pulse for the
      // plural rows. Carrying both would make one click do two things and blur
      // the distinction the table exists to draw.
      const rows: AttentionRow[] = [];
      const name = (defId: BuildingDefId) => BUILDINGS[defId].name;

      for (const b of snapshot.buildings) {
        const subject: Selection = { kind: 'building', id: b.id };
        if (b.state === 'outputFull') {
          rows.push({ id: `full-${b.id}`, severity: 'warn', subject, highlight: [],
            message: `${name(b.defId)} is full — nothing is collecting from it` });
        }
        if (b.state === 'waitingForInput') {
          rows.push({ id: `starved-${b.id}`, severity: 'warn', subject, highlight: [],
            message: `${name(b.defId)} has nothing to work with` });
        }
        // The engine's own verdict, not a re-derivation of it. `workers === 0
        // && workerSlots > 0` also fires for every unfinished producer — a site
        // keeps its def's slots — and `handleAssignWorker` refuses a site, so
        // that predicate reports a problem the player cannot fix. The
        // `unstaffed` state already excludes sites, which read
        // `underConstruction`.
        if (b.state === 'unstaffed') {
          rows.push({ id: `unstaffed-${b.id}`, severity: 'warn', subject, highlight: [],
            message: `${name(b.defId)} has no one working it` });
        }
        if (Object.keys(b.constructionNeeds).length > 0) {
          rows.push({ id: `site-${b.id}`, severity: 'warn', subject, highlight: [],
            message: `${name(b.defId)} site needs ${needsLabel(b.constructionNeeds)}` });
        }
      }

      // Resource rows carry neither a subject nor a highlight: a resource is
      // not a thing on the map, and §2.3 keeps that inert in both panels.
      for (const [id, ticks] of Object.entries(this.runways as Partial<Record<ResourceId, number>>)) {
        if (ticks !== undefined && ticks <= RUNWAY_WARN_TICKS) {
          rows.push({ id: `runway-${id}`, severity: 'danger', subject: null, highlight: [],
            message: `${RESOURCES[id as ResourceId].name} empties in ~${ticks}t` });
        }
      }

      if (snapshot.homeless > 0) {
        // Plural rows pulse the people they name (§2.3). `homeId === null` is
        // the same predicate `commuteLabel` calls homeless, not a second one.
        rows.push({ id: 'homeless', severity: 'warn', subject: null,
          highlight: snapshot.colonists.filter((c) => c.homeId === null).map((c) => ({ kind: 'colonist' as const, id: c.id })),
          message: `${snapshot.homeless} colonist${snapshot.homeless === 1 ? ' has' : 's have'} no bed` });
      }
      const starving = snapshot.colonists.filter((c) => c.starvingTicks > 0);
      if (starving.length > 0) {
        rows.push({ id: 'starving', severity: 'danger', subject: null,
          highlight: starving.map((c) => ({ kind: 'colonist' as const, id: c.id })),
          message: `${this.starvingCount} colonist${this.starvingCount === 1 ? ' is' : 's are'} starving` });
      }
      if (snapshot.idleAdults > 0) {
        // The same three conditions `idleAdults` is counted from: an adult
        // with no building and no haul duty. Derived here rather than
        // published, because this increment adds no snapshot field.
        rows.push({ id: 'idle', severity: 'warn', subject: null,
          highlight: snapshot.colonists
            .filter((c) => c.stage === 'adult' && c.buildingId === null && !c.hauling)
            .map((c) => ({ kind: 'colonist' as const, id: c.id })),
          message: `${snapshot.idleAdults} adult${snapshot.idleAdults === 1 ? ' is' : 's are'} idle` });
      }

      return rows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1));
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
