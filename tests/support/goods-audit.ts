import { createSystem, queryComponents, Read, ReadResource } from 'sim-ecs';
import type { BuildingDefId, ResourceId } from '../../src/shared/content-types';
import type { Snapshot } from '../../src/shared/snapshot';
import { BUILDINGS, unitsOf } from '../../src/engine/content/buildings';
import { HaulTrip, InputBuffer, OutputBuffer } from '../../src/engine/components';
import { ProductionLedger, Stockpile } from '../../src/engine/resources';
import { HungerSystem } from '../../src/engine/systems/hunger-system';
import { ProductionSystem } from '../../src/engine/systems/production-system';
import { StatsSystem } from '../../src/engine/systems/stats-system';
import type { TColonySystemFactory } from '../../src/engine/world';

/**
 * A CONSERVATION sentinel, shared by both harnesses because a second copy of
 * this arithmetic is exactly how one of the four places goods now live stops
 * being counted.
 *
 * The law it enforces, stated once:
 *
 *   opening holdings + gross production - recipe inputs paid - eaten
 *     + whatever commands and removals moved  ===  goods standing at the end
 *
 * counting every store site, every input and output buffer, and every load in
 * a hauler's hands. Increment 7 moves goods through four places plus a pair of
 * hands, and a leak anywhere in that chain would surface in a §4 figure as a
 * balance problem rather than as the bug it is.
 *
 * Both correction terms are load-bearing, and each was a defect in an earlier
 * draft of this instrument:
 *
 * - **Opening holdings.** The balance harness seeds FED of every recipe input
 *   before a run, so an equation starting from zero fails every scenario by
 *   its own starting inventory and detects nothing.
 * - **Recipe inputs.** `ProductionLedger` records GROSS output, so a sawmill
 *   turning one wood into one plank books a plank made while a wood
 *   disappears. Counting production without subtracting what it consumed makes
 *   every processed unit appear twice — and §4's headline scenarios are
 *   forester -> sawmill chains, so a correct run would fail this sentinel on
 *   its own conversions.
 */

/**
 * How goods moved during one tick, sampled at three points in the pipeline.
 * The windows between them are what let `eaten` and command-driven flow be
 * measured INDEPENDENTLY of production — an equation that derived them from
 * the same totals it checks would balance by construction and detect nothing.
 */
interface TickWindows {
  /** Total goods after CommandSystem: construction spends, demolition refunds. */
  afterCommands: number;
  /** After HungerSystem/PopulationSystem/EfficiencySystem: meals and tool wear. */
  beforeProduction: number;
  /** After ProductionSystem and HaulSystem — the window the sentinel PREDICTS. */
  afterHauling: number;
}

/** Every unit the colony owns wherever it stands, as the published snapshot
 * and the live ledger together report it. `stored` is a storehouse's share of
 * the same ledger `colonyStock` already sums, so it is deliberately not added
 * a second time. */
function goodsStanding(snapshot: Snapshot, stockpile: Stockpile): number {
  let total = unitsOf(stockpile.colonyStock());
  for (const building of snapshot.buildings) total += building.buffered + building.inputBuffered;
  for (const colonist of snapshot.colonists) total += colonist.carrying;
  return total;
}

/**
 * One producing def, reduced to the two numbers the input correction needs.
 *
 * A recipe is identified by its OUTPUT resource, which is what makes the batch
 * count recoverable from `ProductionLedger` alone. Two defs producing the same
 * resource, or one recipe with two outputs, would both make that recovery
 * ambiguous — so this throws rather than quietly halving a correction term.
 */
interface Producer {
  defId: BuildingDefId;
  output: ResourceId;
  perBatch: number;
  inputUnits: number;
}

function producersOf(): Producer[] {
  const producers: Producer[] = [];
  const seen = new Set<ResourceId>();
  for (const def of Object.values(BUILDINGS)) {
    if (def.recipe === null) continue;
    const outputs = Object.entries(def.recipe.outputs) as [ResourceId, number][];
    if (outputs.length !== 1) throw new Error(`goods audit: ${def.id} has ${outputs.length} outputs; a batch count cannot be recovered from one resource`);
    const [output, perBatch] = outputs[0];
    if (seen.has(output)) throw new Error(`goods audit: ${output} is produced by more than one def; its batch count is ambiguous`);
    seen.add(output);
    producers.push({ defId: def.id, output, perBatch, inputUnits: unitsOf(def.recipe.inputs) });
  }
  return producers;
}

const PRODUCERS = producersOf();

/** Buildings of each def with a batch paid for and not yet banked. Inputs are
 * paid when a batch STARTS and output is booked when it finishes, so a run that
 * ends mid-batch has paid for one more batch than the ledger recorded. */
function activeBatches(snapshot: Snapshot): Map<BuildingDefId, number> {
  const active = new Map<BuildingDefId, number>();
  for (const building of snapshot.buildings) {
    if (building.batchActive) active.set(building.defId, (active.get(building.defId) ?? 0) + 1);
  }
  return active;
}

/** The audit's closing figures — every term of the law in the header, so a
 * failing run says WHICH term is out rather than only that something is. */
export interface GoodsAuditResult {
  opening: number;
  /** Gross units banked into output buffers, every resource, from
   * `ProductionLedger` — never reconstructed from where goods are standing. */
  made: number;
  /** Units recipes paid out of input buffers, batches in flight included. */
  recipeInputs: number;
  /** Meals and tool wear: the drop across Hunger/Population/Efficiency. */
  eaten: number;
  /** Construction spends, demolition refunds and losses — the change across
   * CommandSystem, and with it the PREVIOUS tick's removal drain, which runs
   * between the two probes. Zero in a scenario that builds and demolishes
   * nothing, and worth asserting as such: it is where a depot's lost stock
   * would hide. */
  commandFlow: number;
  /** The same, for the drain after the LAST tick — the only one no window
   * covers. */
  removalFlow: number;
  final: number;
  /** `final` minus what the law predicts. MUST be 0. */
  conservationError: number;
}

export class GoodsAudit {
  private opening = 0;
  private openingActive = new Map<BuildingDefId, number>();
  private previousEnd = 0;
  private endOfTick = 0;
  private commandFlow = 0;
  private eaten = 0;
  private readonly windows: TickWindows = { afterCommands: 0, beforeProduction: 0, afterHauling: 0 };
  private readonly madeByResource = new Map<ResourceId, number>();
  private readonly deliveredByResource = new Map<ResourceId, number>();

  /** Gross units of one resource banked into output buffers over the run —
   * THE production figure, and the reason `made` is no longer derived from
   * where goods are standing. */
  madeOf(resource: ResourceId): number {
    return this.madeByResource.get(resource) ?? 0;
  }

  /** Cumulative hauler inflow of one resource: the running sum of every
   * deposit banked into the stockpile, not the stockpile's net change (which
   * nets out whatever hunger ate of the same resource and can go negative). */
  deliveredOf(resource: ResourceId): number {
    return this.deliveredByResource.get(resource) ?? 0;
  }

  /**
   * `systems` with three probes spliced in, at the three points the windows
   * above are measured between. Every real system keeps its place and its
   * relative order — `assertSystemOrder` skips factories that are not in
   * `ALL_SYSTEMS`, so a probe displaces nothing.
   */
  instrument(systems: readonly TColonySystemFactory[]): TColonySystemFactory[] {
    let wired = [...systems];
    const probes: [TColonySystemFactory, Probe][] = [
      [HungerSystem, (goods) => { this.windows.afterCommands = goods; }],
      [ProductionSystem, (goods) => { this.windows.beforeProduction = goods; }],
      [StatsSystem, (goods, stockpile, ledger) => {
        this.windows.afterHauling = goods;
        accumulate(this.madeByResource, ledger.madeThisTick);
        accumulate(this.deliveredByResource, stockpile.producedThisTick);
      }],
    ];
    for (const [anchor, onSample] of probes) {
      const at = wired.indexOf(anchor);
      if (at === -1) throw new Error('goods audit: the pipeline is missing a system the sentinel measures between');
      wired = [...wired.slice(0, at), goodsProbe(onSample), ...wired.slice(at)];
    }
    return wired;
  }

  /** The opening holdings, read before the first tick. */
  open(snapshot: Snapshot, stockpile: Stockpile): void {
    this.opening = goodsStanding(snapshot, stockpile);
    this.previousEnd = this.opening;
    this.endOfTick = this.opening;
    this.openingActive = activeBatches(snapshot);
  }

  /** Called by the harness once per tick, after `world.step()`: closes the
   * tick's windows into the running totals. Separate from the probes because
   * the arithmetic needs all three samples, and only the driver knows a tick
   * has finished. */
  closeTick(): void {
    this.commandFlow += this.windows.afterCommands - this.previousEnd;
    // A SINK, so it counts the drop: goods only ever leave the colony across
    // this window, and the law subtracts it.
    this.eaten += this.windows.afterCommands - this.windows.beforeProduction;
    this.endOfTick = this.windows.afterHauling;
    this.previousEnd = this.endOfTick;
  }

  close(snapshot: Snapshot, stockpile: Stockpile): GoodsAuditResult {
    const final = goodsStanding(snapshot, stockpile);
    let made = 0;
    for (const amount of this.madeByResource.values()) made += amount;
    const recipeInputs = this.recipeInputsPaid(snapshot);
    const removalFlow = final - this.endOfTick;
    const predicted = this.opening + made - recipeInputs - this.eaten + this.commandFlow + removalFlow;
    return {
      opening: this.opening,
      made,
      recipeInputs,
      eaten: this.eaten,
      commandFlow: this.commandFlow,
      removalFlow,
      final,
      conservationError: final - predicted,
    };
  }

  /** Units every recipe paid out of an input buffer: one batch's inputs per
   * batch the ledger recorded, plus the batch each building is standing in the
   * middle of, less any that was already running when the run opened. */
  private recipeInputsPaid(snapshot: Snapshot): number {
    const active = activeBatches(snapshot);
    let paid = 0;
    for (const producer of PRODUCERS) {
      if (producer.inputUnits === 0) continue;
      const batches = this.madeOf(producer.output) / producer.perBatch;
      const inFlight = (active.get(producer.defId) ?? 0) - (this.openingActive.get(producer.defId) ?? 0);
      paid += (batches + inFlight) * producer.inputUnits;
    }
    return paid;
  }
}

/** What one probe reports: the world's whole goods total, plus the live flow
 * maps for the one probe that runs where a tick's flows are still intact. */
type Probe = (goods: number, stockpile: Stockpile, ledger: ProductionLedger) => void;

/**
 * One sample of every unit of goods in the world, taken from live components
 * rather than from a snapshot — a probe runs mid-tick, where no snapshot for
 * this tick exists yet.
 *
 * The flow maps are handed on rather than read here because only the probe
 * immediately before `StatsSystem` sees them full: that system records and
 * then clears both at the end of every tick, so it is the one point at which
 * a tick's deliveries and gross production are still intact.
 */
function goodsProbe(onSample: Probe): TColonySystemFactory {
  return () => createSystem({
    stockpile: ReadResource(Stockpile),
    ledger: ReadResource(ProductionLedger),
    buildings: queryComponents({ input: Read(InputBuffer), output: Read(OutputBuffer) }),
    carriers: queryComponents({ trip: Read(HaulTrip) }),
  })
    .withName('GoodsProbe')
    .withRunFunction(({ stockpile, ledger, buildings, carriers }) => {
      let goods = unitsOf(stockpile.colonyStock());
      for (const { input, output } of buildings.iter()) goods += input.total() + output.total();
      for (const { trip } of carriers.iter()) goods += trip.amount;
      onSample(goods, stockpile, ledger);
    })
    .build();
}

/** Add one tick's flow map into a running total. */
function accumulate(running: Map<ResourceId, number>, tick: ReadonlyMap<ResourceId, number>): void {
  for (const [id, amount] of tick) running.set(id, (running.get(id) ?? 0) + amount);
}
