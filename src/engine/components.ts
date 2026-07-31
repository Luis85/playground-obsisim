import type { BuildingDefId } from '../shared/content-types';

export class Building {
  constructor(public id: number, public defId: BuildingDefId) {}
}

export class WorkerSlots {
  constructor(public max: number) {}
}

export class Production {
  constructor(public progress = 0, public batchActive = false) {}
}

export class ToolCoverage {
  constructor(public remainingTicks = 0) {}
}

export class Worker {
  constructor(public id: number) {}
}

export class Hunger {
  constructor(public value = 0) {}
}

export class JobAssignment {
  constructor(public buildingId: number | null = null) {}
}

export class Efficiency {
  constructor(public value = 1) {}
}

/** A building's tile on the world map. Workers have none: their spots stay
 * derived by the app-layer layout (spec §2.3). */
export class Position {
  constructor(public col: number, public row: number) {}
}
