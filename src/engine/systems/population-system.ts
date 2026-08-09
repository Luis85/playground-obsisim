import { Actions, createSystem, queryComponents, Read, ReadEntity, Write, WriteResource } from 'sim-ecs';
import { BUILDINGS } from '../content/buildings';
import { Age, Building, Colonist, HaulTrip, Home, Hunger, JobAssignment, Position, Relocation } from '../components';
import { IdCounter, NoticeBoard, PendingChanges, RemovalLedger, SimClock, Stockpile } from '../resources';
import {
  ageEveryone, announceBandChanges, rehome, resolveOldAge, resolveStarvation, standDownNonAdults, tryBirth,
  type PopulationContext,
} from './population-handlers';

/**
 * Spec 2.9 places this third, and both neighbours are load-bearing: AFTER
 * HungerSystem, so a starvation death reads this tick's hunger and a colonist
 * who found food this tick is spared; BEFORE EfficiencySystem and
 * ProductionSystem, so a colonist who retired or died this tick is unassigned
 * before work power is summed.
 *
 * Phase order within the tick is age -> deaths -> retirements -> band notices
 * -> homing, extended by later tasks to -> births.
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
      shelters: [
        ...[...buildings.iter()]
          .filter(({ building }) => BUILDINGS[building.defId].beds > 0)
          .map(({ building, position, relocation }) => ({
            id: building.id,
            beds: BUILDINGS[building.defId].beds,
            col: position.col,
            row: position.row,
            // > 0: is this house relocating RIGHT NOW? The decrement to 0 happens
            // LATER this same tick, in ProductionSystem — relocation downtime is
            // a production stall (increment 5 §2.4), which is why that system
            // owns the countdown. So on the tick ticksLeft counts down from 1 to
            // 0, homing still reads the pre-decrement 1 and keeps residents
            // homeless through it, rehoming them only the tick after — a
            // one-tick lag, accepted deliberately. The alternative (`> 1`) reads
            // that same landing tick as already-not-relocating and rehomes a
            // tick early, handing sumWorkPower's full placementFactor to
            // residents whose house is still mid-move for a tick genuinely
            // charged as downtime.
            relocating: relocation.ticksLeft > 0,
          })),
        // Buildings constructed THIS tick (PendingChanges.constructed):
        // invisible to the `buildings` query above until the post-step sync,
        // but a colonist must still be able to move in on the very tick the
        // house goes up — see PendingChanges' own doc comment. Always
        // `relocating: false`, never read from a Relocation component: a
        // building just spawned via buildingComponents always starts with
        // Relocation.ticksLeft === 0, so it cannot be mid-move on the tick it
        // is built.
        ...pending.constructed
          .filter((c) => BUILDINGS[c.defId].beds > 0)
          .map((c) => ({ id: c.id, beds: BUILDINGS[c.defId].beds, col: c.col, row: c.row, relocating: false })),
      ],
      spawn: (...components) => {
        let entity = actions.commands.buildEntity();
        for (const component of components) entity = entity.with(component);
        entity.build();
      },
      deadIds: new Set<number>(),
    };
    ageEveryone(ctx);
    resolveOldAge(ctx);
    resolveStarvation(ctx);
    standDownNonAdults(ctx);
    // After the stand-down, not before: the notice reports a settled fact, so
    // "retired" is published once the job slot it freed is already free. After
    // the deaths for a load-bearing reason — see announceBandChanges.
    announceBandChanges(ctx);
    rehome(ctx);
    // Births LAST, after homing, so "a free bed exists" and "nobody is
    // homeless" are the same condition and the gate can test either.
    tryBirth(ctx);
    // Homing does NOT clear ctx.pending, though it used to. ProductionSystem
    // and HaulSystem run later in the same tick and resolve a colonist's
    // homeId to a tile; clearing here left them blind to a house built this
    // tick, so they charged its brand-new residents homelessFactor on the
    // tick homing had just housed them. CommandSystem clears at the top of
    // the next tick instead — see the comment there.
  })
  .build();
