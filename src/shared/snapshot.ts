import type { BuildingDefId, ResourceId } from './content-types';

export type BuildingState = 'producing' | 'waitingForInput' | 'unstaffed';

export interface BuildingSnapshot {
  id: number;
  defId: BuildingDefId;
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
}

export interface WorkerSnapshot {
  id: number;
  hunger: number;
  efficiency: number;
  buildingId: number | null;
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
  stockpile: Record<ResourceId, ResourceStats>;
  colonyWealth: number;
  population: number;
  idleWorkers: number;
  buildings: BuildingSnapshot[];
  workers: WorkerSnapshot[];
  /** Command rejections etc. from this tick; cleared after each snapshot. */
  notices: string[];
}

export interface EngineStatus {
  paused: boolean;
  speed: 1 | 2 | 4;
  error: string | null;
}
