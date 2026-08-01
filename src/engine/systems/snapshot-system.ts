import { createSystem, queryComponents, Read, ReadResource, WriteResource } from 'sim-ecs';
import type { ResourceStats } from '../../shared/snapshot';
import type { ResourceId } from '../../shared/content-types';
import { RESOURCES, RESOURCE_IDS } from '../content/resources';
import { Building, Efficiency, HaulTrip, Hunger, JobAssignment, OutputBuffer, Position, Production, Relocation, ToolCoverage, Worker, WorkerSlots } from '../components';
import { NoticeBoard, SimClock, SnapshotStore, StatsHistory, Stockpile, WorldMap } from '../resources';
import type { BuildingFacts, WorkerFacts } from '../snapshot-builder';
import { buildEntitySections, buildingFactsOf, workerFactsOf } from '../snapshot-builder';

export const SnapshotSystem = () => createSystem({
  clock: ReadResource(SimClock),
  stockpile: ReadResource(Stockpile),
  stats: ReadResource(StatsHistory),
  notices: WriteResource(NoticeBoard),
  store: WriteResource(SnapshotStore),
  map: ReadResource(WorldMap),
  buildings: queryComponents({
    building: Read(Building), slots: Read(WorkerSlots), production: Read(Production), position: Read(Position), buffer: Read(OutputBuffer),
    relocation: Read(Relocation),
  }),
  workers: queryComponents({
    worker: Read(Worker), hunger: Read(Hunger), job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage), trip: Read(HaulTrip),
  }),
})
  .withName('SnapshotSystem')
  // Entity-derived sections (workers/buildings/population/idleWorkers) come from the
  // shared buildEntitySections builder; this system only gathers facts from its
  // queries and assembles the remaining stockpile/notices sections.
  .withRunFunction(({ clock, stockpile, stats, notices, store, map, buildings, workers }) => {
    // Fact shape lives in the shared mappers, never here: this system only
    // supplies component instances from its queries (see snapshot-builder).
    const workerFacts: WorkerFacts[] = [];
    for (const { worker, hunger, job, efficiency, coverage, trip } of workers.iter()) {
      workerFacts.push(workerFactsOf(worker, hunger, job, efficiency, coverage, trip));
    }

    const buildingFacts: BuildingFacts[] = [];
    for (const { building, slots, production, position, buffer, relocation } of buildings.iter()) {
      buildingFacts.push(buildingFactsOf(building, slots, production, position, buffer, relocation));
    }

    const { workers: workerSnaps, buildings: buildingSnaps, population, idleWorkers } = buildEntitySections(workerFacts, buildingFacts);

    const stockpileStats = {} as Record<ResourceId, ResourceStats>;
    let colonyWealth = 0;
    for (const id of RESOURCE_IDS) {
      const stock = stockpile.get(id);
      const { delivered, consumed, made } = stats.rates(id);
      const stockValue = stock * RESOURCES[id].value;
      colonyWealth += stockValue;
      stockpileStats[id] = {
        stock,
        deliveredRate: delivered,
        madeRate: made,
        consumptionRate: consumed,
        netFlow: delivered - consumed,
        stockValue,
      };
    }

    store.latest = {
      tick: clock.tick,
      lastRecruitTick: clock.lastRecruitTick,
      map: { cols: map.cols, rows: map.rows },
      stockpile: stockpileStats,
      colonyWealth,
      population,
      idleWorkers,
      buildings: buildingSnaps,
      workers: workerSnaps,
      notices: notices.takeAll(),
    };
  })
  .build();
