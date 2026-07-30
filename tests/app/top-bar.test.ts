// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import TopBar from '../../src/app/components/TopBar.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot } from './fixtures';

// A paused colony at tick 42, mirroring what App.vue passes to store.ingest
// on every engine update — every test below mounts through this, not a
// bespoke snapshot, so an assertion here reflects the real ingest path.
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

  it('two-step reset: alone it never resets, cancel returns to idle, confirm resets', async () => {
    const { engine, wrapper } = mountTopBar();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="reset"]').trigger('click');
    expect(engine.reset).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="reset-confirm"]').exists()).toBe(true);

    await wrapper.find('[data-test="reset-cancel"]').trigger('click');
    expect(wrapper.find('[data-test="reset"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="reset-confirm"]').exists()).toBe(false);

    await wrapper.find('[data-test="reset"]').trigger('click');
    await wrapper.find('[data-test="reset-confirm"]').trigger('click');
    expect(engine.reset).toHaveBeenCalled();
  });

  it('arming reset puts Cancel in the original button slot, not Confirm reset', async () => {
    // A double-click's second event arrives in a later microtask, after Vue's
    // re-render has already swapped "Reset colony" for the confirm/cancel
    // pair, and lands on whatever now occupies that same position. Asserting
    // element order (not CSS, not text) pins that the control sitting at the
    // original slot is the harmless Cancel button, not the destructive
    // Confirm one -- reverting the template's button order makes this fail
    // while every other reset test above still passes.
    const { wrapper } = mountTopBar();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="reset"]').trigger('click');
    const armedButtons = wrapper.findAll('button[data-test^="reset"]');
    expect(armedButtons.map((b) => b.attributes('data-test'))).toEqual(['reset-cancel', 'reset-confirm']);
  });
});
