import { Actions, createSystem, queryComponents, Read, ReadEntity, ReadResource, Write, WriteResource } from 'sim-ecs';
import type { Command } from '../../shared/commands';
import { stageOf } from '../../shared/population';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { MEAL_WEIGHTS } from '../content/resources';
import { spareBeds } from './population-handlers';
import { Age, Building, HaulTrip, Home, JobAssignment, OutputBuffer, Position, Relocation, WorkerSlots } from '../components';
import { CommandQueue, IdCounter, NoticeBoard, PendingChanges, RemovalLedger, SimClock, Stockpile, WorldMap } from '../resources';
import {
  type CommandContext,
  handleAssignHauler, handleAssignWorker, handleConstructBuilding, handleDemolishBuilding, handleMoveBuilding, handleRecruitWorker,
  handleUnassignHauler, handleUnassignWorker,
} from './command-handlers';

/** One command, one handler — the mapping the drain loop dispatches every
 * queued command through. */
function dispatchCommand(ctx: CommandContext, command: Command): void {
  switch (command.type) {
    case 'constructBuilding': handleConstructBuilding(ctx, command); break;
    case 'recruitWorker': handleRecruitWorker(ctx); break;
    case 'assignWorker': handleAssignWorker(ctx, command); break;
    case 'unassignWorker': handleUnassignWorker(ctx, command); break;
    case 'demolishBuilding': handleDemolishBuilding(ctx, command); break;
    case 'moveBuilding': handleMoveBuilding(ctx, command); break;
    case 'assignHauler': handleAssignHauler(ctx); break;
    case 'unassignHauler': handleUnassignHauler(ctx); break;
  }
}

export const CommandSystem = () => createSystem({
  actions: Actions,
  queue: WriteResource(CommandQueue),
  clock: WriteResource(SimClock),
  stockpile: WriteResource(Stockpile),
  ids: WriteResource(IdCounter),
  notices: WriteResource(NoticeBoard),
  removals: WriteResource(RemovalLedger),
  pending: WriteResource(PendingChanges),
  map: ReadResource(WorldMap),
  buildings: queryComponents({
    entity: ReadEntity(), building: Read(Building), slots: Read(WorkerSlots), position: Write(Position), buffer: Write(OutputBuffer),
    relocation: Write(Relocation),
  }),
  // JobAssignment alone identifies a worker entity — the Colonist component
  // added nothing the handlers read.
  workers: queryComponents({ job: Write(JobAssignment), trip: Write(HaulTrip), age: Read(Age), home: Write(Home) }),
})
  .withName('CommandSystem')
  // Handlers live in command-handlers.ts, one small function per command
  // type; this run function only materializes the query rows into a context
  // and drains the queue through dispatchCommand.
  .withRunFunction(({ actions, queue, clock, stockpile, ids, notices, removals, pending, map, buildings, workers }) => {
    // Discard the PREVIOUS tick's pending changes, before anything populates
    // this tick's. It used to happen at the end of PopulationSystem, on the
    // reasoning that homing was the last reader — but it was not:
    // ProductionSystem and HaulSystem run later still and resolve a
    // colonist's homeId to a tile, so clearing at homing left them unable to
    // see a house built this tick and charging its new residents
    // homelessFactor on the very tick they were housed.
    //
    // Clearing at the START of the first system instead means every system in
    // the tick sees the same pending set, and the invariant stops depending
    // on which system happens to read last. CommandSystem is first in
    // ALL_SYSTEMS and its handlers are the only writers, so nothing this
    // clear discards was produced by the tick now beginning.
    pending.clear();
    const ctx: CommandContext = {
      clock, stockpile, ids, notices, map,
      buildings: [...buildings.iter()].map(({ entity, building, slots, position, buffer, relocation }) => ({ entity, building, slots, position, buffer, relocation })),
      workers: [...workers.iter()].map(({ job, trip, age, home }) => ({ job, trip, home, stage: stageOf(age.ticks, BALANCE.lifeBands) })),
      spawn: (...components) => {
        let entity = actions.commands.buildEntity();
        for (const component of components) entity = entity.with(component);
        entity.build();
      },
      claimedTiles: [],
      removals,
      pending,
      demolishedIds: new Set<number>(),
      // Same shape PopulationContext uses, from the same query rows, so the
      // bed the nomad gate counts and the bed rehome later honours are one
      // description rather than two that can drift.
      //
      // A function, not a value — the precedent is `occupancy` just below,
      // whose own comment says a demolition earlier in the drain changes it;
      // the same is true here for a relocation (mutates the live Relocation
      // component `handleMoveBuilding` writes into) and a construction
      // (invisible to the `buildings` query above until the post-step sync,
      // which is why `pending.constructed` is folded in exactly as
      // PopulationContext's shelters does). A frozen array baked in whatever
      // was true at context construction and let a house drained into
      // relocating THIS tick keep sheltering a nomad seated moments later.
      shelters: () => [
        ...ctx.buildings
          .filter(({ building }) => BUILDINGS[building.defId].beds > 0)
          .map(({ building, position, relocation }) => ({
            id: building.id,
            beds: BUILDINGS[building.defId].beds,
            col: position.col,
            row: position.row,
            relocating: relocation.ticksLeft > 0,
          })),
        ...pending.constructed
          .filter((c) => BUILDINGS[c.defId].beds > 0)
          .map((c) => ({ id: c.id, beds: BUILDINGS[c.defId].beds, col: c.col, row: c.row, relocating: false })),
      ],
      occupancy: () => {
        const byHouse = new Map<number, number>();
        for (const { home } of ctx.workers) {
          if (home.buildingId !== null) byHouse.set(home.buildingId, (byHouse.get(home.buildingId) ?? 0) + 1);
        }
        return byHouse;
      },
      // Derives freeBeds through the SAME helper tryBirth uses, so the two
      // arrival paths cannot disagree about how many beds are spare.
      nomadGate: () => ({
        stock: stockpile.toJSON(),
        weights: MEAL_WEIGHTS,
        population: ctx.workers.length + pending.arrivals.length,
        freeBeds: spareBeds(ctx.shelters(), ctx.workers.length, pending),
        tick: clock.tick,
        lastRecruitTick: clock.lastRecruitTick,
        cooldown: BALANCE.recruitCooldownTicks,
        perHead: BALANCE.nomadFoodPerHead,
      }),
    };
    for (const command of queue.drain()) dispatchCommand(ctx, command);
    const dropped = queue.takeDropped();
    if (dropped > 0) notices.reject(`${dropped} command(s) were dropped: the queue was full.`);
  })
  .build();
