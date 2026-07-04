// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import BuildingsView from '../../src/app/views/BuildingsView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot } from './fixtures';

function mountView(stock: { wood?: number } = {}) {
  const engine = { dispatch: vi.fn() };
  const wrapper = mount(BuildingsView, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [ENGINE_KEY as symbol]: engine },
    },
  });
  const snapshot = makeSnapshot({
    buildings: [{
      id: 7, defId: 'forester', workers: 1, workerSlots: 2, state: 'producing',
      progress: 1, batchActive: true, progressPct: 33, tooledWorkers: 0, workPower: 1,
    }],
    idleWorkers: 2,
  });
  snapshot.stockpile.wood.stock = stock.wood ?? 0;
  useGameStore().ingest(snapshot, { paused: true, speed: 1, error: null });
  return { engine, wrapper };
}

describe('BuildingsView', () => {
  it('renders constructed buildings with state', async () => {
    const { wrapper } = mountView();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Forester');
    expect(wrapper.text()).toContain('producing');
  });

  it('dispatches assign/unassign for a building row', async () => {
    const { engine, wrapper } = mountView();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="assign-7"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'assignWorker', buildingId: 7 });
    await wrapper.find('[data-test="unassign-7"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'unassignWorker', buildingId: 7 });
  });

  it('construct button dispatches when affordable and disables when not', async () => {
    const rich = mountView({ wood: 100 });
    await rich.wrapper.vm.$nextTick();
    await rich.wrapper.find('[data-test="construct-forester"]').trigger('click');
    expect(rich.engine.dispatch).toHaveBeenCalledWith({ type: 'constructBuilding', buildingDefId: 'forester' });

    const poor = mountView({ wood: 0 });
    await poor.wrapper.vm.$nextTick();
    expect((poor.wrapper.find('[data-test="construct-forester"]').element as HTMLButtonElement).disabled).toBe(true);
  });
});
