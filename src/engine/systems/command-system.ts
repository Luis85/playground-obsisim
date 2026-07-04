import { Actions, createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { Command } from '../../shared/commands';
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
  .withRunFunction(({ actions, queue, clock, stockpile, ids, notices, buildings, workers }) => {
    const handleConstructBuilding = (command: Extract<Command, { type: 'constructBuilding' }>) => {
      // Checked BEFORE pay(): refusing after payment would swallow the cost.
      if (ids.exhausted()) {
        notices.push('Cannot create more entities: id space exhausted.');
        return;
      }
      const def = BUILDINGS[command.buildingDefId];
      if (!stockpile.pay(def.cost)) {
        notices.push(`Cannot afford ${def.name}.`);
        return;
      }
      actions.commands
        .buildEntity()
        .with(new Building(ids.take(), def.id))
        .with(new WorkerSlots(def.workerSlots))
        .with(new Production())
        .build();
    };

    const handleRecruitWorker = () => {
      // Checked BEFORE the cooldown write: a refused recruit must not start it.
      if (ids.exhausted()) {
        notices.push('Cannot create more entities: id space exhausted.');
        return;
      }
      if (clock.tick < clock.lastRecruitTick + BALANCE.recruitCooldownTicks) {
        notices.push('Recruiting is still on cooldown.');
        return;
      }
      clock.lastRecruitTick = clock.tick;
      actions.commands
        .buildEntity()
        .with(new Worker(ids.take()))
        .with(new Hunger())
        .with(new JobAssignment())
        .with(new Efficiency())
        .with(new ToolCoverage())
        .build();
    };

    const findMaxSlots = (buildingId: number): number | null => {
      for (const { building, slots } of buildings.iter()) {
        if (building.id === buildingId) return slots.max;
      }
      return null;
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
      const maxSlots = findMaxSlots(command.buildingId);
      if (maxSlots === null) {
        notices.push('Building not found.');
        return;
      }
      const { assigned, idle } = findAssignmentCandidates(command.buildingId);
      if (assigned >= maxSlots) {
        notices.push('No free worker slots at this building.');
        return;
      }
      if (idle === null) {
        notices.push('No idle workers available.');
        return;
      }
      idle.buildingId = command.buildingId;
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
      if (!found) notices.push('No worker assigned to this building.');
    };

    for (const command of queue.drain()) {
      switch (command.type) {
        case 'constructBuilding': handleConstructBuilding(command); break;
        case 'recruitWorker': handleRecruitWorker(); break;
        case 'assignWorker': handleAssignWorker(command); break;
        case 'unassignWorker': handleUnassignWorker(command); break;
      }
    }
  })
  .build();
