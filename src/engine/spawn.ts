import type { BuildingDefId, ResourceId } from '../shared/content-types';
import { BALANCE } from './content/balance';
import { BUILDINGS } from './content/buildings';
import { RESOURCE_IDS } from './content/resources';
import {
  Building, Efficiency, HaulTrip, Hunger, JobAssignment, OutputBuffer, Position, Production, Relocation, ToolCoverage, Colonist,
  WorkerSlots,
} from './components';

/**
 * The one place each entity kind's component set is written down.
 *
 * An entity can enter the world by two independent paths — restored from a save
 * (`spawnBuilding`/`spawnColonist` in world.ts, at preptime) or created live by a
 * command (`handleConstructBuilding`/`handleRecruitWorker`, at runtime) — and
 * each used to list its own components. Forgetting one was silent, and it bit
 * twice inside a single increment: buildings constructed during play had no
 * `OutputBuffer`, and workers recruited during play had no `HaulTrip`, which
 * dropped them out of snapshots entirely because the snapshot query requires it
 * (OBS-4-02). The paths differ only in where initial values come from and in how
 * components get attached, never in *which* components an entity needs — so both
 * fill one of the specs below and the list exists exactly once.
 *
 * Adding a component is now one edit here. `COMPONENT_TYPES` in world.ts still
 * needs the type appended for save/restore round-tripping, and the parity tests
 * in tests/engine/systems/command-system.test.ts pin both entity kinds.
 */

/**
 * Balance-coupled clamps (spec 4.5 — saves survive balancing changes). A save
 * written under a larger recipe, `hungerMax` or `toolDurationTicks` still loads;
 * its values come down to what current balance allows instead of the load guard
 * rejecting the save. `isLoadableSave` deliberately does not bounds-check these.
 *
 * They live here because three callers must agree on them: both spawn paths, and
 * `buildInitialSnapshot`, which seeds a snapshot that has to match the entities
 * actually spawned. That third mirror was maintained by hand and by comment.
 */
export function clampedProgress(defId: BuildingDefId, progress: number): number {
  return Math.min(progress, BUILDINGS[defId].recipe.ticksPerBatch);
}

export function clampedHunger(hunger: number): number {
  return Math.min(hunger, BALANCE.hungerMax);
}

export function clampedToolTicks(toolTicks: number): number {
  return Math.min(toolTicks, BALANCE.toolDurationTicks);
}

/**
 * A saved relocation countdown, clamped to what current balance can produce.
 * Exported (promoted back from module-private) because `buildInitialSnapshot`
 * in world.ts now needs it: the seeded snapshot's `relocatingTicks` fact must
 * be clamped the same way `buildingComponents` below clamps the live
 * `Relocation` component, or the two would disagree about a saved building
 * that outlived a balance retune (same principle as clampedProgress,
 * clampedHunger and clampedToolTicks above).
 */
export function clampedRelocation(ticksLeft: number): number {
  return Math.max(0, Math.min(ticksLeft, BALANCE.maxRelocationTicks));
}

/**
 * A saved buffer trimmed to the CURRENT cap, counted across all resources in
 * catalog order. An over-cap buffer loads and trims rather than being refused.
 */
export function clampedBuffer(saved: Partial<Record<ResourceId, number>>): Map<ResourceId, number> {
  const buffer = new Map<ResourceId, number>();
  let total = 0;
  for (const id of RESOURCE_IDS) {
    const amount = saved[id] ?? 0;
    if (amount <= 0) continue;
    const room = BALANCE.outputBufferCap - total;
    if (room <= 0) break;
    const kept = Math.min(amount, room);
    buffer.set(id, kept);
    total += kept;
  }
  return buffer;
}

/** Initial values for a building, from a save record or from a build command. */
export interface BuildingSpec {
  id: number;
  defId: BuildingDefId;
  col: number;
  row: number;
  progress?: number;
  batchActive?: boolean;
  buffer?: Partial<Record<ResourceId, number>>;
  relocatingTicks?: number;
}

/** Every component a building needs, in one list. Order is not significant. */
export function buildingComponents(spec: BuildingSpec): object[] {
  return [
    new Building(spec.id, spec.defId),
    new WorkerSlots(BUILDINGS[spec.defId].workerSlots),
    new Production(clampedProgress(spec.defId, spec.progress ?? 0), spec.batchActive ?? false),
    new Position(spec.col, spec.row),
    new OutputBuffer(clampedBuffer(spec.buffer ?? {})),
    new Relocation(clampedRelocation(spec.relocatingTicks ?? 0)),
  ];
}

/** Initial values for a worker, from a save record or from a recruit command. */
export interface ColonistSpec {
  id: number;
  hunger?: number;
  buildingId?: number | null;
  hauling?: boolean;
  efficiency?: number;
  toolTicks?: number;
}

/** Every component a worker needs, in one list. Order is not significant. */
export function colonistComponents(spec: ColonistSpec): object[] {
  return [
    new Colonist(spec.id),
    new Hunger(clampedHunger(spec.hunger ?? 0)),
    new JobAssignment(spec.buildingId ?? null, spec.hauling ?? false),
    new Efficiency(spec.efficiency ?? 1),
    new ToolCoverage(clampedToolTicks(spec.toolTicks ?? 0)),
    // Runtime-only, never saved — but every worker carries one, so a hauler can
    // be assigned without the snapshot query losing sight of them.
    new HaulTrip(),
  ];
}
