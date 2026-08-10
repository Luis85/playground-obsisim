// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import BuildingsView from '../../src/app/views/BuildingsView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { BALANCE } from '../../src/engine/content/balance';
import { makeBuilding, makeSnapshot } from './fixtures';
import type { BuildingState, BuildingSnapshot } from '../../src/shared/snapshot';

// A single 1/2-staffed Forester, with the caller choosing the wood stock (to
// drive the construct-button's affordable/disabled state) and the building's
// reported state (to drive the humanized-label assertions below).
function mountView(
  stock: { wood?: number; planks?: number } = {},
  state: BuildingState = 'producing',
  building: Partial<BuildingSnapshot> = {},
) {
  const engine = { dispatch: vi.fn() };
  const wrapper = mount(BuildingsView, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [ENGINE_KEY as symbol]: engine },
    },
  });
  const snapshot = makeSnapshot({
    buildings: [makeBuilding(7, { defId: 'forester', workers: 1, workerSlots: 2, state, progress: 1, batchActive: true, progressPct: 33, workPower: 1, col: 5, row: 2, ...building })],
    idleAdults: 2,
  });
  snapshot.stockpile.wood.stock = stock.wood ?? 0;
  snapshot.stockpile.planks.stock = stock.planks ?? 0;
  useGameStore().ingest(snapshot, { paused: true, speed: 1, error: null });
  return { engine, wrapper };
}

describe('BuildingsView', () => {
  // One test covers three related UX changes (Step 2's labels and Step 4's
  // hint) against a single mounted view, reusing the `waiting` wrapper for
  // the empty-colony re-ingest rather than mounting a fourth time.
  it('renders humanized state labels and a starter hint once the colony has none', async () => {
    const producing = mountView();
    await producing.wrapper.vm.$nextTick();
    expect(producing.wrapper.text()).toContain('Forester');
    expect(producing.wrapper.text()).toContain('Producing');
    expect(producing.wrapper.text()).not.toContain('producing'); // the raw state, not the label

    const waiting = mountView({}, 'waitingForInput');
    await waiting.wrapper.vm.$nextTick();
    expect(waiting.wrapper.text()).toContain('Waiting for input');
    expect(waiting.wrapper.text()).not.toContain('waitingForInput');

    useGameStore().ingest(makeSnapshot({ buildings: [] }), { paused: true, speed: 1, error: null });
    await waiting.wrapper.vm.$nextTick();
    const cell = waiting.wrapper.get('td[colspan="11"]');
    expect(cell.text()).toContain('Forester');
    expect(cell.text()).toMatch(/Gatherer.?s Hut/);
    expect(cell.text()).toContain('10 wood each');
    expect(cell.text()).toContain('then assign your idle workers with');

    const unstaffed = mountView({}, 'unstaffed');
    await unstaffed.wrapper.vm.$nextTick();
    expect(unstaffed.wrapper.text()).toContain('Unstaffed');
    expect(unstaffed.wrapper.text()).not.toContain('unstaffed');
  });

  // Assign/unassign dispatch a plain command object; the store's own success
  // notice on the accepted path is covered at the engine layer in
  // command-system.test.ts, not re-asserted against this stubbed engine here.
  it('dispatches assign/unassign for a building row', async () => {
    const { engine, wrapper } = mountView();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="assign-7"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'assignWorker', buildingId: 7 });
    await wrapper.find('[data-test="unassign-7"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'unassignWorker', buildingId: 7 });
  });

  // affordable is a computed Record<BuildingDefId, boolean>, one entry per
  // catalog id; only the forester row is asserted here since every other id
  // goes through the identical `every(cost >= stock)` check.
  it('construct button dispatches when affordable and disables when not', async () => {
    const rich = mountView({ wood: 100 });
    await rich.wrapper.vm.$nextTick();
    await rich.wrapper.find('[data-test="construct-forester"]').trigger('click');
    expect(rich.engine.dispatch).toHaveBeenCalledWith({ type: 'constructBuilding', buildingDefId: 'forester' });

    const poor = mountView({ wood: 0 });
    await poor.wrapper.vm.$nextTick();
    expect((poor.wrapper.find('[data-test="construct-forester"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  // Task 4 added the storehouse def and left recipeLabel treating every
  // recipe-less def as housing, so the shed rendered "Shelters 0" at exactly
  // the moment a player is deciding what to build. BALANCE.storehouseCapacity
  // (60) is asserted directly rather than a literal, so a retune doesn't
  // desync this test from the def.
  it('names the storehouse\'s role as storage, not shelter', async () => {
    const { wrapper } = mountView();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain(`Stores ${BALANCE.storehouseCapacity}`);
    expect(wrapper.text()).not.toContain('Shelters 0');
  });

  // The fallback path must be able to build the building this increment
  // adds, or table/canvas parity is a claim rather than a property. Wood and
  // planks are both funded since the storehouse costs both.
  it('constructs a storehouse from the table', async () => {
    const { engine, wrapper } = mountView({ wood: 100, planks: 100 });
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
    const wrapper = mount(BuildingsView, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
        provide: { [ENGINE_KEY as symbol]: { dispatch: vi.fn() } },
      },
    });
    useGameStore().ingest(makeSnapshot({
      buildings: [
        makeBuilding(7, { defId: 'mill', state: 'producing', buffered: 5, inputBuffered: 3 }),
        makeBuilding(8, { defId: 'storehouse', state: 'storing', stored: 41, storage: 60 }),
      ],
    }), { paused: true, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="waiting-7"]').text()).toBe('5');
    expect(wrapper.find('[data-test="in-7"]').text()).toBe('3');
    expect(wrapper.find('[data-test="waiting-8"]').text()).toBe('41 / 60');
  });

  it('shows each building\'s tile and demolishes after the two-step confirm', async () => {
    const { engine, wrapper } = mountView();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('(5, 2)');
    const demolish = wrapper.find('[data-test="demolish-7"]');
    await demolish.trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalledWith({ type: 'demolishBuilding', buildingId: 7 });
    await demolish.trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'demolishBuilding', buildingId: 7 });
  });

  it('shows waiting units and names the output-full stall', async () => {
    const { wrapper } = mountView({}, 'outputFull', { buffered: 12 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="waiting-7"]').text()).toBe('12');
    expect(wrapper.text()).toContain('Output full');
  });

  it('shows remaining downtime for a relocating building', async () => {
    const { wrapper } = mountView({}, 'relocating', { relocatingTicks: 6 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="downtime-7"]').text()).toBe('6t');
  });

  it('shows an em dash when a building is not relocating', async () => {
    const { wrapper } = mountView({}, 'producing', { relocatingTicks: 0 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="downtime-7"]').text()).toBe('—');
  });

  // A producer and a house in ONE render, because the two share a column: a
  // test that only ever saw one kind could not tell a branch from a constant.
  function mountMixed(house: Partial<BuildingSnapshot> = {}) {
    const wrapper = mount(BuildingsView, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
        provide: { [ENGINE_KEY as symbol]: { dispatch: vi.fn() } },
      },
    });
    useGameStore().ingest(makeSnapshot({
      buildings: [
        makeBuilding(7, { defId: 'forester', state: 'producing', progressPct: 33, beds: 0, occupants: 0 }),
        makeBuilding(8, {
          defId: 'house', state: 'housing', workerSlots: 0, progressPct: 0,
          beds: BALANCE.houseBeds, occupants: 3, ...house,
        }),
      ],
    }), { paused: true, speed: 1, error: null });
    return wrapper;
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
});
