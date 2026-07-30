// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import WorldView from '../../src/app/views/WorldView.vue';
import { WORLD_RENDERER_KEY } from '../../src/app/world/renderer-key';
import type { WorldRenderer } from '../../src/app/world/renderer-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot } from './fixtures';

function makeFake() {
  const renderer: WorldRenderer = { sync: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn() };
  const factory = vi.fn((host: HTMLElement) => {
    void host;
    return renderer;
  });
  return { renderer, factory };
}

// h()/KeepAlive render function, not a `template:` string — vitest resolves
// `vue` to the runtime-only build, which cannot compile templates.
function mountHarness(factory: unknown) {
  const active = ref(true);
  const Harness = defineComponent({
    setup: () => () => h(KeepAlive, null, [active.value ? h(WorldView) : null]),
  });
  const wrapper = mount(Harness, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [WORLD_RENDERER_KEY as symbol]: factory },
    },
  });
  return { wrapper, active };
}

describe('WorldView', () => {
  it('creates the renderer on the host element and syncs snapshots from the store', async () => {
    const { renderer, factory } = makeFake();
    mountHarness(factory);
    expect(factory).toHaveBeenCalledOnce();
    expect((factory.mock.calls[0][0] as HTMLElement).classList.contains('obsisim-world-host')).toBe(true);
    const snapshot = makeSnapshot({ tick: 5 });
    useGameStore().ingest(snapshot, { paused: false, speed: 1, error: null });
    await nextTick();
    expect(renderer.sync).toHaveBeenCalledWith(snapshot);
  });

  it('syncs an already-present snapshot immediately on mount', () => {
    const { renderer, factory } = makeFake();
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
    useGameStore(pinia).ingest(makeSnapshot({ tick: 9 }), { paused: true, speed: 1, error: null });
    mount(WorldView, { global: { plugins: [pinia], provide: { [WORLD_RENDERER_KEY as symbol]: factory } } });
    expect(renderer.sync).toHaveBeenCalledWith(expect.objectContaining({ tick: 9 }));
  });

  it('stops on deactivate, restarts on activate, disposes on unmount', async () => {
    const { renderer } = makeFake();
    const { wrapper, active } = mountHarness(vi.fn(() => renderer));
    active.value = false;
    await nextTick();
    expect(renderer.stop).toHaveBeenCalledOnce();
    expect(renderer.dispose).not.toHaveBeenCalled();
    active.value = true;
    await nextTick();
    expect(renderer.start).toHaveBeenCalledTimes(2); // initial activate + reactivate
    wrapper.unmount();
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });

  it('renders the text fallback when the factory throws and never syncs', async () => {
    const factory = vi.fn(() => {
      throw new Error('no WebGL');
    });
    const { wrapper } = mountHarness(factory);
    await nextTick();
    const fallback = wrapper.find('[data-test="world-fallback"]');
    expect(fallback.exists()).toBe(true);
    expect(fallback.text()).toContain('no WebGL');
    useGameStore().ingest(makeSnapshot(), { paused: false, speed: 1, error: null });
    await nextTick(); // must not throw — no renderer to sync
  });

  it('renders the fallback when no factory is provided', async () => {
    const { wrapper } = mountHarness(undefined);
    await nextTick();
    expect(wrapper.find('[data-test="world-fallback"]').exists()).toBe(true);
  });
});
