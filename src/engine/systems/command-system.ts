import { Actions, createSystem, queryComponents, Read, ReadEntity, ReadResource, Write, WriteResource } from 'sim-ecs';
import type { Command } from '../../shared/commands';
import { Building, HaulTrip, JobAssignment, OutputBuffer, Position, Relocation, WorkerSlots } from '../components';
import { CommandQueue, IdCounter, NoticeBoard, RemovalLedger, SimClock, Stockpile, WorldMap } from '../resources';
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
  map: ReadResource(WorldMap),
  buildings: queryComponents({
    entity: ReadEntity(), building: Read(Building), slots: Read(WorkerSlots), position: Write(Position), buffer: Write(OutputBuffer),
    relocation: Write(Relocation),
  }),
  // JobAssignment alone identifies a worker entity — the Colonist component
  // added nothing the handlers read.
  workers: queryComponents({ job: Write(JobAssignment), trip: Write(HaulTrip) }),
})
  .withName('CommandSystem')
  // Handlers live in command-handlers.ts, one small function per command
  // type; this run function only materializes the query rows into a context
  // and drains the queue through dispatchCommand.
  .withRunFunction(({ actions, queue, clock, stockpile, ids, notices, removals, map, buildings, workers }) => {
    const ctx: CommandContext = {
      clock, stockpile, ids, notices, map,
      buildings: [...buildings.iter()].map(({ entity, building, slots, position, buffer, relocation }) => ({ entity, building, slots, position, buffer, relocation })),
      workers: [...workers.iter()].map(({ job, trip }) => ({ job, trip })),
      spawn: (...components) => {
        let entity = actions.commands.buildEntity();
        for (const component of components) entity = entity.with(component);
        entity.build();
      },
      claimedTiles: [],
      removals,
      remove: (entity) => actions.commands.removeEntity(entity),
      demolishedIds: new Set<number>(),
    };
    for (const command of queue.drain()) dispatchCommand(ctx, command);
    const dropped = queue.takeDropped();
    if (dropped > 0) notices.reject(`${dropped} command(s) were dropped: the queue was full.`);
  })
  .build();
