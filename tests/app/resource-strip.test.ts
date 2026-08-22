// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import ResourceStrip from '../../src/app/components/ResourceStrip.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot, makeWorker, stockedWith } from './fixtures';

function mountStrip(snapshot = makeSnapshot()) {
  const engine = { dispatch: vi.fn() };
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  useGameStore(pinia).ingest(snapshot, { paused: true, speed: 1, error: null });
  return {
    wrapper: mount(ResourceStrip, { global: { plugins: [pinia], provide: { [ENGINE_KEY as symbol]: engine } } }),
    engine,
  };
}

describe('ResourceStrip', () => {
  it('assigns a hauler', async () => {
    const { wrapper, engine } = mountStrip(makeSnapshot({ idleAdults: 1 }));
    await wrapper.get('[data-test="assign-hauler"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'assignHauler' });
  });

  it('unassigns a hauler', async () => {
    const { wrapper, engine } = mountStrip(makeSnapshot({ colonists: [makeWorker(1, { hauling: true })] }));
    await wrapper.get('[data-test="unassign-hauler"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'unassignHauler' });
  });

  it('disables assign with no idle adults AND says why', () => {
    const { wrapper } = mountStrip(makeSnapshot({ idleAdults: 0 }));
    expect(wrapper.get('[data-test="assign-hauler"]').attributes('disabled')).toBeDefined();
    // §2.2: visible, not hidden in a title. A disabled control with no stated
    // reason is the exact thing that rule exists to stop.
    expect(wrapper.get('[data-test="hauler-reason"]').text()).toContain('No idle adults');
  });

  it('marks a short runway', () => {
    const { wrapper } = mountStrip(makeSnapshot({
      stockpile: { ...stockedWith({ bread: 20 }), bread: { stock: 20, deliveredRate: 0, madeRate: 0, consumptionRate: 2, netFlow: -2, stockValue: 0 } },
    }));
    expect(wrapper.get('[data-test="strip-bread"]').classes()).toContain('obsisim-negative');
  });

  // Guard parity with every other view in this codebase (BuildingsView,
  // DashboardView, EconomyView, PopulationView, PopulationSummary, TopBar all
  // open with `v-if="store.snapshot"`). Mounting a component directly in a
  // test — as every other test in this file does before seeding — is exactly
  // the situation the router's `v-if="store.snapshot"` gate normally
  // prevents in production; this proves the component does not fall back to
  // a lying `store.snapshot!` when that gate is absent.
  it('renders nothing before a snapshot has been ingested', () => {
    const wrapper = mount(ResourceStrip, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
        provide: { [ENGINE_KEY as symbol]: { dispatch: vi.fn() } },
      },
    });
    expect(wrapper.find('[data-test="resource-strip"]').exists()).toBe(false);
  });
});
