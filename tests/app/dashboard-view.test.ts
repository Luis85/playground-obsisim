// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import DashboardView from '../../src/app/views/DashboardView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { BALANCE } from '../../src/engine/content/balance';
import { makeSnapshot, makeWorker } from './fixtures';
import type { Snapshot } from '../../src/shared/snapshot';

function mountDashboard() {
  const engine = { dispatch: vi.fn() };
  const wrapper = mount(DashboardView, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [ENGINE_KEY as symbol]: engine },
    },
  });
  return { engine, wrapper };
}

describe('DashboardView', () => {
  it('shows the hauler count and dispatches both hauler commands', async () => {
    const { wrapper, engine } = mountDashboard();
    // idleAdults is a separate snapshot field, not derived from `workers` by
    // this fixture (see fixtures.ts) — it must be set explicitly here so
    // worker 2 (idle, non-hauling) actually enables the assign-hauler button
    // below; otherwise the click on a disabled button is a real-DOM no-op.
    useGameStore().ingest(makeSnapshot({
      colonists: [makeWorker(1, { hauling: true }), makeWorker(2, {})],
      idleAdults: 1,
    }), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test="hauler-count"]').text()).toContain('1');
    await wrapper.find('[data-test="assign-hauler"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'assignHauler' });
    await wrapper.find('[data-test="unassign-hauler"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'unassignHauler' });
  });

  it('disables removing a hauler when there are none', async () => {
    const { wrapper } = mountDashboard();
    useGameStore().ingest(makeSnapshot({ colonists: [makeWorker(1, {})] }), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect((wrapper.find('[data-test="unassign-hauler"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  // Distinct counts throughout (1 child, 3 adults, 2 elders; beds 5 of 9), so
  // a cell wired to the wrong field renders a different number rather than
  // coincidentally the right one.
  const colony = (overrides: Partial<Snapshot> = {}): Snapshot => makeSnapshot({
    population: 6,
    demographics: { children: 1, adults: 3, elders: 2 },
    beds: { total: 9, occupied: 5 },
    homeless: 1,
    mealsPerHead: 4.5,
    ...overrides,
  });

  it('summarises the colony by life stage, beds and meals per head', async () => {
    const { wrapper } = mountDashboard();
    useGameStore().ingest(colony(), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="stage-children"]').text()).toBe('1');
    expect(wrapper.get('[data-test="stage-adults"]').text()).toBe('3');
    expect(wrapper.get('[data-test="stage-elders"]').text()).toBe('2');
    expect(wrapper.get('[data-test="beds"]').text()).toContain('5 / 9');
    expect(wrapper.get('[data-test="meals"]').text()).toContain('4.5');
  });

  // Each summary cell must track its own snapshot field: a second ingest with
  // every number changed catches a cell frozen at mount and a cell bound to a
  // neighbour, neither of which one snapshot can distinguish.
  it('every summary number follows the snapshot it came from', async () => {
    const { wrapper } = mountDashboard();
    const store = useGameStore();
    store.ingest(colony(), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    store.ingest(colony({
      demographics: { children: 4, adults: 7, elders: 5 },
      beds: { total: 20, occupied: 11 },
      mealsPerHead: 12.25,
    }), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="stage-children"]').text()).toBe('4');
    expect(wrapper.get('[data-test="stage-adults"]').text()).toBe('7');
    expect(wrapper.get('[data-test="stage-elders"]').text()).toBe('5');
    expect(wrapper.get('[data-test="beds"]').text()).toContain('11 / 20');
    expect(wrapper.get('[data-test="meals"]').text()).toContain('12.3'); // 12.25 to one place
  });

  // The colouring is what makes the figure actionable at a glance, and the
  // tiers are BALANCE's two arrival thresholds — read from BALANCE, so a
  // retune moves the test with the rule rather than invalidating it.
  it.each([
    [BALANCE.birthFoodPerHead - 1, 'obsisim-negative'],
    [BALANCE.birthFoodPerHead, 'obsisim-warning'],
    [BALANCE.nomadFoodPerHead, 'obsisim-positive'],
  ])('meals per head %i is coloured %s', async (mealsPerHead, expected) => {
    const { wrapper } = mountDashboard();
    useGameStore().ingest(colony({ mealsPerHead }), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-test="meals"]').classes()).toContain(expected);
  });
});
