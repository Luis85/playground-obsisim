// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import WorldStage from '../../src/app/views/WorldStage.vue';
import { WORLD_RENDERER_KEY, type WorldRenderer } from '../../src/app/world/renderer-key';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { useUiStore } from '../../src/app/stores/ui-store';
import { makeBuilding, makeSnapshot, makeWorker } from './fixtures';

// Everything here runs against a fake WorldRenderer injected through
// WORLD_RENDERER_KEY — the real Excalibur factory must never be imported by
// tests (spec §2.5): excalibur touches `window` at module scope and takes
// seconds to evaluate under happy-dom.

function makeFake() {
  const renderer: WorldRenderer = {
    sync: vi.fn(), pick: vi.fn(() => null), tileAt: vi.fn(() => null),
    setGhost: vi.fn(), setSelection: vi.fn(), setHighlight: vi.fn(),
    onFatal: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn(),
  };
  return { renderer, factory: vi.fn(() => renderer) };
}

function mountStage(factory: unknown) {
  const engine = { dispatch: vi.fn() };
  const wrapper = mount(WorldStage, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [WORLD_RENDERER_KEY as symbol]: factory, [ENGINE_KEY as symbol]: engine },
    },
  });
  return { wrapper, engine };
}

describe('WorldStage', () => {
  // Task 13's fragment-root fix. Before it, this component's template had
  // TWO sibling root elements (the host div, the tooltip div), and a
  // multi-root component gets no automatic target for a fallthrough
  // attribute at all — `WorldScreen.vue`'s `class="obsisim-stage"` landed
  // nowhere, silently in production (the grid placement and the
  // `position: relative` .obsisim-stage's own CSS comment describes both
  // never applied) and as a logged dev-mode warning under
  // `@vue/test-utils`. Both halves need a test: the class actually reaching
  // a real DOM node, and the warning not firing.
  it('forwards class="obsisim-stage" onto a single root, with no fallthrough warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { factory } = makeFake();
    const wrapper = mount(WorldStage, {
      attrs: { class: 'obsisim-stage' },
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
        provide: { [WORLD_RENDERER_KEY as symbol]: factory, [ENGINE_KEY as symbol]: { dispatch: vi.fn() } },
      },
    });
    expect(wrapper.classes()).toContain('obsisim-stage');
    const fallthroughWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('Extraneous non-props'));
    expect(fallthroughWarnings).toEqual([]);
    warn.mockRestore();
  });

  it('creates the renderer on its host and syncs snapshots', async () => {
    const { renderer, factory } = makeFake();
    mountStage(factory);
    expect(factory).toHaveBeenCalledOnce();
    const snapshot = makeSnapshot({ tick: 5 });
    useGameStore().ingest(snapshot, { paused: false, speed: 1, error: null });
    await nextTick();
    expect(renderer.sync).toHaveBeenCalledWith(snapshot);
  });

  // Deletion-inventory A2: the brief's own test list never ingests BEFORE
  // mount, so a watcher missing `{ immediate: true }` passes every other
  // case here while still failing a real player who opens the world view
  // with the game already running. Seeded before mount, on purpose.
  it('syncs an already-present snapshot immediately on mount', () => {
    const { renderer, factory } = makeFake();
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
    useGameStore(pinia).ingest(makeSnapshot({ tick: 9 }), { paused: true, speed: 1, error: null });
    mount(WorldStage, {
      global: {
        plugins: [pinia],
        provide: { [WORLD_RENDERER_KEY as symbol]: factory, [ENGINE_KEY as symbol]: { dispatch: vi.fn() } },
      },
    });
    expect(renderer.sync).toHaveBeenCalledWith(expect.objectContaining({ tick: 9 }));
  });

  it('forwards the store selection to the renderer', async () => {
    const { renderer, factory } = makeFake();
    mountStage(factory);
    useUiStore().selectColonist(4);
    await nextTick();
    expect(renderer.setSelection).toHaveBeenCalledWith({ kind: 'colonist', id: 4 });
  });

  it('forwards a highlight set to the renderer', async () => {
    const { renderer, factory } = makeFake();
    mountStage(factory);
    // Errata: the brief's own draft called `setHighlight([2, 3])`, but
    // `setHighlight` takes `Selection[]`, not bare ids — TypeScript catches
    // this, so it is fixed here rather than worked around.
    useUiStore().setHighlight([{ kind: 'building', id: 2 }, { kind: 'building', id: 3 }]);
    await nextTick();
    expect(renderer.setHighlight).toHaveBeenCalledWith([{ kind: 'building', id: 2 }, { kind: 'building', id: 3 }]);
  });

  it('emits fatal when the factory throws, and renders no host', async () => {
    const factory = vi.fn(() => { throw new Error('no webgl'); });
    const { wrapper } = mountStage(factory);
    expect(wrapper.emitted('fatal')![0]).toEqual(['no webgl']);
    // `failure` is set synchronously inside onMounted's catch, but the host
    // div was already in the DOM from the initial render (v-if read `failure`
    // as null before onMounted ran) — the removal is one nextTick away.
    await nextTick();
    expect(wrapper.find('[data-test="world-host"]').exists()).toBe(false);
    // Deletion-inventory item 4's second half: the factory throwing before
    // `renderer = created` means the snapshot watcher (registered further
    // down the same try block) never gets set up at all. A later ingest
    // must not throw — there is nothing left listening to crash on.
    expect(() => useGameStore().ingest(makeSnapshot(), { paused: false, speed: 1, error: null })).not.toThrow();
  });

  // Deletion-inventory A5: a missing provider is a different path from a
  // throwing one — `inject(WORLD_RENDERER_KEY, null)` resolves to null with
  // no factory call at all, rather than a factory call that throws. Neither
  // the brief's test list nor its component sketch names this branch.
  it('emits fatal and renders no host when no factory is provided', async () => {
    const { wrapper } = mountStage(undefined);
    expect(wrapper.emitted('fatal')![0]).toEqual(['no renderer is registered']);
    await nextTick();
    expect(wrapper.find('[data-test="world-host"]').exists()).toBe(false);
  });

  it('emits fatal when the renderer reports one after a successful boot', () => {
    const { renderer, factory } = makeFake();
    const { wrapper } = mountStage(factory);
    const report = (renderer.onFatal as ReturnType<typeof vi.fn>).mock.calls[0][0] as (m: string) => void;
    report('context lost');
    expect(wrapper.emitted('fatal')![0]).toEqual(['context lost']);
  });

  it('dispatches the construct command a placing click produces', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper, engine } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [] }), { paused: true, speed: 1, error: null });
    // Errata: the brief's own fixture used { col: 2, row: 2 }, which is
    // permanently unbuildable — `CAMP_COLS = 3` in shared/placement.ts makes
    // every tile with col < 3 fail `isTileBuildable` regardless of occupancy
    // (the same fixture bug Task 4's report already found and fixed). { col:
    // 8, row: 2 } is outside the camp band and otherwise unoccupied.
    (renderer.tileAt as ReturnType<typeof vi.fn>).mockReturnValue({ col: 8, row: 2 });
    useUiStore().armPlace('farm');
    await wrapper.get('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'constructBuilding', buildingDefId: 'farm', at: { col: 8, row: 2 } });
  });

  it('dispatches the move command a moving click produces', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper, engine } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [makeBuilding(1, { col: 5, row: 5 })] }), { paused: true, speed: 1, error: null });
    (renderer.tileAt as ReturnType<typeof vi.fn>).mockReturnValue({ col: 8, row: 8 });
    const ui = useUiStore();
    ui.selectBuilding(1);
    ui.armMove(1);
    await wrapper.get('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'moveBuilding', buildingId: 1, to: { col: 8, row: 8 } });
  });

  // Guards `if (command !== null) engine.dispatch(command)` from the top:
  // inverting that condition, or dropping the `!== null` check so a `null`
  // command reaches `engine.dispatch`, would still leave both dispatch tests
  // above green (they only ever see a non-null command). Clicking an occupied
  // tile is the real path a player hits that makes `clickTile` return null —
  // an off-map tile would too, but only this one exercises the same
  // isTileBuildable branch a player's misclick actually takes.
  it('does not dispatch when clicking an occupied tile produces no command', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper, engine } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [makeBuilding(1, { col: 8, row: 4 })] }), { paused: true, speed: 1, error: null });
    (renderer.tileAt as ReturnType<typeof vi.fn>).mockReturnValue({ col: 8, row: 4 });
    useUiStore().armPlace('farm');
    await wrapper.get('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).not.toHaveBeenCalled();
  });

  it('forwards the computed ghost to the renderer', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [] }), { paused: true, speed: 1, error: null });
    // Same camp-band fixture bug as above: col 2 is unbuildable regardless
    // of occupancy, which would make this ghost preview invalid for the
    // wrong reason.
    (renderer.tileAt as ReturnType<typeof vi.fn>).mockReturnValue({ col: 8, row: 2 });
    useUiStore().armPlace('farm');
    await nextTick();
    // A pointer move is what supplies the tile; the ghost follows from it.
    await wrapper.get('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenCalledWith({ defId: 'farm', col: 8, row: 2, valid: true });
  });

  it('drops a colonist selection when that colonist dies, not when a building vanishes', async () => {
    const { factory } = makeFake();
    mountStage(factory);
    const store = useGameStore();
    const ui = useUiStore();
    store.ingest(makeSnapshot({ tick: 1, colonists: [makeWorker(3)], buildings: [] }), { paused: true, speed: 1, error: null });
    ui.selectColonist(3);
    await nextTick();
    // Still alive, and no building shares the id — a buildings-only check would
    // have cleared this.
    store.ingest(makeSnapshot({ tick: 2, colonists: [makeWorker(3)], buildings: [] }), { paused: true, speed: 1, error: null });
    await nextTick();
    expect(ui.selection).toEqual({ kind: 'colonist', id: 3 });

    store.ingest(makeSnapshot({ tick: 3, colonists: [], buildings: [makeBuilding(3)] }), { paused: true, speed: 1, error: null });
    await nextTick();
    expect(ui.selection).toEqual({ kind: 'none' }); // dead, despite a building with id 3
  });

  it('stops the render clock on deactivate and restarts it on activate', async () => {
    const { renderer, factory } = makeFake();
    const active = ref(true);
    const Harness = defineComponent({
      setup: () => () => h(KeepAlive, null, [active.value ? h(WorldStage) : null]),
    });
    mount(Harness, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
        provide: { [WORLD_RENDERER_KEY as symbol]: factory, [ENGINE_KEY as symbol]: { dispatch: vi.fn() } },
      },
    });
    active.value = false;
    await nextTick();
    expect(renderer.stop).toHaveBeenCalled();
    active.value = true;
    await nextTick();
    expect(renderer.start).toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce(); // never rebuilt
  });

  // Deactivation stops the clock; only a real unmount releases the WebGL
  // context. Nothing else asserts this — Task 12's router test deliberately
  // asserts dispose was NOT called — so without this case an implementation
  // that omits onBeforeUnmount cleanup passes every prescribed test and leaks
  // an Excalibur engine on every close and reopen of the Obsidian view.
  it('disposes the renderer on final unmount, not on deactivate', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper } = mountStage(factory);
    expect(renderer.dispose).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });

  it('selects the picked building on an idle canvas click', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 1 });
    const { wrapper } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [makeBuilding(1)] }), { paused: true, speed: 1, error: null });
    await wrapper.get('[data-test="world-host"]').trigger('click', { pageX: 101, pageY: 100 });
    expect(useUiStore().selection).toEqual({ kind: 'building', id: 1 });
  });

  // Deletion-inventory item 26 (deliberately changed by spec §2.3): a
  // colonist click now selects, at the component boundary — not just inside
  // useWorldInteraction's own tests (Task 4). onClick's idle branch must
  // actually route a colonist pick to `ui.selectColonist`, not merely to
  // `interaction.clickPick` in the abstract.
  it('selects the picked colonist on an idle canvas click', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'colonist', id: 9 });
    const { wrapper } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ colonists: [makeWorker(9)] }), { paused: true, speed: 1, error: null });
    await wrapper.get('[data-test="world-host"]').trigger('click', { pageX: 20, pageY: 20 });
    expect(useUiStore().selection).toEqual({ kind: 'colonist', id: 9 });
  });

  // Deletion-inventory item 20's other half: right-click disarms AND clears
  // the ghost. Escape's half of this case belongs to WorldScreen (Task 6),
  // which owns the window listener — but the right-click handler
  // (onContextMenu) is this component's own, so its ghost-clearing effect is
  // this task's to prove: cancelMode() clears the mode, which (via Task 4's
  // flush:'sync' watcher) clears the remembered hover tile, which this
  // component's own ghost-forwarding watcher turns into `setGhost(null)`.
  it('a right-click while armed cancels the mode and clears the ghost', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [] }), { paused: true, speed: 1, error: null });
    (renderer.tileAt as ReturnType<typeof vi.fn>).mockReturnValue({ col: 8, row: 2 });
    const ui = useUiStore();
    ui.armPlace('farm');
    await wrapper.get('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'farm', col: 8, row: 2, valid: true });
    await wrapper.get('[data-test="world-host"]').trigger('contextmenu');
    expect(ui.mode).toEqual({ kind: 'idle' });
    expect(renderer.setGhost).toHaveBeenLastCalledWith(null);
  });

  // Deletion-inventory item 24, the building-selection mirror of the
  // colonist-death test above: a BUILDING selection must clear when its
  // building leaves the snapshot on an ADVANCING tick (no timeline reset
  // involved) — pruneSelection's `kind === 'building'` branch, exercised on
  // its own rather than only alongside the colonist branch.
  //
  // Also arms a move on that same building first, and asserts `ui.mode`
  // returns to idle (spec criterion 6's fourth route: an armed move must die
  // when the building it targets is demolished out from under it). Every
  // other pruneSelection test up to this point only ever asserted
  // `ui.selection`, so this route had no assertion anywhere in the suite —
  // `ui.clearSelection()` two lines above `cancelMode()` in `pruneSelection`
  // already cancels an armed move as a side effect of `commitSelection`, so
  // this is what actually proves the fourth route dies rather than merely
  // asserting on a line that happens to be redundant with it.
  it('drops a building selection when that building vanishes on an advancing tick, and cancels an armed move on it', async () => {
    const { factory } = makeFake();
    mountStage(factory);
    const store = useGameStore();
    const ui = useUiStore();
    store.ingest(makeSnapshot({ tick: 1, buildings: [makeBuilding(5)] }), { paused: true, speed: 1, error: null });
    ui.selectBuilding(5);
    ui.armMove(5);
    await nextTick();
    expect(ui.mode).toEqual({ kind: 'move', buildingId: 5 });
    store.ingest(makeSnapshot({ tick: 2, buildings: [] }), { paused: true, speed: 1, error: null });
    await nextTick();
    expect(ui.selection).toEqual({ kind: 'none' });
    expect(ui.mode).toEqual({ kind: 'idle' });
  });

  // Deletion-inventory A19, the plan's known gap: keyboard arming (a focused
  // palette button, or the Inspector's Move control) fires no pointer event,
  // so nothing else clears a tooltip parked over the canvas from an earlier
  // hover. Without the mode-kind watcher this stays visible, fighting the
  // ghost, until the next real pointermove.
  it('hides a parked tooltip the moment the palette arms — no pointer event needed', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    const { wrapper } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [makeBuilding(7)] }), { paused: true, speed: 1, error: null });
    await wrapper.get('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(true);
    useUiStore().armPlace('farm');
    await nextTick();
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(false);
  });

  it('shows a tooltip for the picked building and hides it on leave', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    const { wrapper } = mountStage(factory);
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
    const { wrapper } = mountStage(factory);
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
    const { wrapper } = mountStage(factory);
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
    const { wrapper } = mountStage(factory);
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
      const { wrapper } = mountStage(factory);
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

  it('suppresses hover tooltips while armed', async () => {
    const { renderer, factory } = makeFake();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    const { wrapper } = mountStage(factory);
    useGameStore().ingest(makeSnapshot({ buildings: [makeBuilding(7)] }), { paused: true, speed: 1, error: null });
    useUiStore().armPlace('farm');
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(false);
  });

  it('a timeline reset (tick regression) clears the selection even though the id survives', async () => {
    // Colony reset recycles entity ids from 1: a selected id can survive
    // into an unrelated new-timeline building. The id-based vanish check
    // alone would see id 7 still present and keep a stale selection on a
    // completely different building — only the tick-regression check catches
    // this.
    const { factory } = makeFake();
    mountStage(factory);
    const store = useGameStore();
    const ui = useUiStore();
    store.ingest(makeSnapshot({ tick: 5, buildings: [makeBuilding(7)] }), { paused: true, speed: 1, error: null });
    ui.selectBuilding(7);
    await nextTick();
    store.ingest(makeSnapshot({
      tick: 0, // same tick as the very first snapshot: a reset timeline
      buildings: [makeBuilding(7, { defId: 'farm' })], // id 7 recycled, unrelated building
    }), { paused: true, speed: 1, error: null });
    await nextTick();
    expect(ui.selection).toEqual({ kind: 'none' });
  });

  it('a timeline reset (tick regression) clears a standing highlight', async () => {
    // clearSelection() deliberately leaves ui.highlight untouched — that is
    // what lets the plural-row flow do clearSelection() then
    // setHighlight(...) without losing the highlight it just set. Nothing
    // else drops it, so the reset path has to clear it explicitly or a
    // highlight naming old-timeline ids (buildings 2 and 3) keeps pulsing
    // whatever recycled those ids in the new colony.
    const { factory } = makeFake();
    mountStage(factory);
    const store = useGameStore();
    const ui = useUiStore();
    store.ingest(makeSnapshot({ tick: 5, buildings: [makeBuilding(2), makeBuilding(3)] }), {
      paused: true, speed: 1, error: null,
    });
    ui.setHighlight([{ kind: 'building', id: 2 }, { kind: 'building', id: 3 }]);
    await nextTick();
    store.ingest(makeSnapshot({
      tick: 0, // same tick as the very first snapshot: a reset timeline
      buildings: [makeBuilding(2, { defId: 'farm' }), makeBuilding(3, { defId: 'farm' })],
    }), { paused: true, speed: 1, error: null });
    await nextTick();
    expect(ui.highlight).toEqual([]);
  });
});
