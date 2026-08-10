import { Actions, createSystem, queryComponents, Read, ReadEntity, Write, WriteResource } from 'sim-ecs';
import { isRelocating } from '../../shared/placement';
import { BUILDINGS } from '../content/buildings';
import { storeSitesFrom } from './haul-dispatch';
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
    const buildingRows = [...buildings.iter()];
    const ctx: PopulationContext = {
      clock, stockpile, ids, notices, removals, pending,
      colonists: [...colonists.iter()].map(({ entity, colonist, age, hunger, job, trip, home }) =>
        ({ entity, colonist, age, hunger, job, trip, home })),
      // A dying hauler's load has to land somewhere real (§2.7). Derived from
      // the same rows the shelters below are, through the same helper
      // HaulSystem uses, so a relocating or same-tick-demolished storehouse is
      // no more a destination here than it is there.
      sites: storeSitesFrom(buildingRows, pending),
      shelters: [
        ...buildingRows
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
            relocating: isRelocating(relocation.ticksLeft),
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
    // AFTER THE DEATHS is the load-bearing half, and it is pinned by a test:
    // a colonist who starves on the very tick they cross a band must not also
    // be announced as retiring. Sitting after the stand-down rather than
    // before it is only legibility — the notice then reads as a report on a
    // settled fact — and its one observable effect is the order of two
    // messages within a tick, which nothing depends on.
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
