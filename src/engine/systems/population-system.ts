import { Actions, createSystem, queryComponents, Read, ReadEntity, Write, WriteResource } from 'sim-ecs';
import { Age, Colonist, HaulTrip, Hunger, JobAssignment } from '../components';
import { IdCounter, NoticeBoard, RemovalLedger, SimClock, Stockpile } from '../resources';
import { ageEveryone, resolveOldAge, standDownNonAdults, type PopulationContext } from './population-handlers';

/**
 * Spec 2.9 places this third, and both neighbours are load-bearing: AFTER
 * HungerSystem, so a starvation death reads this tick's hunger and a colonist
 * who found food this tick is spared; BEFORE EfficiencySystem and
 * ProductionSystem, so a colonist who retired or died this tick is unassigned
 * before work power is summed.
 *
 * Phase order within the tick is age -> deaths -> retirements, extended by
 * later tasks to -> homing -> births.
 */
export const PopulationSystem = () => createSystem({
  actions: Actions,
  clock: WriteResource(SimClock),
  stockpile: WriteResource(Stockpile),
  ids: WriteResource(IdCounter),
  notices: WriteResource(NoticeBoard),
  removals: WriteResource(RemovalLedger),
  colonists: queryComponents({
    entity: ReadEntity(), colonist: Read(Colonist), age: Write(Age), hunger: Read(Hunger),
    job: Write(JobAssignment), trip: Write(HaulTrip),
  }),
})
  .withName('PopulationSystem')
  .withRunFunction(({ actions, clock, stockpile, ids, notices, removals, colonists }) => {
    const ctx: PopulationContext = {
      clock, stockpile, ids, notices, removals,
      colonists: [...colonists.iter()].map(({ entity, colonist, age, hunger, job, trip }) =>
        ({ entity, colonist, age, hunger, job, trip })),
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
    standDownNonAdults(ctx);
  })
  .build();
