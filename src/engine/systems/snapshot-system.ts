import { createSystem, queryComponents, Read, ReadResource, WriteResource } from 'sim-ecs';
import type { ResourceStats } from '../../shared/snapshot';
import type { ResourceId } from '../../shared/content-types';
import { RESOURCES, RESOURCE_IDS } from '../content/resources';
import {
  Age, Building, Construction, Efficiency, HaulTrip, Home, Hunger, InputBuffer, JobAssignment, OutputBuffer, Position, Production,
  Relocation, ToolCoverage, Colonist, WorkerSlots,
} from '../components';
import { NoticeBoard, SimClock, SnapshotStore, StatsHistory, Stockpile, WorldMap } from '../resources';
import type { ColonistFacts } from '../snapshot-builder';
import { buildEntitySections, colonistFactsOf } from '../snapshot-builder';
import type { BuildingFacts } from '../snapshot-buildings';
import { buildingFactsOf } from '../snapshot-buildings';

export const SnapshotSystem = () => createSystem({
  clock: ReadResource(SimClock),
  stockpile: ReadResource(Stockpile),
  stats: ReadResource(StatsHistory),
  notices: WriteResource(NoticeBoard),
  store: WriteResource(SnapshotStore),
  map: ReadResource(WorldMap),
  buildings: queryComponents({
    building: Read(Building), slots: Read(WorkerSlots), production: Read(Production), position: Read(Position), buffer: Read(OutputBuffer),
    relocation: Read(Relocation), input: Read(InputBuffer), construction: Read(Construction),
  }),
  workers: queryComponents({
    worker: Read(Colonist), hunger: Read(Hunger), job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage), trip: Read(HaulTrip),
    age: Read(Age), home: Read(Home),
  }),
})
  .withName('SnapshotSystem')
  // Entity-derived sections (workers/buildings/population/idleAdults) come from the
  // shared buildEntitySections builder; this system only gathers facts from its
  // queries and assembles the remaining stockpile/notices sections.
  .withRunFunction(({ clock, stockpile, stats, notices, store, map, buildings, workers }) => {
    // Fact shape lives in the shared mappers, never here: this system only
    // supplies component instances from its queries (see snapshot-builder).
    const workerFacts: ColonistFacts[] = [];
    for (const { worker, hunger, job, efficiency, coverage, trip, age, home } of workers.iter()) {
      workerFacts.push(colonistFactsOf(worker, hunger, job, efficiency, coverage, trip, age, home));
    }

    const buildingFacts: BuildingFacts[] = [];
    for (const { building, slots, production, position, buffer, relocation, input, construction } of buildings.iter()) {
      // siteJSON per building: a storehouse's stock is a fact ABOUT that
      // building for everything downstream (the save, and any surface that
      // shows what a depot holds), even though it lives in the ledger.
      buildingFacts.push(buildingFactsOf(
        building, slots, production, position, buffer, relocation, input, stockpile.siteJSON(building.id), construction,
      ));
    }

    // colonyStock, not toJSON: mealsPerHead answers "how long can the colony
    // eat", and it eats out of every site — reading the camp alone underreports
    // by whatever the storehouses hold.
    const {
      colonists: workerSnaps, buildings: buildingSnaps, population, idleAdults, homeless, beds, demographics, mealsPerHead,
    } = buildEntitySections(workerFacts, buildingFacts, stockpile.colonyStock());

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
      lastBirthTick: clock.lastBirthTick,
      mealsPerHead,
      map: { cols: map.cols, rows: map.rows },
      stockpile: stockpileStats,
      colonyWealth,
      population,
      idleAdults,
      homeless,
      beds,
      demographics,
      buildings: buildingSnaps,
      colonists: workerSnaps,
      notices: notices.takeAll(),
    };
  })
  .build();
