// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import EconomyView from '../../src/app/views/EconomyView.vue';
import DashboardView from '../../src/app/views/DashboardView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeBuilding, makeSnapshot, makeWorker } from './fixtures';

// The economy-reading affordances: per-stage bottleneck status in the chain
// view, and the "Empties in" runway derived from net flow.

function mountWith(component: typeof EconomyView | typeof DashboardView, snapshot: ReturnType<typeof makeSnapshot>) {
  const wrapper = mount(component, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      // DashboardView injects ENGINE_KEY unconditionally (its hauler controls);
      // EconomyView never reads it, so providing it here is a no-op for those
      // cases but keeps the DashboardView case from warning on missing injection.
      provide: { [ENGINE_KEY as symbol]: { dispatch: vi.fn() } },
    },
  });
  useGameStore().ingest(snapshot, { paused: true, speed: 1, error: null });
  return wrapper;
}

const baseBuilding = {
  col: 0, row: 0, workers: 0, workerSlots: 2, progress: 0, batchActive: false,
  progressPct: 0, tooledWorkers: 0, workPower: 0, buffered: 0,
};

describe('EconomyView', () => {
  it('flags a starved stage and shows the not-built default', async () => {
    const snapshot = makeSnapshot({
      buildings: [{ ...baseBuilding, id: 1, defId: 'mill', workers: 2, state: 'waitingForInput' }],
    });
    const wrapper = mountWith(EconomyView, snapshot);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="status-mill"]').text()).toContain('starved');
    expect(wrapper.find('[data-test="status-bakery"]').text()).toBe('not built');
  });

  it('shows the output runway for a draining stage', async () => {
    const snapshot = makeSnapshot({
      buildings: [{ ...baseBuilding, id: 1, defId: 'bakery', workers: 1, state: 'producing' }],
    });
    snapshot.stockpile.bread = { stock: 6, productionRate: 0, consumptionRate: 0.5, netFlow: -0.5, stockValue: 0 };
    const wrapper = mountWith(EconomyView, snapshot);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="runway-bread"]').text()).toBe('~12t');
  });

  it('states the haul backlog and how many buildings it has stopped', async () => {
    const wrapper = mountWith(EconomyView, makeSnapshot({
      buildings: [
        makeBuilding(1, { buffered: 12, state: 'outputFull' }),
        makeBuilding(2, { buffered: 6, state: 'producing' }),
      ],
      workers: [makeWorker(1, { hauling: true })],
    }));
    await wrapper.vm.$nextTick();
    const haul = wrapper.find('[data-test="haul-pressure"]').text();
    expect(haul).toContain('18');
    expect(haul).toContain('1 stalled');
    expect(haul).toContain('1 hauler');
  });

  it('says the colony is keeping up when nothing waits', async () => {
    const wrapper = mountWith(EconomyView, makeSnapshot({ buildings: [makeBuilding(1, { buffered: 0 })] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="haul-pressure"]').text()).toContain('keeping up');
  });
});

describe('DashboardView', () => {
  it('shows runway for draining resources and an em dash otherwise', async () => {
    const snapshot = makeSnapshot();
    snapshot.stockpile.wheat = { stock: 10, productionRate: 0, consumptionRate: 1, netFlow: -1, stockValue: 0 };
    snapshot.stockpile.wood = { stock: 5, productionRate: 1, consumptionRate: 0, netFlow: 1, stockValue: 0 };
    const wrapper = mountWith(DashboardView, snapshot);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="runway-wheat"]').text()).toBe('~10t');
    expect(wrapper.find('[data-test="runway-wood"]').text()).toBe('—');
  });
});
