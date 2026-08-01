import type { BuildingDefId, ResourceId } from './content-types';
import type { HaulPhase } from './haul';
import type { WorldMapSize } from './placement';

export type BuildingState = 'producing' | 'waitingForInput' | 'unstaffed' | 'outputFull';

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
  /** Effective work per tick: sum of assigned worker efficiencies x per-worker tool multiplier. */
  workPower: number;
  /** Units waiting in this building's output buffer for a hauler. */
  buffered: number;
}

export interface WorkerSnapshot {
  id: number;
  hunger: number;
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
  /** Ticks remaining on the current leg — the dot's position is derived from it. */
  haulTicksLeft: number;
  /** Units in hand (0 unless carrying a load home). */
  carrying: number;
  /** Remaining ticks of this worker's tool coverage (0 = none). */
  toolTicks: number;
}

export interface ResourceStats {
  stock: number;
  productionRate: number;
  consumptionRate: number;
  netFlow: number;
  stockValue: number;
}

export interface Snapshot {
  tick: number;
  lastRecruitTick: number;
  /** The colony's world dimensions in tiles. */
  map: WorldMapSize;
  stockpile: Record<ResourceId, ResourceStats>;
  colonyWealth: number;
  population: number;
  idleWorkers: number;
  buildings: BuildingSnapshot[];
  workers: WorkerSnapshot[];
  /** Per-tick feedback (success and rejection alike); cleared after each snapshot. */
  notices: NoticeMessage[];
}

export interface EngineStatus {
  paused: boolean;
  speed: 1 | 2 | 4;
  error: string | null;
}
