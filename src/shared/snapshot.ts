import type { BuildingDefId, ResourceId } from './content-types';
import type { HaulKind, HaulPhase } from './haul';
import type { LifeStage } from './population';
import type { WorldMapSize } from './placement';

export type BuildingState = 'producing' | 'waitingForInput' | 'unstaffed' | 'outputFull' | 'relocating' | 'housing' | 'storing';

export type NoticeKind = 'success' | 'rejection';

/** One line of per-tick feedback. Kind drives styling, never behavior. */
export interface NoticeMessage {
  kind: NoticeKind;
  message: string;
}

export interface BuildingSnapshot {
  id: number;
  defId: BuildingDefId;
  /** Tile position — sim truth since increment 3. */
  col: number;
  row: number;
  workers: number;
  workerSlots: number;
  state: BuildingState;
  /** Raw batch progress in worker-ticks. */
  progress: number;
  batchActive: boolean;
  /** 0-100, for display. */
  progressPct: number;
  /** Assigned workers whose tool coverage is currently active. */
  tooledWorkers: number;
  /**
   * Effective work per tick: the sum of this building's assigned workers'
   * `deliveredWorkPower` — efficiency x tool multiplier x commute factor,
   * each. Zero while `relocatingTicks > 0`: ProductionSystem skips a
   * relocating building before it ever reads work power, so a crew mid-move
   * banks nothing, and this column sits beside State in the same table row —
   * a non-zero rate there would contradict the state next to it.
   */
  workPower: number;
  /** Units waiting in this building's output buffer for a hauler. */
  buffered: number;
  /**
   * Units in this building's own in-tray, waiting for its recipe to spend them
   * — the input-side mirror of `buffered`, and the quantity the Buildings
   * table's `In` column and the Economy view's input backlog are both read off.
   * A different pile from `stored` below: these goods have already left the
   * colony's ledger (consumption is recorded when a hauler unloads them), and
   * only this building can use them.
   */
  inputBuffered: number;
  /**
   * Units this building holds AS A STORE: its share of the one colony ledger,
   * standing at its tile instead of at the camp. Still colony goods — spendable
   * on meals and construction from here, and drawable by any hauler — which is
   * exactly what makes it neither `buffered` nor `inputBuffered`. 0 for
   * everything that is not a storehouse.
   */
  stored: number;
  /**
   * What this building COULD hold as a store (`BuildingDef.storage`), 0 for a
   * non-store. Published beside `stored` rather than looked up per view: the
   * table's `held / capacity` and the world view's fill ring both need the
   * denominator, and it is 0 even for a depot standing empty.
   */
  storage: number;
  /** Ticks until a moved building can work again (0 when not relocating). */
  relocatingTicks: number;
  /** Sleeping places this building provides (0 for a producer). */
  beds: number;
  /** Colonists currently homed here. Derived from who points at it, never
   * stored — so it cannot disagree with the colonists. */
  occupants: number;
}

export interface ColonistSnapshot {
  id: number;
  hunger: number;
  /** Consecutive ticks pinned at hungerMax; death follows at BALANCE.starvationDeathTicks. */
  starvingTicks: number;
  efficiency: number;
  buildingId: number | null;
  /** True while this worker is assigned to hauling rather than to a building. */
  hauling: boolean;
  /**
   * The building this trip serves — set on BOTH legs, so a returning hauler is
   * still drawn on the line back from the building it loaded at. Null only when
   * the worker is not on a trip. (Increment 4 published this outbound-only; the
   * layout then had no way to know where a returning dot was walking from, which
   * is half of why it turned round in open ground — OBS-4-09.)
   */
  haulTargetId: number | null;
  /** Which leg of the round trip, or 'idle' when not on one. */
  haulPhase: HaulPhase;
  /**
   * The JOB this hauler was dispatched on, frozen at dispatch; null when not on
   * a trip at all.
   *
   * Deliberately NOT what drives the carrying-in/carrying-out marker — see
   * `haulPickedUp`. It stops describing the cargo the moment the round trip
   * works as intended, and it is published for what it does still answer: which
   * errand this dot is running.
   */
  haulKind: HaulKind | null;
  /**
   * Whether the load in hand came out of a building's OUTPUT buffer — i.e.
   * whether this hauler is carrying goods *out* of a building or *in* to one.
   *
   * This, not `haulKind`, is the direction marker (§2.10). A `supply` trip that
   * unloaded and then collected output is carrying goods out while still
   * labelled `supply`, and a `supply` trip returning an undelivered remainder
   * is carrying goods in — so the headline round trip this increment is named
   * for is precisely the case a kind-driven marker draws backwards.
   */
  haulPickedUp: boolean;
  /** Ticks remaining on the current leg — the dot's position is derived from it. */
  haulTicksLeft: number;
  /**
   * Ticks the CURRENT leg was charged when it began — the denominator
   * `haulTicksLeft` counts down against. Published so the layout can read the
   * leg's length instead of recomputing `haulTicks` from the building's LIVE
   * tile: a returning trip is deliberately left alone when its building moves,
   * so a recomputed total would silently disagree with the leg the sim is
   * actually running (OBS-5-01).
   */
  haulLegTicks: number;
  /**
   * BOTH endpoints of the leg currently being walked, frozen when it began
   * (`HaulTrip.startLeg`). With `haulLegTicks` and `haulTicksLeft` these place
   * the dot in ANY phase, which is what removes the last per-phase case from
   * the layout.
   *
   * Two pairs, where increment 5 published one (`haulPickupCol`/`Row`, named
   * for the return leg's pickup because that was the only leg the app drew from
   * it). A single site-end pair cannot describe this increment's trips: a leg
   * may begin from an ARBITRARY position — the fractional tile a cancellation
   * or a mid-leg re-price leaves behind — and neither end of a depot-to-building
   * leg is the camp, so nothing about it is re-derivable from a lone endpoint
   * plus a hardcoded anchor.
   *
   * Published rather than recomputed, for the reason `haulLegTicks` is: the
   * building (or depot) at either end can move mid-leg, and re-asking it for its
   * tile would draw the walk to a point this hauler never stood at (OBS-5-01).
   *
   * Meaningless while `haulPhase` is 'idle' — a cleared trip has no leg, and
   * these read 0. `haulAtCol`/`haulAtRow` below are what place an idle hauler.
   */
  haulLegFromCol: number;
  haulLegFromRow: number;
  haulLegToCol: number;
  haulLegToRow: number;
  /**
   * Where this hauler physically STANDS when no leg is running: the tile a
   * cancelled trip left them on, or the camp for one who has never moved. A
   * position rather than a site id, so a demolished storehouse leaves no
   * membership dangling, and never a plain 0 — an idle hauler drawn at (0, 0)
   * would stand in the map's corner rather than wherever their last trip ended.
   *
   * Only meaningful while `haulPhase` is 'idle'. It is the trip's own
   * `atCol`/`atRow`, which `cancel` writes and a running leg does not touch, so
   * mid-leg it still holds where the CURRENT trip started; the leg endpoints
   * above are what place a moving dot.
   */
  haulAtCol: number;
  haulAtRow: number;
  /**
   * Units in hand, in EITHER direction: a supply leg carries goods OUT to a
   * building just as a collect leg carries them home, so this stopped being
   * the "0 unless carrying a load home" figure increment 4 published the
   * moment two-way haul shipped. `haulPickedUp` says which way the load is
   * going; this says only how much of it there is. 0 while walking empty,
   * which is the whole of a fetch leg.
   */
  carrying: number;
  /** Remaining ticks of this worker's tool coverage (0 = none). */
  toolTicks: number;
  /** Ticks alive. Years are a display unit only — divide by BALANCE.yearTicks. */
  ageTicks: number;
  /** Derived from ageTicks, never stored: only an adult can be assigned. */
  stage: LifeStage;
  /** The house this colonist sleeps in, or null when homeless. */
  homeId: number | null;
  /**
   * Straight-line tiles from this colonist's bed to the tile they work at —
   * their assigned building, or the camp store for a hauler (whose trips both
   * begin and end there). 0 when they are housed with no job to walk to, and
   * 0 for a homeless colonist, who has no bed to measure from: their penalty
   * arrives through `commuteFactor` below instead.
   */
  commuteTiles: number;
  /**
   * The share of their work this colonist's placement actually delivers —
   * `commuteFactor` over `commuteTiles` when housed, `BALANCE.homelessFactor`
   * when not. Published rather than left for a view to re-derive: the distance
   * needs two entities' tiles, so anything recomputing it would be a second
   * source of truth for a number the simulation has already spent.
   */
  commuteFactor: number;
  /**
   * This colonist's own share of `workerWorkPower(efficiency, toolTicks,
   * commuteFactor)` — the exact expression `buildEntitySections` already sums
   * into `BuildingSnapshot.workPower` for the building they're assigned to.
   * Published per colonist rather than left for a view to recompute (that
   * would be a third copy of an expression two engine call sites already
   * share — see workerWorkPower's own doc comment), so the Population view
   * can show the number that actually reflects hunger, a lapsed tool AND a
   * bad commute together, not `efficiency` alone: a colonist can read 100%
   * there while a commute cuts what they actually deliver in half (OBS-6-06).
   *
   * Null, not 0, when this colonist is not assigned to a building: an idle
   * colonist and a hauler both have `buildingId === null`, and a hauler's
   * throughput is carried capacity, not work power (`haulerCapacity`,
   * HaulSystem charges their commute separately) — 0 would claim they
   * deliver nothing, which is true for the idle case but wrong for the
   * hauling one. Null reads the same as it does for `commuteTiles`: this
   * number does not apply here, rather than having been measured at zero.
   *
   * 0, not null, when the building they are assigned to is relocating: they
   * are assigned, work power is their unit, and ProductionSystem spends
   * exactly none of it while the move runs. See `deliveredWorkPowerOf` for
   * the one-tick overstatement that boundary keeps on the landing tick.
   */
  deliveredWorkPower: number | null;
}

export interface ResourceStats {
  stock: number;
  /**
   * Store inflow per tick. Since increment 4 goods reach the stockpile when a
   * hauler delivers them, not when they are made — the field is named for that
   * (it was `productionRate`, which described neither quantity once haulers
   * existed; see OBS-4-06).
   */
  deliveredRate: number;
  /** Units banked into output buffers per tick — gross production. */
  madeRate: number;
  consumptionRate: number;
  /** `deliveredRate - consumptionRate`: the STORE's net movement, which is what
   * a runway is computed from. Goods waiting in a buffer are not in the store. */
  netFlow: number;
  stockValue: number;
}

export interface Snapshot {
  tick: number;
  lastRecruitTick: number;
  /** Tick of the last birth, for the same reason lastRecruitTick is published:
   * the view derives "how long until the next one" rather than being told. */
  lastBirthTick: number;
  /**
   * Meals the store holds per colonist, counting one MORE colonist than there
   * are — the number both arrival gates test, published so the view shows the
   * figure the engine actually gates on rather than a second derivation of it.
   */
  mealsPerHead: number;
  /** The colony's world dimensions in tiles. */
  map: WorldMapSize;
  stockpile: Record<ResourceId, ResourceStats>;
  colonyWealth: number;
  population: number;
  idleAdults: number;
  /** Colonists with no home (ColonistSnapshot.homeId === null). Nobody is
   * homeless is the same condition rehome uses to decide a bed is free. */
  homeless: number;
  /** Beds actually available tonight, and how many are occupied. Excludes
   * relocating houses from `total` — see buildEntitySections. */
  beds: { total: number; occupied: number };
  /** Spec 2.13's stage counts, aggregated once beside population/idleAdults
   * rather than recomputed per view. */
  demographics: { children: number; adults: number; elders: number };
  buildings: BuildingSnapshot[];
  colonists: ColonistSnapshot[];
  /** Per-tick feedback (success and rejection alike); cleared after each snapshot. */
  notices: NoticeMessage[];
}

export interface EngineStatus {
  paused: boolean;
  speed: 1 | 2 | 4;
  error: string | null;
}
