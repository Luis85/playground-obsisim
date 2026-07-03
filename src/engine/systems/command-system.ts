import { Actions, createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
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
  .withRunFunction(({ actions, queue, clock, stockpile, ids, notices, buildings, workers }) => {
    for (const command of queue.drain()) {
      switch (command.type) {
        case 'constructBuilding': {
          const def = BUILDINGS[command.buildingDefId];
          if (!stockpile.pay(def.cost)) {
            notices.push(`Cannot afford ${def.name}.`);
            break;
          }
          actions.commands
            .buildEntity()
            .with(new Building(ids.take(), def.id))
            .with(new WorkerSlots(def.workerSlots))
            .with(new Production())
            .build();
          break;
        }
        case 'recruitWorker': {
          if (clock.tick < clock.lastRecruitTick + BALANCE.recruitCooldownTicks) {
            notices.push('Recruiting is still on cooldown.');
            break;
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
          break;
        }
        case 'assignWorker': {
          let maxSlots: number | null = null;
          for (const { building, slots } of buildings.iter()) {
            if (building.id === command.buildingId) {
              maxSlots = slots.max;
              break;
            }
          }
          if (maxSlots === null) {
            notices.push('Building not found.');
            break;
          }
          let assigned = 0;
          let idle: JobAssignment | null = null;
          for (const { job } of workers.iter()) {
            if (job.buildingId === command.buildingId) assigned++;
            else if (job.buildingId === null && idle === null) idle = job;
          }
          if (assigned >= maxSlots) {
            notices.push('No free worker slots at this building.');
            break;
          }
          if (idle === null) {
            notices.push('No idle workers available.');
            break;
          }
          idle.buildingId = command.buildingId;
          break;
        }
        case 'unassignWorker': {
          let found = false;
          for (const { job } of workers.iter()) {
            if (job.buildingId === command.buildingId) {
              job.buildingId = null;
              found = true;
              break;
            }
          }
          if (!found) notices.push('No worker assigned to this building.');
          break;
        }
      }
    }
  })
  .build();
