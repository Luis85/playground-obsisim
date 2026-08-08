import { Actions, createSystem, queryComponents, Read, ReadEntity, Write, WriteResource } from 'sim-ecs';
import { BUILDINGS } from '../content/buildings';
import { Age, Building, Colonist, HaulTrip, Home, Hunger, JobAssignment, Position, Relocation } from '../components';
import { IdCounter, NoticeBoard, PendingChanges, RemovalLedger, SimClock, Stockpile } from '../resources';
import { ageEveryone, rehome, resolveOldAge, resolveStarvation, standDownNonAdults, type PopulationContext } from './population-handlers';

/**
 * Spec 2.9 places this third, and both neighbours are load-bearing: AFTER
 * HungerSystem, so a starvation death reads this tick's hunger and a colonist
 * who found food this tick is spared; BEFORE EfficiencySystem and
 * ProductionSystem, so a colonist who retired or died this tick is unassigned
 * before work power is summed.
 *
 * Phase order within the tick is age -> deaths -> retirements -> homing,
 * extended by later tasks to -> births.
 */
export const PopulationSystem = () => createSystem({
  actions: Actions,
  clock: WriteResource(SimClock),
  stockpile: WriteResource(Stockpile),
  ids: WriteResource(IdCounter),
  notices: WriteResource(NoticeBoard),
  removals: WriteResource(RemovalLedger),
  pending: WriteResource(PendingChanges),
  colonists: queryComponents({
    entity: ReadEntity(), colonist: Read(Colonist), age: Write(Age), hunger: Read(Hunger),
    job: Write(JobAssignment), trip: Write(HaulTrip), home: Write(Home),
  }),
  buildings: queryComponents({ building: Read(Building), position: Read(Position), relocation: Read(Relocation) }),
})
  .withName('PopulationSystem')
  .withRunFunction(({ actions, clock, stockpile, ids, notices, removals, pending, colonists, buildings }) => {
    const ctx: PopulationContext = {
      clock, stockpile, ids, notices, removals, pending,
      colonists: [...colonists.iter()].map(({ entity, colonist, age, hunger, job, trip, home }) =>
        ({ entity, colonist, age, hunger, job, trip, home })),
      shelters: [...buildings.iter()]
        .filter(({ building }) => BUILDINGS[building.defId].beds > 0)
        .map(({ building, position, relocation }) => ({
          id: building.id,
          beds: BUILDINGS[building.defId].beds,
          col: position.col,
          row: position.row,
          // > 1, not > 0: ProductionSystem decrements this same countdown
          // LATER in this same tick (it runs after PopulationSystem in
          // ALL_SYSTEMS order). At ticksLeft === 1, the house is about to land
          // — by the time SnapshotSystem publishes, ProductionSystem will
          // already have brought it to 0, so the snapshot reports it as
          // landed. Reading `> 0` here would evict its residents THIS tick on
          // the strength of a countdown that reaches 0 before the tick ends,
          // publishing a landed house with empty beds beside colonists shown
          // homeless — a contradiction that only self-corrects next tick, and
          // sits on screen indefinitely if the player is paused. `> 1` asks
          // the question homing actually needs answered: will this house
          // still be relocating once this tick is done?
          relocating: relocation.ticksLeft > 1,
        })),
      spawn: (...components) => {
        let entity = actions.commands.buildEntity();
        for (const component of components) entity = entity.with(component);
        entity.build();
      },
      remove: (entity) => actions.commands.removeEntity(entity),
      deadIds: new Set<number>(),
    };
    ageEveryone(ctx);
    resolveOldAge(ctx);
    resolveStarvation(ctx);
    standDownNonAdults(ctx);
    rehome(ctx);
    // By the next tick, real entities are in the query — an arrival is no
    // longer pending-only, and a demolished building is gone rather than
    // merely marked. Counting either again would double-count the arrival and
    // keep the demolished building's beds excluded forever. Through ctx (not
    // the raw destructured resource), matching every other mutation in this
    // function.
    ctx.pending.clear();
  })
  .build();
