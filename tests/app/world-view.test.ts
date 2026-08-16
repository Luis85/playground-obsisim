// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import WorldView from '../../src/app/views/WorldView.vue';
import { WORLD_RENDERER_KEY } from '../../src/app/world/renderer-key';
import type { WorldRenderer } from '../../src/app/world/renderer-key';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeBuilding, makeSnapshot, makeWorker, stockedWith } from './fixtures';

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
  const engine = { dispatch: vi.fn() };
  const Harness = defineComponent({
    setup: () => () => h(KeepAlive, null, [active.value ? h(WorldView) : null]),
  });
  const wrapper = mount(Harness, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: {
        [WORLD_RENDERER_KEY as symbol]: factory,
        [ENGINE_KEY as symbol]: engine,
      },
    },
  });
  return { wrapper, active, engine };
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
    mount(WorldView, {
      global: {
        plugins: [pinia],
        provide: { [WORLD_RENDERER_KEY as symbol]: factory, [ENGINE_KEY as symbol]: { dispatch: vi.fn() } },
      },
    });
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
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'colonist', id: 3 });
    const { wrapper } = mountHarness(factory);
    useGameStore().ingest(makeSnapshot({
      colonists: [makeWorker(3, { hunger: 40, efficiency: 0.8, buildingId: null, toolTicks: 12 })],
    }), { paused: false, speed: 1, error: null });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 10, pageY: 10 });
    const tooltip = wrapper.find('[data-test="world-tooltip"]');
    expect(tooltip.text()).toContain('Colonist #3');
    expect(tooltip.text()).toContain('efficiency 80%');
    expect(tooltip.text()).toContain('tooled (12t left)');
  });

  it('hides a stationary tooltip once the hovered worker is no longer under the pointer', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'colonist', id: 3 });
    const { wrapper } = mountHarness(factory);
    useGameStore().ingest(makeSnapshot({
      colonists: [makeWorker(3, { hunger: 0, efficiency: 1, buildingId: null, toolTicks: 0 })],
    }), { paused: false, speed: 1, error: null });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 10, pageY: 10 });
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(true);
    // the worker walks away; the next snapshot re-runs the live hit-test
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue(null);
    useGameStore().ingest(makeSnapshot({
      colonists: [makeWorker(3, { hunger: 0, efficiency: 1, buildingId: 1, toolTicks: 0 })],
    }), { paused: false, speed: 1, error: null });
    await nextTick();
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(false);
  });

  it('clears a stale hover after the animation tail even with no further snapshots', async () => {
    vi.useFakeTimers();
    try {
      const { renderer, factory } = makeFake();
      (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'colonist', id: 3 });
      const { wrapper } = mountHarness(factory);
      useGameStore().ingest(makeSnapshot({
        colonists: [makeWorker(3, { hunger: 0, efficiency: 1, buildingId: null, toolTicks: 0 })],
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
    expect(legend.text()).toContain('output full');
    expect(legend.text()).toContain('under construction');
    expect(legend.text()).toContain('relocating');
    // Both halves of the direction pair, and both halves of the store's
    // encoding: an entry per addition (spec §2.10 — the legend explains every
    // encoding, and this increment is not the exception).
    expect(legend.text()).toContain('carrying out');
    expect(legend.text()).toContain('carrying in');
    // Named ON the carrying-in entry rather than as an entry of its own: a
    // transfer is drawn with that exact mark and no other (spec §2.10), so a
    // separate row would advertise an encoding the canvas does not have. This
    // pins the WORD reaching the legend, not which hauler is transferring —
    // that is the Population view's job column, which is where the
    // discriminating check for the transfer label lives.
    expect(legend.text()).toContain('transfer');
    expect(legend.text()).toContain('storing');
    expect(legend.text()).toContain('store fill');
    expect(legend.text()).toContain('housing');
    expect(legend.text()).toContain('child');
    expect(legend.text()).toContain('elder');
    expect(legend.text()).toContain('homeless');

    // Every entry's swatch is a separate child element, sibling to the label
    // text — never the label's own element. "output full" and "carrying"
    // once broke this by putting the label INSIDE the chip-classed element,
    // which (given .obsisim-chip's fixed 12x12 size and the flex legend-span
    // rule) rendered as a bare box with overflowing text and no visible
    // swatch. Checked across every entry, not just those two, so increment 5
    // cannot reintroduce the same collapse.
    //
    // Exact counts, not thresholds: 22 entries, 21 with a swatch ("idle camp"
    // is a literal glyph with no encoded color). A >= bound stayed green when
    // WorldLegend's "relocating" entry (added for increment 5's Relocation
    // state) was deleted outright, because 13 and 12 still satisfied it. Task
    // 9 adds "under construction" (its own stateRing swatch), taking both
    // counts up by exactly one.
    const entries = legend.findAll('span');
    expect(entries.length).toBe(22);
    let withSwatch = 0;
    for (const entry of entries) {
      const ownsChipClass = entry.classes().includes('obsisim-chip');
      const swatch = entry.find('.obsisim-chip');
      if (!ownsChipClass && !swatch.exists()) continue; // "idle camp": a literal glyph, no encoded color
      expect(ownsChipClass).toBe(false); // the label's own span must never double as the chip
      expect(swatch.exists()).toBe(true); // the swatch must be a distinct child element
      expect(swatch.text()).toBe(''); // …carrying no label text of its own
      withSwatch += 1;
    }
    expect(withSwatch).toBe(21);
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

describe('WorldView interaction', () => {
  const richSnapshot = (buildings = [makeBuilding(7, { defId: 'bakery', col: 6, row: 3 })]) =>
    makeSnapshot({ buildings, stockpile: stockedWith({ wood: 100, planks: 100 }) });

  function armedHarness(tile: { col: number; row: number } | null = { col: 8, row: 4 }) {
    const { renderer, factory } = makeFake();
    (renderer.tileAt as ReturnType<typeof vi.fn>).mockReturnValue(tile);
    const mounted = mountHarness(factory);
    useGameStore().ingest(richSnapshot(), { paused: false, speed: 1, error: null });
    return { renderer, ...mounted };
  }

  it('arms from the palette, previews the ghost, and constructs at the clicked tile — staying armed', async () => {
    const { renderer, wrapper, engine } = armedHarness();
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'forester', col: 8, row: 4, valid: true });
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).toHaveBeenCalledWith({
      type: 'constructBuilding', buildingDefId: 'forester', at: { col: 8, row: 4 },
    });
    expect(wrapper.find('[data-test="palette-forester"]').classes()).toContain('is-armed');
  });

  // Spec §2.1, increment 10: the exact inversion of increment 9's rule. The
  // fixture is unchanged from the one that used to prove the ghost went
  // invalid — a house already queued against exactly its own cost, published
  // stock UNCHANGED at order time — because that is the strongest case for
  // the OLD rule and therefore the sharpest regression check for its removal:
  // if `tileValid` still read `affordableDefs` anywhere, this is the fixture
  // that would catch it.
  it('a queued site\'s outstanding demand no longer invalidates the placement ghost', async () => {
    const { renderer, wrapper } = armedHarness();
    await nextTick();
    await wrapper.find('[data-test="palette-house"]').trigger('click');
    useGameStore().ingest(makeSnapshot({
      tick: 1, // a genuinely later tick — tick 0 again would read as a timeline reset and disarm the mode
      buildings: [
        makeBuilding(7, { defId: 'bakery', col: 6, row: 3 }),
        makeBuilding(8, {
          defId: 'house', state: 'underConstruction', constructionTicks: 20,
          constructionNeeds: { wood: 15, planks: 5 }, // the site's whole cost, undelivered
        }),
      ],
      stockpile: stockedWith({ wood: 15, planks: 5 }), // exactly one house's worth, all already owed
    }), { paused: false, speed: 1, error: null });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'house', col: 8, row: 4, valid: true });
  });

  // `tileValid`'s own gate, in its own file: BuildPalette and BuildingsView
  // cannot exercise it — it is WorldView's independent predicate, and the
  // PRIMARY canvas flow, so its gate mattered most of the three. The fixture
  // is a genuinely EMPTY ledger (every RESOURCE_IDS entry at 0 via
  // `stockedWith()`), not merely a rich snapshot that happens to cover the
  // def: `richSnapshot` above (wood: 100, planks: 100) would pass this
  // assertion whether or not the gate still existed, which is exactly the
  // false-positive the brief calls out.
  it('WorldView accepts the tile for an unaffordable def', async () => {
    const { renderer, wrapper, engine } = armedHarness();
    await nextTick();
    useGameStore().ingest(makeSnapshot({
      tick: 1,
      buildings: [makeBuilding(7, { defId: 'bakery', col: 6, row: 3 })],
      stockpile: stockedWith(), // every resource at 0
    }), { paused: false, speed: 1, error: null });
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'forester', col: 8, row: 4, valid: true });
    // The predicate alone proves nothing if the click handler still refused
    // separately — pin the player-visible outcome too: an unaffordable order
    // actually dispatches, the same as the primary click-dispatch assertions
    // above.
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).toHaveBeenCalledWith({
      type: 'constructBuilding', buildingDefId: 'forester', at: { col: 8, row: 4 },
    });
  });

  it('switching armed definitions over a parked pointer swaps the ghost in place', async () => {
    // keyboard activation of a second palette button moves no pointer: the
    // ghost must re-render for the new def from the remembered tile
    const { renderer, wrapper } = armedHarness();
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'forester', col: 8, row: 4, valid: true });
    await wrapper.find('[data-test="palette-farm"]').trigger('click');
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'farm', col: 8, row: 4, valid: true });
  });

  it('previews an invalid ghost on an occupied tile and dispatches nothing there', async () => {
    const { renderer, wrapper, engine } = armedHarness({ col: 6, row: 3 }); // the bakery's tile
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'forester', col: 6, row: 3, valid: false });
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).not.toHaveBeenCalled();
  });

  it('suppresses hover tooltips while armed', async () => {
    const { renderer, wrapper } = armedHarness();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(false);
  });

  it('hides a parked tooltip the moment the palette arms — no pointer event needed', async () => {
    // keyboard activation fires no pointerleave: arming itself must clear hover
    const { renderer, wrapper } = armedHarness();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(true);
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(false);
  });

  it('Escape and right-click both disarm and clear the ghost', async () => {
    const { renderer, wrapper } = armedHarness();
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(wrapper.find('[data-test="palette-forester"]').classes()).not.toContain('is-armed');
    expect(renderer.setGhost).toHaveBeenLastCalledWith(null);

    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('contextmenu');
    expect(wrapper.find('[data-test="palette-forester"]').classes()).not.toContain('is-armed');
  });

  it('clicking a building selects it; the panel demolishes after confirm', async () => {
    const { renderer, wrapper, engine } = armedHarness();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(renderer.setSelection).toHaveBeenLastCalledWith(7);
    const demolish = wrapper.find('[data-test="selection-demolish"]');
    await demolish.trigger('click');
    await demolish.trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'demolishBuilding', buildingId: 7 });
  });

  it('selecting a different building resets an armed demolish — no cross-building confirm', async () => {
    // touch clients never blur the armed button, so the :key="selectedId"
    // remount is what guarantees building B gets a fresh, disarmed confirm
    const { renderer, wrapper, engine } = armedHarness();
    useGameStore().ingest(richSnapshot([
      makeBuilding(7, { defId: 'bakery', col: 6, row: 3 }),
      makeBuilding(9, { defId: 'farm', col: 9, row: 5 }),
    ]), { paused: false, speed: 1, error: null });
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 }); // select A
    await wrapper.find('[data-test="selection-demolish"]').trigger('click'); // arm A's confirm
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 9 });
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 60, pageY: 60 }); // select B
    await wrapper.find('[data-test="selection-demolish"]').trigger('click'); // must arm, not confirm
    expect(engine.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'demolishBuilding' }));
    await wrapper.find('[data-test="selection-demolish"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'demolishBuilding', buildingId: 9 });
  });

  it('move flow: Move arms with the building def, a valid click dispatches and keeps the selection', async () => {
    const { renderer, wrapper, engine } = armedHarness({ col: 9, row: 6 });
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 }); // select
    await wrapper.find('[data-test="selection-move"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'bakery', col: 9, row: 6, valid: true });
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'moveBuilding', buildingId: 7, to: { col: 9, row: 6 } });
    expect(renderer.setGhost).toHaveBeenLastCalledWith(null);
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(true);
  });

  it('selection clears reactively when its building vanishes', async () => {
    const { renderer, wrapper } = armedHarness();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(true);
    useGameStore().ingest(makeSnapshot({ buildings: [], stockpile: stockedWith({ wood: 100 }) }), { paused: false, speed: 1, error: null });
    await nextTick();
    expect(renderer.setSelection).toHaveBeenLastCalledWith(null);
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(false);
  });

  it('a timeline reset (tick regression) clears the selection even though the id survives', async () => {
    // colony reset recycles entity ids from 1 (Task 9 review): a selected id
    // can survive into an unrelated new-timeline building. The id-based
    // vanish check alone would see id 7 still present and keep a stale
    // selection ring on what is now a completely different building — only
    // the tick-regression check catches this.
    const { renderer, wrapper } = armedHarness();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(true);
    useGameStore().ingest(makeSnapshot({
      tick: 0, // same tick as the very first snapshot: a reset timeline, not a new tick
      buildings: [makeBuilding(7, { defId: 'farm', col: 4, row: 1 })], // id 7 recycled, unrelated building
      stockpile: stockedWith({ wood: 100 }),
    }), { paused: false, speed: 1, error: null });
    await nextTick();
    expect(renderer.setSelection).toHaveBeenLastCalledWith(null);
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(false);
  });

  it('clicking a worker is a no-op for selection — only empty ground deselects', async () => {
    const { renderer, wrapper } = armedHarness();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 }); // select
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(true);
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'colonist', id: 3 });
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 50, pageY: 50 });
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(true); // hover-only: still selected
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue(null);
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 60, pageY: 60 });
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(false); // empty ground clears
  });

  it('closing the panel disarms an armed move — no ghost, no dispatch afterwards', async () => {
    // the armed move belongs to the selection it came from: without the
    // cancel, an invisible move keeps previewing and clicking the canvas
    // still dispatches moveBuilding for the deselected building
    const { renderer, wrapper, engine } = armedHarness({ col: 9, row: 6 });
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 }); // select
    await wrapper.find('[data-test="selection-move"]').trigger('click'); // arm move
    await wrapper.find('[data-test="selection-close"]').trigger('click');
    expect(renderer.setGhost).toHaveBeenLastCalledWith(null);
    (engine.dispatch as ReturnType<typeof vi.fn>).mockClear();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'moveBuilding' }));
  });

  it('Escape is ignored while the view is deactivated — armed mode survives tab switches', async () => {
    // keep-alive hides the view without unmounting it; a live window listener
    // there would let Escape on another tab silently disarm the hidden World
    const { wrapper, active } = armedHarness();
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    active.value = false; // switch tabs: deactivated, not unmounted
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    active.value = true;
    await nextTick();
    expect(wrapper.find('[data-test="palette-forester"]').classes()).toContain('is-armed');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // re-attached on activation
    await nextTick();
    expect(wrapper.find('[data-test="palette-forester"]').classes()).not.toContain('is-armed');
  });
});
