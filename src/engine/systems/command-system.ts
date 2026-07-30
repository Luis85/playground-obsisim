import { Actions, createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { Command } from '../../shared/commands';
import type { BuildingDefId } from '../../shared/content-types';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { Building, Efficiency, Hunger, JobAssignment, Production, ToolCoverage, Worker, WorkerSlots } from '../components';
import { CommandQueue, IdCounter, NoticeBoard, SimClock, Stockpile } from '../resources';

export const CommandSystem = () => createSystem({
  actions: Actions,
  queue: WriteResource(CommandQueue),
  clock: WriteResource(SimClock),
  stockpile: WriteResource(Stockpile),
  ids: WriteResource(IdCounter),
  notices: WriteResource(NoticeBoard),
  buildings: queryComponents({ building: Read(Building), slots: Read(WorkerSlots) }),
  workers: queryComponents({ worker: Read(Worker), job: Write(JobAssignment) }),
})
  .withName('CommandSystem')
  // One small handler per command type keeps each unit's complexity low; the
  // run function itself is just a drain loop + dispatch.
  //
  // Every handler now emits exactly one notice per command: notices.reject()
  // on every refused path (unchanged from before this task, just renamed
  // from the old bare push()), and notices.succeed() once, at the end of the
  // accepted path, after the state change it describes has already happened
  // — so a notice never claims something that didn't actually occur.
  .withRunFunction(({ actions, queue, clock, stockpile, ids, notices, buildings, workers }) => {
    const findBuilding = (buildingId: number): { maxSlots: number; defId: BuildingDefId } | null => {
      for (const { building, slots } of buildings.iter()) {
        if (building.id === buildingId) return { maxSlots: slots.max, defId: building.defId };
      }
      return null;
    };

    // Only unassign needs to go from a bare id to a name without already
    // holding a findBuilding() result (construct/assign already have the def
    // in hand from their own lookups).
    const buildingName = (buildingId: number): string => {
      const found = findBuilding(buildingId);
      return found ? BUILDINGS[found.defId].name : 'building';
    };

    const handleConstructBuilding = (command: Extract<Command, { type: 'constructBuilding' }>) => {
      // Checked BEFORE pay(): refusing after payment would swallow the cost.
      if (ids.exhausted()) {
        notices.reject('Cannot create more entities: id space exhausted.');
        return;
      }
      const def = BUILDINGS[command.buildingDefId];
      if (!stockpile.pay(def.cost)) {
        notices.reject(`Cannot afford ${def.name}.`);
        return;
      }
      actions.commands
        .buildEntity()
        .with(new Building(ids.take(), def.id))
        .with(new WorkerSlots(def.workerSlots))
        .with(new Production())
        .build();
      notices.succeed(`Built a ${def.name}.`);
    };

    const handleRecruitWorker = () => {
      // Checked BEFORE the cooldown write: a refused recruit must not start it.
      if (ids.exhausted()) {
        notices.reject('Cannot create more entities: id space exhausted.');
        return;
      }
      if (clock.tick < clock.lastRecruitTick + BALANCE.recruitCooldownTicks) {
        notices.reject('Recruiting is still on cooldown.');
        return;
      }
      clock.lastRecruitTick = clock.tick;
      const id = ids.take();
      actions.commands
        .buildEntity()
        .with(new Worker(id))
        .with(new Hunger())
        .with(new JobAssignment())
        .with(new Efficiency())
        .with(new ToolCoverage())
        .build();
      notices.succeed(`Recruited worker #${id}.`);
    };

    const findAssignmentCandidates = (buildingId: number): { assigned: number; idle: JobAssignment | null } => {
      let assigned = 0;
      let idle: JobAssignment | null = null;
      for (const { job } of workers.iter()) {
        if (job.buildingId === buildingId) assigned++;
        else if (job.buildingId === null && idle === null) idle = job;
      }
      return { assigned, idle };
    };

    const handleAssignWorker = (command: Extract<Command, { type: 'assignWorker' }>) => {
      const found = findBuilding(command.buildingId);
      if (found === null) {
        notices.reject('Building not found.');
        return;
      }
      const { assigned, idle } = findAssignmentCandidates(command.buildingId);
      if (assigned >= found.maxSlots) {
        notices.reject('No free worker slots at this building.');
        return;
      }
      if (idle === null) {
        notices.reject('No idle workers available.');
        return;
      }
      idle.buildingId = command.buildingId;
      notices.succeed(`Assigned a worker to ${BUILDINGS[found.defId].name}.`);
    };

    const handleUnassignWorker = (command: Extract<Command, { type: 'unassignWorker' }>) => {
      let found = false;
      for (const { job } of workers.iter()) {
        if (job.buildingId === command.buildingId) {
          job.buildingId = null;
          found = true;
          break;
        }
      }
      if (!found) {
        notices.reject('No worker assigned to this building.');
        return;
      }
      notices.succeed(`Unassigned a worker from ${buildingName(command.buildingId)}.`);
    };

    for (const command of queue.drain()) {
      switch (command.type) {
        case 'constructBuilding': handleConstructBuilding(command); break;
        case 'recruitWorker': handleRecruitWorker(); break;
        case 'assignWorker': handleAssignWorker(command); break;
        case 'unassignWorker': handleUnassignWorker(command); break;
      }
    }

    const dropped = queue.takeDropped();
    if (dropped > 0) notices.reject(`${dropped} command(s) were dropped: the queue was full.`);
  })
  .build();
