import { createSystem, queryComponents, Read, ReadResource, WriteResource } from 'sim-ecs';
import type { BuildingSnapshot, ResourceStats, WorkerSnapshot } from '../../shared/snapshot';
import type { ResourceId } from '../../shared/content-types';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { RESOURCES, RESOURCE_IDS } from '../content/resources';
import { Building, Efficiency, Hunger, JobAssignment, Production, ToolCoverage, Worker, WorkerSlots } from '../components';
import { NoticeBoard, SimClock, SnapshotStore, StatsHistory, Stockpile } from '../resources';

export const SnapshotSystem = () => createSystem({
  clock: ReadResource(SimClock),
  stockpile: ReadResource(Stockpile),
  stats: ReadResource(StatsHistory),
  notices: WriteResource(NoticeBoard),
  store: WriteResource(SnapshotStore),
  buildings: queryComponents({
    building: Read(Building), slots: Read(WorkerSlots), production: Read(Production),
  }),
  workers: queryComponents({
    worker: Read(Worker), hunger: Read(Hunger), job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage),
  }),
})
  .withName('SnapshotSystem')
  // Split into one builder per snapshot section: keeps each unit's complexity
  // low and mirrors the shape of the Snapshot type being assembled.
  .withRunFunction(({ clock, stockpile, stats, notices, store, buildings, workers }) => {
    const staffCount = new Map<number, number>();
    const powerByBuilding = new Map<number, number>();
    const tooledByBuilding = new Map<number, number>();

    const buildWorkerSnaps = (): WorkerSnapshot[] => {
      const snaps: WorkerSnapshot[] = [];
      for (const { worker, hunger, job, efficiency, coverage } of workers.iter()) {
        snaps.push({
          id: worker.id,
          hunger: hunger.value,
          efficiency: efficiency.value,
          buildingId: job.buildingId,
          toolTicks: coverage.remainingTicks,
        });
        if (job.buildingId !== null) {
          const tooled = coverage.remainingTicks > 0;
          staffCount.set(job.buildingId, (staffCount.get(job.buildingId) ?? 0) + 1);
          powerByBuilding.set(
            job.buildingId,
            (powerByBuilding.get(job.buildingId) ?? 0) + efficiency.value * (tooled ? BALANCE.toolMultiplier : 1),
          );
          if (tooled) tooledByBuilding.set(job.buildingId, (tooledByBuilding.get(job.buildingId) ?? 0) + 1);
        }
      }
      snaps.sort((a, b) => a.id - b.id);
      return snaps;
    };

    // Depends on staffCount/powerByBuilding/tooledByBuilding, so must run after buildWorkerSnaps.
    const buildBuildingSnaps = (): BuildingSnapshot[] => {
      const snaps: BuildingSnapshot[] = [];
      for (const { building, slots, production } of buildings.iter()) {
        const def = BUILDINGS[building.defId];
        const staffed = staffCount.get(building.id) ?? 0;
        snaps.push({
          id: building.id,
          defId: building.defId,
          workers: staffed,
          workerSlots: slots.max,
          state: staffed === 0 ? 'unstaffed' : production.batchActive ? 'producing' : 'waitingForInput',
          progress: production.progress,
          batchActive: production.batchActive,
          progressPct: Math.min(100, Math.round((production.progress / def.recipe.ticksPerBatch) * 100)),
          tooledWorkers: tooledByBuilding.get(building.id) ?? 0,
          workPower: powerByBuilding.get(building.id) ?? 0,
        });
      }
      snaps.sort((a, b) => a.id - b.id);
      return snaps;
    };

    const buildStockpileStats = (): { stockpileStats: Record<ResourceId, ResourceStats>; colonyWealth: number } => {
      const stockpileStats = {} as Record<ResourceId, ResourceStats>;
      let colonyWealth = 0;
      for (const id of RESOURCE_IDS) {
        const stock = stockpile.get(id);
        const { production, consumption } = stats.rates(id);
        const stockValue = stock * RESOURCES[id].value;
        colonyWealth += stockValue;
        stockpileStats[id] = {
          stock,
          productionRate: production,
          consumptionRate: consumption,
          netFlow: production - consumption,
          stockValue,
        };
      }
      return { stockpileStats, colonyWealth };
    };

    const workerSnaps = buildWorkerSnaps();
    const buildingSnaps = buildBuildingSnaps();
    const { stockpileStats, colonyWealth } = buildStockpileStats();

    store.latest = {
      tick: clock.tick,
      lastRecruitTick: clock.lastRecruitTick,
      stockpile: stockpileStats,
      colonyWealth,
      population: workerSnaps.length,
      idleWorkers: workerSnaps.filter((w) => w.buildingId === null).length,
      buildings: buildingSnaps,
      workers: workerSnaps,
      notices: notices.takeAll(),
    };
  })
  .build();
