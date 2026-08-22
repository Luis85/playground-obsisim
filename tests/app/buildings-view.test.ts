// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import BuildingsView from '../../src/app/views/BuildingsView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { BALANCE } from '../../src/engine/content/balance';
import { makeBuilding, makeSnapshot } from './fixtures';
import type { BuildingSnapshot, Snapshot } from '../../src/shared/snapshot';

/**
 * Mounts BuildingsView against a full, caller-built Snapshot and ingests it
 * through the SAME pinia instance the component reads — the `store` in the
 * return value is that instance, not a second one, so a test can `ingest`
 * again later (Task 12's "seeds a target for a building that appears in a
 * later snapshot" needs exactly that).
 */
function mountView(snapshot: Snapshot) {
  const engine = { dispatch: vi.fn() };
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const store = useGameStore(pinia);
  // Seeded BEFORE mount, deliberately (mountScreen's own convention,
  // world-screen.test.ts): the first render then already has the snapshot,
  // so a test asserting synchronously — no `await $nextTick()` — still sees
  // real data rather than the pre-first-tick `v-if="store.snapshot"` gate.
  store.ingest(snapshot, { paused: true, speed: 1, error: null });
  const wrapper = mount(BuildingsView, {
    global: { plugins: [pinia], provide: { [ENGINE_KEY as symbol]: engine } },
  });
  return { engine, wrapper, store };
}

/** Building 7, a half-staffed Forester at (5, 2) — the fixture every
 * pre-Task-12 test in this file was built around, restated as a plain
 * `BuildingSnapshot` builder now that `mountView` takes a whole Snapshot
 * instead of assembling one from three loose arguments. */
function defaultBuilding(overrides: Partial<BuildingSnapshot> = {}): BuildingSnapshot {
  return makeBuilding(7, {
    defId: 'forester', workers: 1, workerSlots: 2, state: 'producing',
    progress: 1, batchActive: true, progressPct: 33, workPower: 1, col: 5, row: 2,
    ...overrides,
  });
}

/** The stock+state+building trio the old `mountView(stock, state, building)`
 * signature took, now assembled into the Snapshot the new one wants —
 * driving the construct button's tooltip (stock) and the humanized-label
 * assertions (state) the way it always did. */
function stockedSnapshot(
  stock: { wood?: number; planks?: number } = {},
  building: Partial<BuildingSnapshot> = {},
): Snapshot {
  const snapshot = makeSnapshot({ idleAdults: 2, buildings: [defaultBuilding(building)] });
  snapshot.stockpile.wood.stock = stock.wood ?? 0;
  snapshot.stockpile.planks.stock = stock.planks ?? 0;
  return snapshot;
}

describe('BuildingsView', () => {
  // One test covers three related UX changes (Step 2's labels and Step 4's
  // hint) against a single mounted view, reusing the `waiting` wrapper for
  // the empty-colony re-ingest rather than mounting a fourth time.
  it('renders humanized state labels and a starter hint once the colony has none', async () => {
    const producing = mountView(stockedSnapshot());
    await producing.wrapper.vm.$nextTick();
    expect(producing.wrapper.text()).toContain('Forester');
    expect(producing.wrapper.text()).toContain('Producing');
    expect(producing.wrapper.text()).not.toContain('producing'); // the raw state, not the label

    const waiting = mountView(stockedSnapshot({}, { state: 'waitingForInput' }));
    await waiting.wrapper.vm.$nextTick();
    expect(waiting.wrapper.text()).toContain('Waiting for input');
    expect(waiting.wrapper.text()).not.toContain('waitingForInput');

    waiting.store.ingest(makeSnapshot({ buildings: [] }), { paused: true, speed: 1, error: null });
    await waiting.wrapper.vm.$nextTick();
    const cell = waiting.wrapper.get('td[colspan="14"]');
    expect(cell.text()).toContain('Forester');
    expect(cell.text()).toMatch(/Gatherer.?s Hut/);
    expect(cell.text()).toContain('10 wood each');
    expect(cell.text()).toContain('then assign your idle workers with');

    const unstaffed = mountView(stockedSnapshot({}, { state: 'unstaffed' }));
    await unstaffed.wrapper.vm.$nextTick();
    expect(unstaffed.wrapper.text()).toContain('Unstaffed');
    expect(unstaffed.wrapper.text()).not.toContain('unstaffed');
  });

  // Assign/unassign dispatch a plain command object; the store's own success
  // notice on the accepted path is covered at the engine layer in
  // command-system.test.ts, not re-asserted against this stubbed engine here.
  it('dispatches assign/unassign for a building row', async () => {
    const { engine, wrapper } = mountView(stockedSnapshot());
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="assign-7"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'assignWorker', buildingId: 7 });
    await wrapper.find('[data-test="unassign-7"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'unassignWorker', buildingId: 7 });
  });

  it('construct button dispatches when affordable', async () => {
    const rich = mountView(stockedSnapshot({ wood: 100 }));
    await rich.wrapper.vm.$nextTick();
    await rich.wrapper.find('[data-test="construct-forester"]').trigger('click');
    expect(rich.engine.dispatch).toHaveBeenCalledWith({ type: 'constructBuilding', buildingDefId: 'forester' });
  });

  // Spec §2.1, increment 10: ordering is a request, not a claim, so the
  // table's construct button stops refusing an unaffordable order — this is
  // the third of three view gates (BuildPalette, WorldView's `tileValid`,
  // this one), each pinned separately because any ONE gate left standing
  // would still block the player from expressing a queue the model allows.
  it('the Buildings table button is enabled on an empty ledger', async () => {
    const poor = mountView(stockedSnapshot({ wood: 0 }));
    await poor.wrapper.vm.$nextTick();
    const button = poor.wrapper.find('[data-test="construct-forester"]');
    expect((button.element as HTMLButtonElement).disabled).toBe(false);
    await button.trigger('click');
    expect(poor.engine.dispatch).toHaveBeenCalledWith({ type: 'constructBuilding', buildingDefId: 'forester' });
  });

  // `affordableDefs` is not deleted (spec §2.1): it stops gating and starts
  // informing, so the one thing the player has left is this tooltip. A test
  // that only checked the button was enabled would pass just as well against
  // deleting the getter outright, which would lose the missing-resource
  // message entirely.
  it('the tooltip still says what is missing', async () => {
    const poor = mountView(stockedSnapshot({ wood: 0 }));
    await poor.wrapper.vm.$nextTick();
    const button = poor.wrapper.find('[data-test="construct-forester"]').element as HTMLButtonElement;
    expect(button.title).toBe('Short on resources — placed now, fills in as goods arrive; pick the tile yourself afterward, with Move or in World view');

    const rich = mountView(stockedSnapshot({ wood: 100 }));
    await rich.wrapper.vm.$nextTick();
    const richButton = rich.wrapper.find('[data-test="construct-forester"]').element as HTMLButtonElement;
    expect(richButton.title).toBe('Placed automatically — pick the tile yourself afterward, with Move or in World view');
  });

  // Task 4 added the storehouse def and left recipeLabel treating every
  // recipe-less def as housing, so the shed rendered "Shelters 0" at exactly
  // the moment a player is deciding what to build. BALANCE.storehouseCapacity
  // (60) is asserted directly rather than a literal, so a retune doesn't
  // desync this test from the def.
  it('names the storehouse\'s role as storage, not shelter', async () => {
    const { wrapper } = mountView(stockedSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain(`Stores ${BALANCE.storehouseCapacity}`);
    expect(wrapper.text()).not.toContain('Shelters 0');
  });

  // The fallback path must be able to build the building this increment
  // adds, or table/canvas parity is a claim rather than a property. Wood and
  // planks are both funded since the storehouse costs both.
  it('constructs a storehouse from the table', async () => {
    const { engine, wrapper } = mountView(stockedSnapshot({ wood: 100, planks: 100 }));
    await wrapper.vm.$nextTick();
    const button = wrapper.find('[data-test="construct-storehouse"]');
    expect(button.exists()).toBe(true);
    expect((button.element as HTMLButtonElement).disabled).toBe(false);
    await button.trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'constructBuilding', buildingDefId: 'storehouse' });
  });

  // Waiting (5), In (3), held (41) and capacity (60) are mutually distinct —
  // a column bound to the wrong field, or the storehouse row falling back to
  // the plain `buffered` cell, changes one of these assertions rather than
  // coinciding with the others.
  it('adds an In column beside Waiting, and a storehouse row shows held over capacity', async () => {
    const { wrapper } = mountView(makeSnapshot({
      buildings: [
        makeBuilding(7, { defId: 'mill', state: 'producing', buffered: 5, inputBuffered: 3 }),
        makeBuilding(8, { defId: 'storehouse', state: 'storing', stored: 41, storage: 60 }),
      ],
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="waiting-7"]').text()).toBe('5');
    expect(wrapper.find('[data-test="in-7"]').text()).toBe('3');
    expect(wrapper.find('[data-test="waiting-8"]').text()).toBe('41 / 60');
  });

  it('shows each building\'s tile and demolishes after the two-step confirm', async () => {
    const { engine, wrapper } = mountView(stockedSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('(5, 2)');
    const demolish = wrapper.find('[data-test="demolish-7"]');
    await demolish.trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalledWith({ type: 'demolishBuilding', buildingId: 7 });
    await demolish.trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'demolishBuilding', buildingId: 7 });
  });

  it('shows waiting units and names the output-full stall', async () => {
    const { wrapper } = mountView(stockedSnapshot({}, { state: 'outputFull', buffered: 12 }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="waiting-7"]').text()).toBe('12');
    expect(wrapper.text()).toContain('Output full');
  });

  it('shows remaining downtime for a relocating building', async () => {
    const { wrapper } = mountView(stockedSnapshot({}, { state: 'relocating', relocatingTicks: 6 }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="downtime-7"]').text()).toBe('6t');
  });

  it('shows an em dash when a building is not relocating', async () => {
    const { wrapper } = mountView(stockedSnapshot({}, { state: 'producing', relocatingTicks: 0 }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="downtime-7"]').text()).toBe('—');
  });

  // §2.10: a site's Workers column reads 0/0 (the assign-button capacity a
  // site does not have — `workerSlots` is zeroed by the projection, not by a
  // template-level state check) and the Needs column names what it still
  // owes. idleAdults: 3 rules out the OTHER disabled reason
  // (`idleAdults === 0`), so the button is disabled by the site branch alone.
  it('a producer site reports underConstruction, names its shortfall as have/need, and disables the assign button', async () => {
    const { wrapper } = mountView(makeSnapshot({
      buildings: [makeBuilding(7, {
        defId: 'mill', state: 'underConstruction', workers: 0, workerSlots: 0,
        constructionTicks: 20, constructionNeeds: { wood: 14, planks: 10 },
      })],
      idleAdults: 3,
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Under construction');
    // mill costs { wood: 20, planks: 10 }; 14/10 outstanding means 6/0 have
    // arrived — the Inspector's own `suppliedLabel`, not the bare shortfall
    // (spec §2.5: the have/need figure the Inspector shows survives into the
    // table).
    expect(wrapper.find('[data-test="needs-7"]').text()).toBe('6 / 20 Wood, 0 / 10 Planks');
    expect(wrapper.text()).toContain('0 / 0'); // Workers column: 0 staffed of 0 slots, the capacity a site does not have
    expect((wrapper.find('[data-test="assign-7"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an em dash in the Needs column for a finished building', async () => {
    const { wrapper } = mountView(stockedSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="needs-7"]').text()).toBe('—');
  });

  // A producer and a house in ONE render, because the two share a column: a
  // test that only ever saw one kind could not tell a branch from a constant.
  function mountMixed(house: Partial<BuildingSnapshot> = {}) {
    return mountView(makeSnapshot({
      buildings: [
        makeBuilding(7, { defId: 'forester', state: 'producing', progressPct: 33, beds: 0, occupants: 0 }),
        makeBuilding(8, {
          defId: 'house', state: 'housing', workerSlots: 0, progressPct: 0,
          beds: BALANCE.houseBeds, occupants: 3, ...house,
        }),
      ],
    })).wrapper;
  }

  // Batch progress is meaningless for a building with no recipe — it sits at
  // 0% forever — so the house spends that column on the only number it has:
  // who is actually sleeping there. The two rows below rule each other out: a
  // cell hardwired to progressPct would read "0%" for the house, and one
  // hardwired to occupancy would read "0 / 0" for the forester.
  it('a house reports its occupancy where a producer reports batch progress', async () => {
    const wrapper = mountMixed();
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="batch-7"]').text()).toBe('33%');
    expect(wrapper.get('[data-test="batch-8"]').text()).toBe(`3 / ${BALANCE.houseBeds}`);
  });

  it('the occupancy cell counts the snapshot\'s own residents, empty house included', async () => {
    const empty = mountMixed({ occupants: 0 });
    await empty.vm.$nextTick();
    expect(empty.get('[data-test="batch-8"]').text()).toBe(`0 / ${BALANCE.houseBeds}`);

    const full = mountMixed({ occupants: BALANCE.houseBeds, beds: BALANCE.houseBeds });
    await full.vm.$nextTick();
    expect(full.get('[data-test="batch-8"]').text()).toBe(`${BALANCE.houseBeds} / ${BALANCE.houseBeds}`);
  });

  it('renders a Ledger row without a pre-seeded target, defaulting to the current tile', () => {
    const { wrapper } = mountView(makeSnapshot({ buildings: [makeBuilding(1, { col: 7, row: 3 })] }));
    // Fails against an uninitialised record: the render throws before this.
    expect((wrapper.get('[data-test="move-col-1"]').element as HTMLInputElement).value).toBe('7');
    expect((wrapper.get('[data-test="move-row-1"]').element as HTMLInputElement).value).toBe('3');
  });

  it('seeds a target for a building that appears in a later snapshot', async () => {
    const { wrapper, store } = mountView(makeSnapshot({ tick: 1, buildings: [makeBuilding(1)] }));
    store.ingest(
      makeSnapshot({ tick: 2, buildings: [makeBuilding(1), makeBuilding(2, { col: 9, row: 5 })] }),
      { paused: true, speed: 1, error: null },
    );
    await wrapper.vm.$nextTick();
    expect((wrapper.get('[data-test="move-col-2"]').element as HTMLInputElement).value).toBe('9');
  });

  // Defect fix: a colony reset (GameEngine.reset()) recycles entity ids from
  // 1, same as WorldStage.vue already accounts for on the canvas side. A
  // player's half-typed Move coordinates for the OLD timeline's id-1
  // building must not survive onto the NEW timeline's id-1 building — if
  // they did and the stale tile happened to still be valid, the Ledger
  // would show an enabled Move aimed at the wrong destination with nothing
  // on screen to say so. Detected the same way WorldStage detects it: a
  // snapshot whose tick does not advance past the previous one's.
  it('clears typed move coordinates across a colony reset instead of keeping the stale tile', async () => {
    const { wrapper, store } = mountView(makeSnapshot({ tick: 5, buildings: [makeBuilding(1, { col: 4, row: 1 })] }));
    await wrapper.get('[data-test="move-col-1"]').setValue('9');
    await wrapper.get('[data-test="move-row-1"]').setValue('4');
    expect((wrapper.get('[data-test="move-col-1"]').element as HTMLInputElement).value).toBe('9');

    // The reset: tick regresses (a fresh colony starts back at tick 0), and
    // the new starter building reuses id 1 at a tile the player never typed.
    store.ingest(
      makeSnapshot({ tick: 0, buildings: [makeBuilding(1, { col: 10, row: 6 })] }),
      { paused: true, speed: 1, error: null },
    );
    await wrapper.vm.$nextTick();
    expect((wrapper.get('[data-test="move-col-1"]').element as HTMLInputElement).value).toBe('10');
    expect((wrapper.get('[data-test="move-row-1"]').element as HTMLInputElement).value).toBe('6');
  });

  it('moves a building to typed coordinates', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({ buildings: [makeBuilding(1)] }));
    await wrapper.get('[data-test="move-col-1"]').setValue('9');
    await wrapper.get('[data-test="move-row-1"]').setValue('4');
    await wrapper.get('[data-test="move-1"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'moveBuilding', buildingId: 1, to: { col: 9, row: 4 } });
  });

  it('refuses to staff a construction site, and says why', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({
      idleAdults: 3,
      buildings: [makeBuilding(1, { workers: 0, workerSlots: 3, state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 5 } })],
    }));
    expect(wrapper.get('[data-test="assign-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="assign-reason-1"]').text()).toContain('cannot be staffed');
    await wrapper.get('[data-test="assign-1"]').trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalled();
  });

  // The staffing gate's middle branch — Task 7's own review finding, restated
  // on this surface (spec §2.2's sweep): a site-only `v-if` would leave this
  // case silently disabled with no explanation, the same gap Task 7 found on
  // the Inspector.
  it('refuses to staff a full building, and says why', async () => {
    const { wrapper } = mountView(makeSnapshot({
      idleAdults: 3,
      buildings: [makeBuilding(1, { workers: 3, workerSlots: 3, state: 'producing' })],
    }));
    expect(wrapper.get('[data-test="assign-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="assign-reason-1"]').text()).toContain('Every slot is filled.');
  });

  it('explains a no-idle-adults refusal, not only a construction site', async () => {
    const { wrapper } = mountView(makeSnapshot({
      idleAdults: 0,
      buildings: [makeBuilding(1, { workers: 1, workerSlots: 3, state: 'producing' })],
    }));
    expect(wrapper.get('[data-test="assign-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="assign-reason-1"]').text()).toContain('No idle adults');
  });

  // The unassign direction's own refusal — verb 5 of the sweep table:
  // disabled at zero workers, with a reason, on both surfaces. Before this
  // task the table's `-` carried a bare `:disabled` and nothing else.
  it('refuses to unassign when nothing is staffed, and says why', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({
      buildings: [makeBuilding(1, { workers: 0, workerSlots: 3 })],
    }));
    expect(wrapper.get('[data-test="unassign-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="unassign-reason-1"]').text()).toContain('unassign');
    await wrapper.get('[data-test="unassign-1"]').trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a move to an occupied tile, and says why', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({
      buildings: [makeBuilding(1, { col: 4, row: 1 }), makeBuilding(2, { col: 6, row: 1 })],
    }));
    await wrapper.get('[data-test="move-col-1"]').setValue('6');
    await wrapper.get('[data-test="move-row-1"]').setValue('1'); // building 2's tile
    expect(wrapper.get('[data-test="move-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="move-reason-1"]').text()).toContain('already taken');
    await wrapper.get('[data-test="move-1"]').trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalled();
  });

  // moveRefusal's first branch, untested until now: a site can't be moved at
  // all, regardless of what target is typed — matching InspectorFooter's own
  // Move gate (spec §2.2, same wording, `labels.ts`'s `MOVE_SITE_REASON`).
  it('refuses to move a construction site, and says why', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({
      buildings: [makeBuilding(1, { state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 5 } })],
    }));
    expect(wrapper.get('[data-test="move-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="move-reason-1"]').text()).toContain('under construction');
    await wrapper.get('[data-test="move-1"]').trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalled();
  });

  // moveRefusal's middle branch: `min="0"` on the input constrains the
  // spinner, not the click handler, so a fractional value typed straight in
  // (or pasted) has to be caught here or the Ledger would offer a move the
  // engine's own `isTileBuildable`-adjacent checks were never asked about.
  it('refuses a fractional move target, and says why', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({ buildings: [makeBuilding(1)] }));
    await wrapper.get('[data-test="move-col-1"]').setValue('4.5');
    expect(wrapper.get('[data-test="move-1"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="move-reason-1"]').text()).toContain('Whole tiles only');
    await wrapper.get('[data-test="move-1"]').trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalled();
  });

  it('shows the construction countdown and the have/need the Inspector shows', async () => {
    const { wrapper } = mountView(makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'sawmill', state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 14 } })],
    }));
    expect(wrapper.get('[data-test="building-ticks-1"]').text()).toBe('20t');
    // §2.5: a renderer failure costs looks, never a number.
    expect(wrapper.get('[data-test="needs-1"]').text()).toContain('11 / 25 Wood');
  });

  it('shows an em dash for the construction countdown once a building has settled', async () => {
    const { wrapper } = mountView(stockedSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="building-ticks-7"]').text()).toBe('—');
  });

  it('records the coordinates as submitted, not as later edited', async () => {
    const { wrapper, engine } = mountView(makeSnapshot({ buildings: [makeBuilding(1)] }));
    await wrapper.get('[data-test="move-col-1"]').setValue('9');
    await wrapper.get('[data-test="move-row-1"]').setValue('4');
    await wrapper.get('[data-test="move-1"]').trigger('click');
    // The queue holds the object it was given; editing after the click must not
    // reach back into an already-enqueued command.
    await wrapper.get('[data-test="move-col-1"]').setValue('1');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'moveBuilding', buildingId: 1, to: { col: 9, row: 4 } });
  });
});
