// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import DashboardView from '../../src/app/views/DashboardView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot, makeWorker } from './fixtures';

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
    // idleWorkers is a separate snapshot field, not derived from `workers` by
    // this fixture (see fixtures.ts) — it must be set explicitly here so
    // worker 2 (idle, non-hauling) actually enables the assign-hauler button
    // below; otherwise the click on a disabled button is a real-DOM no-op.
    useGameStore().ingest(makeSnapshot({
      workers: [makeWorker(1, { hauling: true }), makeWorker(2, {})],
      idleWorkers: 1,
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
    useGameStore().ingest(makeSnapshot({ workers: [makeWorker(1, {})] }), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect((wrapper.find('[data-test="unassign-hauler"]').element as HTMLButtonElement).disabled).toBe(true);
  });
});
