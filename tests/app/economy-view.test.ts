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
    snapshot.stockpile.bread = { stock: 6, deliveredRate: 0, madeRate: 0, consumptionRate: 0.5, netFlow: -0.5, stockValue: 0 };
    const wrapper = mountWith(EconomyView, snapshot);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="runway-bread"]').text()).toBe('~12t');
  });

  it('states the haul backlog and how many buildings it has stopped', async () => {
    // Waiting (18), stalled (2), and haulers (3) are mutually distinct, so a
    // getter swapped between the "stalled" and "haulers" slots — or a slot
    // reordered in the template string — cannot hide behind matching numbers
    // the way it could when stalledBuildings and haulerCount were both 1.
    const wrapper = mountWith(EconomyView, makeSnapshot({
      buildings: [
        makeBuilding(1, { buffered: 12, state: 'outputFull' }),
        makeBuilding(2, { buffered: 6, state: 'outputFull' }),
        makeBuilding(3, { buffered: 0, state: 'producing' }),
      ],
      workers: [
        makeWorker(1, { hauling: true }),
        makeWorker(2, { hauling: true }),
        makeWorker(3, { hauling: true }),
      ],
    }));
    await wrapper.vm.$nextTick();
    const pressure = wrapper.find('[data-test="haul-pressure"]');
    const haul = pressure.text();
    expect(haul).toContain('18');
    expect(haul).toContain('2 stalled');
    expect(haul).toContain('3 haulers on duty');
    expect(pressure.classes()).toContain('obsisim-negative');
  });

  it('uses the singular "hauler" when exactly one is on duty', async () => {
    // Waiting (7), stalled (2), and haulers (1) are again mutually distinct.
    // toContain('1 hauler on duty') genuinely discriminates: the wrongly
    // pluralized '1 haulers on duty' does not contain that substring, unlike
    // a bare toContain('1 hauler'), which either string would satisfy.
    const wrapper = mountWith(EconomyView, makeSnapshot({
      buildings: [
        makeBuilding(1, { buffered: 5, state: 'outputFull' }),
        makeBuilding(2, { buffered: 2, state: 'outputFull' }),
      ],
      workers: [makeWorker(1, { hauling: true })],
    }));
    await wrapper.vm.$nextTick();
    const haul = wrapper.find('[data-test="haul-pressure"]').text();
    expect(haul).toContain('1 hauler on duty');
  });

  // OBS-4-06: the column is fed by stockpile inflow, which since increment 4
  // means "a hauler delivered it", not "a building made it". Under the old
  // "Prod/t" heading a fully staffed building with no haulers reported
  // `producing` and 0.00 side by side, which reads as a contradiction rather
  // than as the haul backlog it is.
  it('heads the store-inflow column Delivered/t, not Prod/t', async () => {
    const wrapper = mountWith(EconomyView, makeSnapshot({ buildings: [makeBuilding(1, { defId: 'forester' })] }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="inflow-heading"]').text()).toBe('Delivered/t');
    expect(wrapper.text()).not.toContain('Prod/t');
  });

  it('shows a healthy but uncollected stage as ok with nothing delivered', async () => {
    const snapshot = makeSnapshot({
      buildings: [{ ...baseBuilding, id: 1, defId: 'forester', workers: 2, buffered: 12, state: 'producing' }],
    });
    // Made 12 units into the buffer, delivered none: no haulers on duty. The
    // three rates are deliberately distinct — 0 delivered against 0.50
    // consumed and 4 in stock — so the column binding to consumptionRate or
    // to stock would change this assertion rather than coincide with it.
    snapshot.stockpile.wood = { stock: 4, deliveredRate: 0, madeRate: 0, consumptionRate: 0.5, netFlow: -0.5, stockValue: 0 };
    const wrapper = mountWith(EconomyView, snapshot);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="status-forester"]').text()).toBe('ok');
    expect(wrapper.find('[data-test="delivered-forester"]').text()).toBe('0.00');
    // "ok" beside 0.00 only reads as a backlog because the heading names
    // delivery; under "Prod/t" the same row claimed the stage was fine and
    // producing nothing at once.
    expect(wrapper.find('[data-test="inflow-heading"]').text()).toBe('Delivered/t');
  });

  it('says the colony is keeping up when nothing waits', async () => {
    const wrapper = mountWith(EconomyView, makeSnapshot({ buildings: [makeBuilding(1, { buffered: 0 })] }));
    await wrapper.vm.$nextTick();
    const pressure = wrapper.find('[data-test="haul-pressure"]');
    expect(pressure.text()).toContain('keeping up');
    expect(pressure.classes()).not.toContain('obsisim-negative');
  });
});

describe('DashboardView', () => {
  it('shows runway for draining resources and an em dash otherwise', async () => {
    const snapshot = makeSnapshot();
    snapshot.stockpile.wheat = { stock: 10, deliveredRate: 0, madeRate: 0, consumptionRate: 1, netFlow: -1, stockValue: 0 };
    snapshot.stockpile.wood = { stock: 5, deliveredRate: 1, madeRate: 0, consumptionRate: 0, netFlow: 1, stockValue: 0 };
    const wrapper = mountWith(DashboardView, snapshot);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="runway-wheat"]').text()).toBe('~10t');
    expect(wrapper.find('[data-test="runway-wood"]').text()).toBe('—');
  });

  // Same column, same source, same rename — the two tables must not disagree
  // about what the stockpile's inflow statistic is called (OBS-4-06).
  it('heads the store-inflow column Delivered/t, not Prod/t', async () => {
    const wrapper = mountWith(DashboardView, makeSnapshot());
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="inflow-heading"]').text()).toBe('Delivered/t');
    expect(wrapper.text()).not.toContain('Prod/t');
  });
});
