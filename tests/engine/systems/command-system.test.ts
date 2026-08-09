import { describe, expect, it } from 'vitest';
import type { IRuntimeWorld } from 'sim-ecs';
import {
  CommandQueue, IdCounter, MAX_PENDING_COMMANDS, NoticeBoard, PendingChanges, RemovalLedger, SimClock, SnapshotStore, Stockpile,
  WorldMap,
} from '../../../src/engine/resources';
import { BALANCE } from '../../../src/engine/content/balance';
import { Building, HaulTrip, Home, JobAssignment, OutputBuffer, Position, Relocation, WorkerSlots, Colonist } from '../../../src/engine/components';
import { CommandSystem } from '../../../src/engine/systems/command-system';
import { handleMoveBuilding } from '../../../src/engine/systems/command-handlers';
import type { BuildingRow, CommandContext, WorkerRow } from '../../../src/engine/systems/command-handlers';
import { BUILDINGS } from '../../../src/engine/content/buildings';
import { HaulSystem, haulerCapacity } from '../../../src/engine/systems/haul-system';
import { HungerSystem } from '../../../src/engine/systems/hunger-system';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { enqueue } from '../fixtures';
import { buildSaveFromWorld } from '../../../src/engine/game-engine';
import {
  applyRemovals, buildColonyPrepWorld, COMPONENT_TYPES, getPrepResource, initialSave, spawnBuilding, spawnColonist,
} from '../../../src/engine/world';
import type { Command } from '../../../src/shared/commands';
import type { SaveGameV5 } from '../../../src/shared/save';
import { DEFAULT_MAP, type TileRef } from '../../../src/shared/placement';

/**
 * What a hauler in this file's fixtures carries per trip.
 *
 * NOT BALANCE.haulCarryCapacity, which is what a hauler with a neutral commute
 * carries. `setup()` defaults to `houselessSave()` below — no shelter anywhere
 * and no planks to build one — so its haulers are homeless and Task 7's carry
 * scaling gives them `haulerCapacity(null)` instead. Named once and used by
 * every case below that seeds "exactly one load" AND every case that asserts a
 * full delivery: if the seed and the assertion ever read different numbers, the
 * fixture silently becomes a two-trip run and the case stops testing what its
 * name says.
 *
 * Housing them is not the fix here the way it is in haul-system.test.ts: this
 * file asserts on `snapshot().buildings[0]` and on building COUNTS throughout,
 * so an extra house entity would break a dozen unrelated cases — which is
 * exactly why the default is `houselessSave()` and not the `initialSave()` it
 * used to be, now that save v5 ships a starter house in every fresh colony.
 */
const ONE_LOAD = haulerCapacity(null);

/**
 * `initialSave()` with the starter house taken away and the founders back on
 * the street — the colony this whole file was written against.
 *
 * Almost every case here counts `snapshot().buildings` or reads
 * `buildings[0]`, and ONE_LOAD above is the capacity of an UNHOUSED hauler.
 * Save v5 gives a fresh colony a house and puts all three founders in it, so
 * inheriting that here would shift a dozen assertions that have nothing to do
 * with housing. Stating the houseless colony explicitly keeps them honest —
 * the same move `houseHaulers: false` makes in haul-system.test.ts.
 */
function houselessSave(): SaveGameV5 {
  const base = initialSave();
  return { ...base, buildings: [], colonists: base.colonists.map((c) => ({ ...c, homeId: null })) };
}

/**
 * A tick as this file needs it: the clock nudged (the recruit cooldown reads
 * `SimClock.tick`, so without it the cooldown can never elapse), the world
 * stepped, and the tick's removals APPLIED.
 *
 * `applyRemovals` is not optional decoration. Since OBS-6-02 a demolition no
 * longer goes through sim-ecs's deferred command queue — `handleDemolishBuilding`
 * puts the entity on `RemovalLedger` and the post-step drain is the only thing
 * that takes it off — so a step without this leaves every demolished building
 * standing for the rest of the run.
 *
 * Deliberately NOT `stepTick`, which is the full production sequence: it also
 * refreshes the snapshot's entity-derived sections, and a dozen cases in this
 * file assert on the DEFERRAL that gate exists to close ("entity appears next
 * tick", the notices a freed tile does or does not produce). This harness runs
 * a partial system set and publishes what SnapshotSystem itself wrote; the
 * removal drain is the one post-step step it cannot do without.
 */
function ticker(world: IRuntimeWorld) {
  return async () => {
    world.getResource(SimClock).tick++;
    await world.step();
    applyRemovals(world);
  };
}

async function setup(save: SaveGameV5 = houselessSave()) {
  const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem, SnapshotSystem] });
  const world = await prep.prepareRun();
  const tick = ticker(world);
  const dispatch = async (...commands: Command[]) => {
    enqueue(world, ...commands);
    await tick();
  };
  const snapshot = (w: IRuntimeWorld = world) => w.getResource(SnapshotStore).latest!;
  return { world, tick, dispatch, snapshot };
}

/**
 * A colony that can actually take a nomad in: two houses (8 beds against 3
 * founders) and food well past `nomadFoodPerHead`. Recruiting is gated on beds
 * and food since Task 8, so a fixture that supplies neither can only ever test
 * the rejection. Two houses, not one: a one-house colony has 4 - 3 = 1 spare
 * bed, so the SECOND recruit below would be refused for want of a bed and the
 * cooldown assertion would pass for the wrong reason.
 */
function saveThatCanHouseArrivals(): SaveGameV5 {
  const base = houselessSave();
  return {
    ...base,
    buildings: [
      { id: 90, defId: 'house', col: 5, row: 3, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
      { id: 91, defId: 'house', col: 7, row: 3, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
    ],
    stockpile: { ...base.stockpile, bread: 5000 },
    nextEntityId: 100,
  };
}

// Relocation downtime is enforced by ProductionSystem, which the shared setup()
// deliberately omits. Order matches ALL_SYSTEMS (buildColonyPrepWorld throws
// otherwise).
async function setupWithProduction(save: SaveGameV5 = houselessSave()) {
  const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, ProductionSystem, HaulSystem, SnapshotSystem] });
  const world = await prep.prepareRun();
  const tick = ticker(world);
  const dispatch = async (...commands: Command[]) => {
    enqueue(world, ...commands);
    await tick();
  };
  const snapshot = () => world.getResource(SnapshotStore).latest!;
  return { world, tick, dispatch, snapshot };
}

describe('CommandSystem', () => {
  it('constructs a building, paying its cost; entity appears next tick', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(world.getResource(Stockpile).get('wood')).toBe(20); // 30 - 10
    expect(snapshot().buildings).toHaveLength(0); // command applied at end of step
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Built a Forester.' }]);
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
    expect(snapshot().buildings[0].defId).toBe('forester');
  });

  it('rejects unaffordable construction with a notice', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'workshop' }); // needs 20 planks
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot afford Workshop.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30);
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
  });

  it('welcomes a nomad and enforces the 30-tick cooldown', async () => {
    // Beds and food are both held far from their thresholds by the fixture, so
    // the cooldown is the only gate in play — the same reason the balance
    // harness seeds a berry stock to hold hunger neutral.
    const { tick, dispatch, snapshot } = await setup(saveThatCanHouseArrivals());
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Colonist #100 joined the colony.' }]);
    await tick();
    expect(snapshot().population).toBe(4);
    await dispatch({ type: 'recruitWorker' }); // still on cooldown
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No one is passing through just yet.' }]);
    for (let i = 0; i < 30; i++) await tick();
    await dispatch({ type: 'recruitWorker' });
    await tick();
    expect(snapshot().population).toBe(5);
  });

  it('refuses a nomad when there is nowhere to sleep, and says so', async () => {
    // The discriminating half of the pair above: same command, same cooldown
    // state, only the beds removed. That is what `setup()`'s default
    // `houselessSave()` is for — a fresh v5 colony ships a starter house with
    // a bed to spare, so `initialSave()` would ACCEPT the nomad and this test
    // would assert the opposite of its own name.
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No free bed: build a house first.' }]);
    expect(snapshot().population).toBe(3);
  });

  it('refuses a nomad when the store cannot feed one', async () => {
    // Beds available, food gone: the OTHER gate, named distinctly so a single
    // catch-all rejection cannot satisfy both tests.
    const { dispatch, snapshot } = await setup({ ...saveThatCanHouseArrivals(), stockpile: {} });
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Not enough food stored to feed another colonist.' }]);
    expect(snapshot().population).toBe(3);
  });

  it('re-seats a nomad in the other house when the one it landed in moves in the same drain', async () => {
    // The relocation twin of the demolition case. recruitWorker seats the
    // nomad in house 90 (lowest id with room), then moveBuilding starts 90
    // relocating LATER IN THE SAME DRAIN. Nulling the homeId is necessary —
    // a homeId naming a relocating house is the dangling reference the v5 load
    // guard refuses — but it is not sufficient: rehome cannot repair it,
    // because a colonist spawned earlier in this drain is invisible to every
    // query until the post-step sync, so PopulationSystem has no row for them
    // this tick. Without the re-seat the nomad ends the tick homeless while
    // house 91 stands with four empty beds, and a paused player sees that
    // contradiction until they step again.
    const { world, dispatch, snapshot } = await setup(saveThatCanHouseArrivals());
    await dispatch(
      { type: 'recruitWorker' },
      { type: 'moveBuilding', buildingId: 90, to: { col: 12, row: 9 } },
    );
    // Both commands genuinely applied: a drain that rejected the recruit would
    // otherwise leave nothing to find below and fail for the wrong reason.
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Colonist #100 joined the colony.' },
      { kind: 'success', message: 'Moved the House.' },
    ]);
    const nomad = [...world.getEntities()].find((e) => e.getComponent(Colonist)?.id === 100);
    expect(nomad, 'the recruited nomad never reached the world').toBeDefined();
    // 91 specifically, not merely "not null": the whole point is that the free
    // bed it takes belongs to a house that is standing still.
    expect(nomad!.getComponent(Home)!.buildingId).toBe(91);
  });

  it('re-seats a nomad in the other house when the one it landed in is demolished in the same drain', async () => {
    // The demolition half of the pair above, and the site `reseatArrivalsOf`
    // was written for but never wired to: `handleDemolishBuilding` used to only
    // NULL the arrival's home. Nulling stops the dangling reference the v5 load
    // guard refuses, but it leaves the nomad homeless for the rest of the tick
    // with house 91 standing on four empty beds — and rehome cannot repair it,
    // because a colonist spawned earlier in this drain has no query row until
    // the post-step sync. Paused, that contradiction persists indefinitely.
    const { world, dispatch, snapshot } = await setup(saveThatCanHouseArrivals());
    await dispatch(
      { type: 'recruitWorker' },
      { type: 'demolishBuilding', buildingId: 90 },
    );
    // Both commands genuinely applied — same guard as the relocation twin.
    // The displaced count is 3, not 4: the load repair houses the three
    // founders in house 90, and the nomad the re-seat exists for is invisible
    // to `ctx.workers` — which is the whole reason `displaced` cannot see them
    // and `reseatArrivalsOf` has to.
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Colonist #100 joined the colony.' },
      { kind: 'success', message: 'Demolished the House — cost refunded. — 3 colonist(s) displaced.' },
    ]);
    const nomad = [...world.getEntities()].find((e) => e.getComponent(Colonist)?.id === 100);
    expect(nomad, 'the recruited nomad never reached the world').toBeDefined();
    // 91, never 90: the re-seat runs after the demolition is on the pending
    // ledger, so `shelterWithRoom` cannot hand back the house being removed.
    expect(nomad!.getComponent(Home)!.buildingId).toBe(91);
  });

  /**
   * OBS-6-07 path 1. `reseatArrivalsOf` loops, and its doc comment claims the
   * loop is safe for SEVERAL displaced arrivals at once because
   * `shelterWithRoom` reads `ctx.pending.arrivals` live — so each arrival it
   * re-seats is already counted against its new house by the time the next one
   * asks. The two scenario tests above only ever put ONE arrival through it.
   *
   * The branch cannot be reached through the command path at all:
   * `recruitCooldownTicks` refuses a second nomad in the same drain (the
   * handler writes `lastRecruitTick` before the next command is read), and
   * `tryBirth` — the only other pusher — runs in `PopulationSystem`, after
   * `CommandSystem` has finished draining. So the handler is driven directly,
   * with a context built from real components. That is the honest shape of the
   * claim: this is live code with no live caller, kept because a bulk-arrival
   * command or a retuned cooldown would make it one overnight.
   */
  describe('handleMoveBuilding with more than one arrival to re-seat', () => {
    /** Real entities, so the rows carry the components production reads. */
    async function houseRows(tiles: readonly TileRef[]) {
      const prep = buildColonyPrepWorld({ save: houselessSave(), systems: [] });
      const ids = getPrepResource(prep, IdCounter);
      return tiles.map((at, index) => {
        const entity = spawnBuilding(prep, ids, {
          id: 90 + index, defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0,
        });
        return {
          entity,
          building: entity.getComponent(Building)!,
          slots: entity.getComponent(WorkerSlots)!,
          position: entity.getComponent(Position)!,
          buffer: entity.getComponent(OutputBuffer)!,
          relocation: entity.getComponent(Relocation)!,
        };
      });
    }

    /** One resident of `homeId`, as `ctx.workers` sees them. */
    function resident(homeId: number): WorkerRow {
      return { job: new JobAssignment(), trip: new HaulTrip(), home: new Home(homeId), stage: 'adult' };
    }

    /**
     * What `CommandSystem` builds, minus what this handler cannot reach.
     * `shelters` and `occupancy` are derived from the same rows and in the same
     * shape it uses; `pending.constructed` is left out of `shelters` because
     * nothing is constructed in this drain, so the fold would be a no-op.
     * `spawn` and `nomadGate` THROW rather than returning a stub, so a handler
     * that started using either would fail here rather than read a fiction.
     */
    function contextOf(buildings: BuildingRow[], workers: WorkerRow[], pending: PendingChanges): CommandContext {
      return {
        clock: new SimClock(),
        stockpile: new Stockpile({}),
        ids: new IdCounter(1000),
        notices: new NoticeBoard(),
        map: new WorldMap(DEFAULT_MAP.cols, DEFAULT_MAP.rows),
        buildings,
        workers,
        spawn: () => { throw new Error('handleMoveBuilding must not spawn'); },
        claimedTiles: [],
        removals: new RemovalLedger(),
        pending,
        demolishedIds: new Set<number>(),
        shelters: () => buildings
          .filter(({ building }) => BUILDINGS[building.defId].beds > 0)
          .map(({ building, position, relocation }) => ({
            id: building.id,
            beds: BUILDINGS[building.defId].beds,
            col: position.col,
            row: position.row,
            relocating: relocation.ticksLeft > 0,
          })),
        occupancy: () => {
          const byHouse = new Map<number, number>();
          for (const { home } of workers) {
            if (home.buildingId !== null) byHouse.set(home.buildingId, (byHouse.get(home.buildingId) ?? 0) + 1);
          }
          return byHouse;
        },
        nomadGate: () => { throw new Error('handleMoveBuilding must not ask the nomad gate'); },
      };
    }

    it('spreads them across the houses that have room, one bed each', async () => {
      // Houses 91 and 92 hold three residents each, so each has exactly ONE bed
      // free. That is the whole fixture: with the ledger read live, the first
      // arrival takes 91's last bed and the second is offered 92; with the
      // destination resolved once for the whole loop, both are handed 91 and it
      // ends the drain holding five colonists in four beds.
      const buildings = await houseRows([{ col: 5, row: 3 }, { col: 7, row: 3 }, { col: 9, row: 3 }]);
      const workers = [91, 91, 91, 92, 92, 92].map(resident);
      const pending = new PendingChanges();
      const first = new Home(90);
      const second = new Home(90);
      for (const home of [first, second]) pending.arrivals.push({ home, ageTicks: BALANCE.nomadArrivalTicks });

      handleMoveBuilding(contextOf(buildings, workers, pending), {
        type: 'moveBuilding', buildingId: 90, to: { col: 15, row: 11 },
      });

      // Precondition, not the point: house 90 really did lift off, so both
      // arrivals genuinely had to move.
      expect(buildings[0].relocation.ticksLeft).toBeGreaterThan(0);
      expect([first.buildingId, second.buildingId]).toEqual([91, 92]);
    });
  });

  it('assigns and unassigns workers within slot limits', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Assigned a worker to Forester.' }]);
    await dispatch({ type: 'assignWorker', buildingId });
    expect(snapshot().buildings[0].workers).toBe(2);
    await dispatch({ type: 'assignWorker', buildingId }); // forester has 2 slots
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No free worker slots at this building.' }]);
    await dispatch({ type: 'unassignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a worker from Forester.' }]);
    expect(snapshot().buildings[0].workers).toBe(1);
    expect(snapshot().idleAdults).toBe(2);
  });

  it('falls back to a generic name when the building an assignment points at is gone', async () => {
    // buildingName's 'building' fallback. Unreachable through the save path --
    // isLoadableSave rejects a worker whose buildingId names no building -- and
    // demolition kept it fixture-only: it nulls every assignment it evicts and
    // the same-tick demolishedIds guard rejects later commands against the id.
    // Pinned as defense in depth for any future remover that misses eviction.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // this fixture spawns exactly the world it needs
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, SnapshotSystem] });
    spawnColonist(prep, getPrepResource(prep, IdCounter), { buildingId: 404 }); // no building 404
    const world = await prep.prepareRun();
    enqueue(world, { type: 'unassignWorker', buildingId: 404 });
    world.getResource(SimClock).tick++;
    await world.step();

    const notices = world.getResource(SnapshotStore).latest!.notices;
    expect(notices).toEqual([{ kind: 'success', message: 'Unassigned a worker from building.' }]);
  });

  it('refuses entity creation once the id space is exhausted, without side effects', async () => {
    const save = houselessSave();
    save.nextEntityId = Number.MAX_SAFE_INTEGER - 2 ** 32; // == MAX_SAVED_COUNTER: nothing left to hand out
    const { world, tick, dispatch, snapshot } = await setup(save);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot create more entities: id space exhausted.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // cost not paid
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot create more entities: id space exhausted.' }]);
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
    expect(snapshot().population).toBe(3);
  });

  it('notices when assigning to a missing building or with no idle workers, or unassigning from an unstaffed one', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'assignWorker', buildingId: 999 });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);

    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;

    // a real building nobody has been assigned to yet
    await dispatch({ type: 'unassignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No worker assigned to this building.' }]);

    // a second forester so a slot stays open even once every worker is busy
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const secondBuildingId = snapshot().buildings.find((b) => b.id !== buildingId)!.id;

    // 3 starting workers, 2 slots per forester: fill building 1 (2 workers),
    // send the last idle worker to building 2 (1/2 slots) -- one open slot
    // remains there, but every worker is now busy.
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignWorker', buildingId: secondBuildingId });
    await dispatch({ type: 'assignWorker', buildingId: secondBuildingId });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
  });

  it('emits exactly one notice naming the drop count after a queue overflow', async () => {
    const { world, tick, snapshot } = await setup();
    const queue = world.getResource(CommandQueue);
    for (let i = 0; i < MAX_PENDING_COMMANDS + 5; i++) queue.push({ type: 'recruitWorker' });
    await tick();
    const dropNotices = snapshot().notices.filter((n) => n.message.includes('dropped'));
    expect(dropNotices).toEqual([{ kind: 'rejection', message: '5 command(s) were dropped: the queue was full.' }]);
  });

  it('constructs at a chosen buildable tile', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 7, row: 4 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Built a Forester.' }]);
    await tick();
    expect(snapshot().buildings[0]).toMatchObject({ defId: 'forester', col: 7, row: 4 });
  });

  it('auto-places table constructions on the legacy plot pattern', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut' });
    await tick();
    expect(snapshot().buildings.map((b) => [b.col, b.row])).toEqual([[4, 1], [6, 1]]);
  });

  it('rejects out-of-bounds, camp-band, and occupied tiles without paying', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 0, row: 1 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 24, row: 1 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // nothing paid
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(20); // only the forester paid
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
  });

  it('two same-tick constructions cannot claim one tile', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'forester', at: { col: 6, row: 2 } },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 6, row: 2 } },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'rejection']);
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
  });

  it('two same-tick auto-placed constructions land on distinct plots', async () => {
    // the claimedTiles bridge must feed autoPlacePosition too, not only the
    // explicit-at validator — otherwise both table builds pick one plot
    const { tick, dispatch, snapshot } = await setup();
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'forester' },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut' },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'success']);
    await tick();
    const tiles = snapshot().buildings.map((b) => `${b.col},${b.row}`);
    expect(new Set(tiles).size).toBe(2);
  });

  it('rejects construction once no buildable tile remains', async () => {
    const save = houselessSave(); // its own fill covers (4,1), where the starter house would stand
    let id = 10;
    for (let row = 0; row < 16; row++) {
      for (let col = 3; col < 24; col++) {
        save.buildings.push({ id: id++, defId: 'forester', progress: 0, batchActive: false, col, row, buffer: {}, relocatingTicks: 0 });
      }
    }
    save.nextEntityId = id;
    save.stockpile = { wood: 100 };
    const { dispatch, snapshot } = await setup(save);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No free tile left to build on.' }]);
  });

  it('demolishes: refunds the cost, idles the workers, removes the entity', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' }); // wood 30 -> 20
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'demolishBuilding', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Demolished the Forester — cost refunded.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // full refund
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
    expect(snapshot().idleAdults).toBe(3);
  });

  it('demolishing a building with buffered goods names the loss; the refund stays exactly the construction cost', async () => {
    // OBS-4-07, resolved: the buffer is destroyed either way (unchanged from
    // the test above) — only the notice's wording is new. The stockpile
    // assertion is the guard that this stayed a messaging fix: it must land on
    // the exact same 30 as the empty-building case above, proving the 9
    // buffered wood never reached the stockpile despite being named in the notice.
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' }); // wood 30 -> 20
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    await dispatch({ type: 'demolishBuilding', buildingId });
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Demolished the Forester — cost refunded, 9 Wood lost.' },
    ]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // construction refund only, same as the empty case
  });

  it('demolishing an empty building leaves the notice byte-identical to today\'s wording', async () => {
    // OBS-4-07: a zero-units clause would be noise on the common case, so an
    // empty buffer must not grow a trailing ", lost." clause of any kind.
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'demolishBuilding', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Demolished the Forester — cost refunded.' }]);
  });

  it('names exactly one displaced resident, singular wording', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // this fixture spawns exactly the world it needs
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, homeId: houseId });
    const world = await prep.prepareRun();
    enqueue(world, { type: 'demolishBuilding', buildingId: houseId });
    await ticker(world)();
    expect(world.getResource(SnapshotStore).latest!.notices).toEqual([
      { kind: 'success', message: 'Demolished the House — cost refunded. — 1 colonist(s) displaced.' },
    ]);
  });

  it('names the exact count of several displaced residents', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // this fixture spawns exactly the world it needs
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    for (const id of [1, 2, 3]) spawnColonist(prep, ids, { id, homeId: houseId });
    const world = await prep.prepareRun();
    enqueue(world, { type: 'demolishBuilding', buildingId: houseId });
    await ticker(world)();
    expect(world.getResource(SnapshotStore).latest!.notices).toEqual([
      { kind: 'success', message: 'Demolished the House — cost refunded. — 3 colonist(s) displaced.' },
    ]);
  });

  it('demolishing a house with no residents gains no displaced clause', async () => {
    // The empty case is how a clause like this grows noise: pinned directly
    // against a house (the one building type residents ever point home at),
    // not just the Forester the byte-identical test above already covers.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // this fixture spawns exactly the world it needs
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    const world = await prep.prepareRun();
    enqueue(world, { type: 'demolishBuilding', buildingId: houseId });
    await ticker(world)();
    expect(world.getResource(SnapshotStore).latest!.notices).toEqual([
      { kind: 'success', message: 'Demolished the House — cost refunded.' },
    ]);
  });

  it('rejects demolishing a building that does not exist', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'demolishBuilding', buildingId: 999 });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);
  });

  it('a demolished id is dead within its own tick: later commands against it reject', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'demolishBuilding', buildingId },
      { type: 'assignWorker', buildingId },
      { type: 'unassignWorker', buildingId },
      { type: 'demolishBuilding', buildingId },
    );
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Demolished the Forester — cost refunded.' },
      { kind: 'rejection', message: 'Building not found.' },
      { kind: 'rejection', message: 'Building not found.' },
      { kind: 'rejection', message: 'Building not found.' },
    ]);
  });

  it('a tile freed by demolition is buildable again on the NEXT tick', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'demolishBuilding', buildingId },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } },
    );
    expect(snapshot().notices[1]).toEqual({ kind: 'rejection', message: 'Cannot build there.' });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: "Built a Gatherer's Hut." }]);
  });

  it('moves a building in place — same id, workers and batch intact, visible same tick', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 9, row: 6 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Moved the Forester.' }]);
    // Position is a component mutation, not a deferred entity command — the
    // same tick's snapshot already shows it.
    expect(snapshot().buildings[0]).toMatchObject({ id: buildingId, col: 9, row: 6, workers: 1 });
  });

  it('rejects moving to an occupied tile, its own tile, off-map, or a missing building', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 6, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 6, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 1, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId: 999, to: { col: 9, row: 9 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);
    expect(snapshot().buildings[0]).toMatchObject({ col: 5, row: 5 }); // never moved
  });

  it('same-tick: a construction claims its tile before a later move can take it', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 7, row: 7 } },
      { type: 'moveBuilding', buildingId, to: { col: 7, row: 7 } },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'rejection']);
  });

  it('assigns and unassigns haulers, with one notice each', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'assignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Assigned a hauler.' }]);
    expect(snapshot().colonists.filter((w) => w.hauling)).toHaveLength(1);
    expect(snapshot().idleAdults).toBe(2); // 3 starting workers, one now hauling

    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
    expect(snapshot().colonists.filter((w) => w.hauling)).toHaveLength(0);
    expect(snapshot().idleAdults).toBe(3);
  });

  it('rejects hauler assignment with no idle worker, and unassignment with no hauler', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No hauler to unassign.' }]);

    await dispatch({ type: 'assignHauler' }, { type: 'assignHauler' }, { type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
  });

  it('haulers are workers in every other respect — they still eat', async () => {
    // Built directly against HungerSystem: the shared `setup` runs only the
    // command and snapshot systems, so it could never show a hauler eating.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // this fixture spawns exactly the world it needs
    save.stockpile = { berries: 5 };
    const prep = buildColonyPrepWorld({ save, systems: [HungerSystem] });
    spawnColonist(prep, getPrepResource(prep, IdCounter), { hauling: true });
    const world = await prep.prepareRun();
    for (let i = 0; i <= BALANCE.mealThreshold; i++) await world.step();
    expect(world.getResource(Stockpile).get('berries')).toBeLessThan(5);
  });

  it('never takes a building worker for hauling', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId }, { type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignHauler' }); // one idle worker left
    await dispatch({ type: 'assignHauler' }); // none left
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
    expect(snapshot().buildings[0].workers).toBe(2); // the staffed pair was never poached
  });

  it('assigning a building worker never poaches a hauler', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    // Turn every starting worker into a hauler (3 workers total)
    await dispatch({ type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });
    // Verify all are hauling and none are idle
    expect(snapshot().colonists.filter((w) => w.hauling)).toHaveLength(3);
    expect(snapshot().idleAdults).toBe(0);
    // Try to assign a worker to the building — should reject, not poach a hauler
    await dispatch({ type: 'assignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
    // Verify every hauler is still hauling with no buildingId
    expect(snapshot().colonists.every((w) => w.hauling && w.buildingId === null)).toBe(true);
    expect(snapshot().buildings[0].workers).toBe(0);
  });

  it('a hauler unassigned mid-trip drops its load in the store, never into nothing', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    await dispatch({ type: 'assignHauler' });
    await tick(); await tick(); await tick(); await tick(); // out and loaded
    const carrier = [...world.getEntities()].find((e) => (e.getComponent(HaulTrip)?.amount ?? 0) > 0)!;
    const before = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'unassignHauler' });
    expect(world.getResource(Stockpile).get('wood')).toBe(before + ONE_LOAD);
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
    // The trip must be reset, not merely handed off: buildSaveFromWorld banks a
    // carried load into the save filtered on `carrying`, NOT on `hauling`, so a
    // load left in hand here would be banked a second time on the next save —
    // the same units twice. legTicks and the pickup tile were genuinely
    // non-zero the moment before this (the carrier was mid-return-leg from
    // (5,4)) — reset() must clear them along with everything else, the same
    // way it clears phase/targetId/resource/amount.
    expect(carrier.getComponent(HaulTrip)!).toMatchObject({
      phase: 'idle', targetId: null, resource: null, amount: 0, legTicks: 0, pickupCol: 0, pickupRow: 0,
    });
    expect(buildSaveFromWorld(world).stockpile.wood).toBe(before + ONE_LOAD);
  });

  // OBS-4-08: the old rule took the first hauler in entity-iteration order, so
  // pressing `−` could interrupt a loaded worker most of the way home while an
  // idle one stood at the camp. No goods were lost — the load is banked — but
  // the walk already done was thrown away for nothing.
  it('unassigning releases an idle hauler rather than one carrying a load home', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    // The far corner: 13 ticks each way, so the return leg is long enough that
    // the two dispatches below cannot finish it out from under the assertion.
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 23, row: 15 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      // Exactly one load: the first hauler empties the buffer, so the second has
      // nothing to fetch and stays idle at the camp instead of going outbound.
      if (entity.getComponent(Building)?.id === buildingId) {
        entity.getComponent(OutputBuffer)!.add('wood', ONE_LOAD);
      }
    }
    await dispatch({ type: 'assignHauler' });
    const loaded = () => [...world.getEntities()].find((e) => (e.getComponent(HaulTrip)?.amount ?? 0) > 0);
    for (let i = 0; i < 20 && loaded() === undefined; i++) await tick();
    const carrier = loaded()!;
    expect(carrier.getComponent(HaulTrip)!.phase).toBe('returning'); // precondition, not the assertion
    await dispatch({ type: 'assignHauler' });

    const carriedBefore = carrier.getComponent(HaulTrip)!.amount;
    const stockBefore = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
    // The idle one went. The loaded trip is untouched: still returning, still
    // holding its load, and nothing banked early.
    expect(carrier.getComponent(HaulTrip)!).toMatchObject({ phase: 'returning', amount: carriedBefore });
    expect(world.getResource(Stockpile).get('wood')).toBe(stockBefore);
    expect(snapshot().colonists.filter((w) => w.hauling)).toHaveLength(1);
  });

  it('a move retargets the haulers already walking to that building', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    // The far corner of the default map: BALANCE.haulTilesPerTick's own comment
    // pins it at 13 ticks each way -- genuinely distant, not a token trip.
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 23, row: 15 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    const before = world.getResource(Stockpile).get('wood'); // 30 starting - 10 forester cost
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    // CommandSystem runs before HaulSystem (the real ALL_SYSTEMS order), so the
    // very tick that flags the worker as hauling also dispatches it -- no extra
    // tick is needed to see it start walking.
    await dispatch({ type: 'assignHauler' });
    const hauler = [...world.getEntities()].find((e) => e.getComponent(HaulTrip)?.phase === 'outbound')!;
    const trip = () => hauler.getComponent(HaulTrip)!;
    expect(trip()).toMatchObject({ targetId: buildingId, ticksLeft: 13, legTicks: 13 }); // the far-corner distance

    await tick(); await tick(); // well into the walk, nowhere near arrival
    expect(trip()).toMatchObject({ phase: 'outbound', ticksLeft: 11, legTicks: 13 }); // legTicks never decrements

    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 5, row: 1 } }); // just past camp: 2 ticks away
    // Recomputed against the new tile (2), then HaulSystem's same-tick decrement
    // (CommandSystem runs first) takes it to 1 -- not the stale 11 the old,
    // far-away tile would have left behind. Exact value, still true under the
    // real order because 2 ticks leaves room for CommandSystem's write to be
    // decremented once without hitting zero in this same tick. legTicks is
    // refreshed to the SAME new total (2) but, unlike ticksLeft, is never
    // touched by that same-tick decrement — it is OBS-5-01's frozen figure.
    expect(trip()).toMatchObject({ phase: 'outbound', ticksLeft: 1, legTicks: 2 });

    // Behavioral proof, not another frame of the counter: within a handful of
    // ticks (not the dozen the original far-corner distance demanded) the
    // hauler must actually arrive, load, walk home and deposit.
    await tick(); await tick(); await tick();
    expect(trip().phase).toBe('idle'); // arrived, loaded, walked home, delivered
    expect(world.getResource(Stockpile).get('wood')).toBe(before + ONE_LOAD); // the goods actually reached the stockpile
  });

  it('a move does not disturb a hauler already on its return leg', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } }); // 5 tiles out -> 3 ticks each way
    await tick();
    const buildingId = snapshot().buildings[0].id;
    const before = world.getResource(Stockpile).get('wood'); // 30 starting - 10 forester cost
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', ONE_LOAD);
    }
    await dispatch({ type: 'assignHauler' }); // dispatched this same tick: outbound, ticksLeft 3
    const hauler = [...world.getEntities()].find((e) => e.getComponent(HaulTrip)?.phase === 'outbound')!;
    const trip = () => hauler.getComponent(HaulTrip)!;
    await tick(); await tick(); await tick(); // walks the 3 ticks out and loads
    expect(trip()).toMatchObject({
      phase: 'returning', ticksLeft: 3, legTicks: 3, pickupCol: 5, pickupRow: 4,
      resource: 'wood', amount: ONE_LOAD,
    });

    // The building it loaded from moves elsewhere. A returning hauler walks to
    // the camp, which never moves, so this must leave the trip alone.
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 9, row: 6 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Moved the Forester.' }]);
    // Only HaulSystem's ordinary per-tick decrement (3 -> 2), nothing extra
    // from the move: ticksLeft and the load it is carrying are untouched — and
    // neither are legTicks or the pickup tile. OBS-5-01: a returning trip's
    // origin does not follow the building; pickupCol/pickupRow must still read
    // the OLD (5,4), never the new (9,6) the building moved to.
    expect(trip()).toMatchObject({
      phase: 'returning', ticksLeft: 2, legTicks: 3, pickupCol: 5, pickupRow: 4,
      resource: 'wood', amount: ONE_LOAD,
    });

    await tick(); await tick(); // the same 2 ticks it would have taken without the move
    expect(trip().phase).toBe('idle');
    expect(world.getResource(Stockpile).get('wood')).toBe(before + ONE_LOAD); // still delivers in full
  });

  // The buildings-side companion to the worker parity test below. OBS-4-02
  // recorded its absence as an open gap: OutputBuffer was added to the restore
  // path only, so buildings constructed during play had no buffer at all, and
  // nothing in the suite would have noticed.
  it('a constructed building carries the same components as a restored one', async () => {
    const save: SaveGameV5 = {
      ...initialSave(),
      // Beside the starter house, not instead of it: the founders' homeId
      // points at it, and the load guard refuses a home that names nothing.
      buildings: [
        ...initialSave().buildings,
        { id: 10, defId: 'forester', col: 6, row: 3, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
      ],
      nextEntityId: 11, // strictly past every id above, or the load guard refuses the save
    };
    const { world, tick, dispatch } = await setup(save);
    const restored = [...world.getEntities()].find((e) => e.getComponent(Building)?.id === 10)!;
    const expected = COMPONENT_TYPES.filter((type) => restored.getComponent(type) !== undefined);
    expect(expected.length).toBeGreaterThan(0); // guards against an empty comparison passing vacuously

    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    // id > 10 identifies the live-constructed one: the restored building holds
    // exactly 10, and ids only ever increase.
    const constructed = [...world.getEntities()]
      .filter((e) => e.getComponent(Building) !== undefined)
      .find((e) => e.getComponent(Building)!.id > 10)!;
    expect(constructed, 'no building was constructed').toBeDefined();
    for (const type of expected) {
      expect(constructed.getComponent(type), `constructed building is missing ${type.name}`).toBeDefined();
    }
  });

  it('a recruited worker carries the same components as a restored one', async () => {
    const { world, tick, dispatch } = await setup(saveThatCanHouseArrivals());
    // The highest existing id, not just "the first worker found": entity
    // iteration order is not id-ordered, and comparing against an arbitrary
    // starting worker would let the id > before.id check below match another
    // pre-existing (and therefore trivially complete) worker instead of the
    // actual recruit, silently defeating the whole test.
    const workers = [...world.getEntities()].filter((e) => e.getComponent(Colonist) !== undefined);
    const before = workers.reduce((max, e) => (e.getComponent(Colonist)!.id > max.getComponent(Colonist)!.id ? e : max));
    const expected = COMPONENT_TYPES.filter((type) => before.getComponent(type) !== undefined);
    await dispatch({ type: 'recruitWorker' });
    await tick();
    const recruited = [...world.getEntities()]
      .filter((e) => e.getComponent(Colonist) !== undefined)
      .find((e) => e.getComponent(Colonist)!.id > before.getComponent(Colonist)!.id)!;
    for (const type of expected) {
      expect(recruited.getComponent(type), `recruited worker is missing ${type.name}`).toBeDefined();
    }
  });

  it('a moved building stops producing for a distance-scaled downtime', async () => {
    const { tick, dispatch, snapshot } = await setupWithProduction();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignWorker', buildingId });
    for (let i = 0; i < 10; i++) await tick(); // it is genuinely producing
    const madeBefore = snapshot().buildings[0].buffered;
    expect(madeBefore).toBeGreaterThan(0);

    // (5,4) -> (15,4) is exactly 10 tiles; at 1 tile/tick that is 10 ticks.
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 15, row: 4 } });
    const paused = snapshot().buildings[0].buffered;
    for (let i = 0; i < 9; i++) await tick();
    expect(snapshot().buildings[0].buffered).toBe(paused); // nothing made while relocating

    for (let i = 0; i < 6; i++) await tick(); // downtime over, work resumes
    expect(snapshot().buildings[0].buffered).toBeGreaterThan(paused);
  });

  it('moving again replaces the remaining downtime rather than adding to it', async () => {
    const { world, tick, dispatch, snapshot } = await setupWithProduction();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 20, row: 14 } }); // long move
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 21, row: 14 } }); // 1 tile: 1 tick
    const relocation = [...world.getEntities()]
      .find((e) => e.getComponent(Building)?.id === buildingId)!
      .getComponent(Relocation)!;
    expect(relocation.ticksLeft).toBeLessThanOrEqual(1);
  });

  it('haulers still collect from a relocating building', async () => {
    // Acceptance criterion 3. Goods already in the buffer exist whether or not
    // the crew is working, so only production pauses — a relocating building
    // with a full buffer must still drain.
    const { world, tick, dispatch, snapshot } = await setupWithProduction();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      if (entity.getComponent(Building)?.id === buildingId) {
        entity.getComponent(OutputBuffer)!.add('wood', ONE_LOAD);
      }
    }
    await dispatch({ type: 'assignHauler' });
    // Move it far enough that the downtime outlasts the whole haul round trip.
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 20, row: 14 } });
    const relocating = [...world.getEntities()]
      .find((e) => e.getComponent(Building)?.id === buildingId)!
      .getComponent(Relocation)!;
    expect(relocating.ticksLeft).toBeGreaterThan(10); // genuinely out of action for the whole trip

    const before = world.getResource(Stockpile).get('wood');
    for (let i = 0; i < 40; i++) await tick();
    expect(world.getResource(Stockpile).get('wood')).toBe(before + ONE_LOAD);
    expect(snapshot().buildings[0].buffered).toBe(0); // the buffer genuinely drained
  });

  it('demolition still refunds 100% of construction cost', async () => {
    // A decision, not an accident: increment 5 considered cutting the refund as
    // a balance knob and rejected it, because free relocation dominated it —
    // a player could dodge any refund penalty by moving instead of rebuilding.
    // Now that moving costs downtime the two acts are cleanly separated: moving
    // costs time, removing is fully refunded.
    //
    // The NUMBER is already guarded by the two demolition tests above — both
    // fail if the refund is halved. What this test adds is the REASON it is
    // 100%, recorded at an assertion rather than only in a spec, so a future
    // balance pass reaching for this knob finds the argument against it here.
    const { world, tick, dispatch, snapshot } = await setup();
    const before = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(world.getResource(Stockpile).get('wood')).toBe(before - 10); // forester costs 10 wood
    await tick(); // the entity appears the tick after the command is handled
    await dispatch({ type: 'demolishBuilding', buildingId: snapshot().buildings[0].id });
    expect(world.getResource(Stockpile).get('wood')).toBe(before);
  });

  it('demolition refund does not count as a hauler delivery', async () => {
    // Stockpile.add unconditionally records into producedThisTick, which
    // StatsSystem publishes as deliveredRate. Routing the refund through
    // add() would inflate Delivered/t for a resource no hauler touched, and
    // could push it above Made/t — undermining the gap-is-haul-backlog
    // reading the Made/t + Delivered/t pairing (OBS-4-06) depends on.
    // refund() must bank the same amount without ever touching
    // producedThisTick. Both halves matter: the refund amount is existing
    // behaviour that must not regress, and the zeroed producedThisTick is
    // the fix.
    const { world, tick, dispatch, snapshot } = await setup();
    const before = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    await dispatch({ type: 'demolishBuilding', buildingId: snapshot().buildings[0].id });
    expect(world.getResource(Stockpile).get('wood')).toBe(before); // full refund, unchanged
    expect(world.getResource(Stockpile).producedThisTick.get('wood') ?? 0).toBe(0); // not a delivery
  });
});
