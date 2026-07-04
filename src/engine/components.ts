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
