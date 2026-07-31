// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import WorldView from '../../src/app/views/WorldView.vue';
import { WORLD_RENDERER_KEY } from '../../src/app/world/renderer-key';
import type { WorldRenderer } from '../../src/app/world/renderer-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeBuilding, makeSnapshot, makeWorker } from './fixtures';

// Everything here runs against a fake WorldRenderer injected through
// WORLD_RENDERER_KEY — the real Excalibur factory must never be imported by
// tests (spec §2.5): excalibur touches `window` at module scope and takes
// seconds to evaluate under happy-dom.

function makeFake() {
  const renderer: WorldRenderer = {
    sync: vi.fn(), pick: vi.fn(() => null),
    tileAt: vi.fn(() => null), setGhost: vi.fn(), setSelection: vi.fn(),
    onFatal: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn(),
  };
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

  it('shows a tooltip for the picked building and hides it on leave', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    const { wrapper } = mountHarness(factory);
    useGameStore().ingest(makeSnapshot({
      buildings: [makeBuilding(7, { defId: 'bakery', workers: 1, workerSlots: 2, state: 'producing', batchActive: true, progressPct: 55 })],
    }), { paused: false, speed: 1, error: null });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    const tooltip = wrapper.find('[data-test="world-tooltip"]');
    expect(tooltip.exists()).toBe(true);
    expect(tooltip.text()).toContain('Bakery');
    expect(tooltip.text()).toContain('batch 55%');
    await wrapper.find('[data-test="world-host"]').trigger('pointerleave');
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(false);
  });

  it('keeps a stationary tooltip live as snapshots tick underneath it', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    const { wrapper } = mountHarness(factory);
    const buildingAt = (progressPct: number) => makeSnapshot({
      buildings: [makeBuilding(7, { defId: 'bakery', workers: 1, workerSlots: 2, state: 'producing', batchActive: true, progressPct })],
    });
    useGameStore().ingest(buildingAt(10), { paused: false, speed: 1, error: null });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(wrapper.find('[data-test="world-tooltip"]').text()).toContain('batch 10%');
    // no further pointer event — the next snapshot alone must refresh it
    useGameStore().ingest(buildingAt(60), { paused: false, speed: 1, error: null });
    await nextTick();
    expect(wrapper.find('[data-test="world-tooltip"]').text()).toContain('batch 60%');
  });

  it('shows a worker tooltip with efficiency and tool state', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'worker', id: 3 });
    const { wrapper } = mountHarness(factory);
    useGameStore().ingest(makeSnapshot({
      workers: [makeWorker(3, { hunger: 40, efficiency: 0.8, buildingId: null, toolTicks: 12 })],
    }), { paused: false, speed: 1, error: null });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 10, pageY: 10 });
    const tooltip = wrapper.find('[data-test="world-tooltip"]');
    expect(tooltip.text()).toContain('Worker #3');
    expect(tooltip.text()).toContain('efficiency 80%');
    expect(tooltip.text()).toContain('tooled (12t left)');
  });

  it('hides a stationary tooltip once the hovered worker is no longer under the pointer', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'worker', id: 3 });
    const { wrapper } = mountHarness(factory);
    useGameStore().ingest(makeSnapshot({
      workers: [makeWorker(3, { hunger: 0, efficiency: 1, buildingId: null, toolTicks: 0 })],
    }), { paused: false, speed: 1, error: null });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 10, pageY: 10 });
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(true);
    // the worker walks away; the next snapshot re-runs the live hit-test
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue(null);
    useGameStore().ingest(makeSnapshot({
      workers: [makeWorker(3, { hunger: 0, efficiency: 1, buildingId: 1, toolTicks: 0 })],
    }), { paused: false, speed: 1, error: null });
    await nextTick();
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(false);
  });

  it('clears a stale hover after the animation tail even with no further snapshots', async () => {
    vi.useFakeTimers();
    try {
      const { renderer, factory } = makeFake();
      (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'worker', id: 3 });
      const { wrapper } = mountHarness(factory);
      useGameStore().ingest(makeSnapshot({
        workers: [makeWorker(3, { hunger: 0, efficiency: 1, buildingId: null, toolTicks: 0 })],
      }), { paused: true, speed: 1, error: null });
      await nextTick();
      await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 10, pageY: 10 });
      expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(true);
      // paused: the walk finishes without any snapshot; the trailing recheck fires
      (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue(null);
      vi.advanceTimersByTime(2100);
      await nextTick();
      expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the encoding legend', async () => {
    const { factory } = makeFake();
    const { wrapper } = mountHarness(factory);
    await nextTick();
    const legend = wrapper.find('[data-test="world-legend"]');
    expect(legend.exists()).toBe(true);
    expect(legend.text()).toContain('producing');
    expect(legend.text()).toContain('idle camp');
    expect(legend.text()).toContain('selected');
    expect(legend.text()).toContain('ghost: buildable');
    expect(legend.text()).toContain('ghost: blocked');
  });

  it('falls back when the renderer reports an async fatal failure', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper } = mountHarness(factory);
    await nextTick();
    const listener = (renderer.onFatal as ReturnType<typeof vi.fn>).mock.calls[0][0] as (message: string) => void;
    listener('context lost');
    await nextTick();
    const fallback = wrapper.find('[data-test="world-fallback"]');
    expect(fallback.exists()).toBe(true);
    expect(fallback.text()).toContain('context lost');
  });
});
