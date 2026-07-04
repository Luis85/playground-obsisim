// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import TopBar from '../../src/app/components/TopBar.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot } from './fixtures';

function mountTopBar() {
  const engine = { start: vi.fn(), pause: vi.fn(), setSpeed: vi.fn(), stepOnce: vi.fn(), reset: vi.fn() };
  const wrapper = mount(TopBar, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [ENGINE_KEY as symbol]: engine },
    },
  });
  const store = useGameStore();
  store.ingest(makeSnapshot({ tick: 42, population: 3, colonyWealth: 123 }), { paused: true, speed: 1, error: null });
  return { engine, wrapper, store };
}

describe('TopBar', () => {
  it('shows tick, population, and wealth from the store', async () => {
    const { wrapper } = mountTopBar();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('42');
    expect(wrapper.text()).toContain('123');
  });

  it('play/pause/speed/step call the engine', async () => {
    const { engine, wrapper } = mountTopBar();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="play"]').trigger('click');
    expect(engine.start).toHaveBeenCalled();
    await wrapper.find('[data-test="step"]').trigger('click');
    expect(engine.stepOnce).toHaveBeenCalled();
    await wrapper.find('[data-test="speed-4"]').trigger('click');
    expect(engine.setSpeed).toHaveBeenCalledWith(4);
  });
});
