// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import WorldScreen from '../../src/app/views/WorldScreen.vue';
import { WORLD_RENDERER_KEY, type WorldRenderer } from '../../src/app/world/renderer-key';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { useUiStore } from '../../src/app/stores/ui-store';
import { makeBuilding, makeSnapshot } from './fixtures';

function makeFake(): WorldRenderer {
  return {
    sync: vi.fn(), pick: vi.fn(() => null), tileAt: vi.fn(() => null),
    setGhost: vi.fn(), setSelection: vi.fn(), setHighlight: vi.fn(),
    onFatal: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn(),
  };
}

function mountScreen() {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  // Seeded BEFORE mount, deliberately. In production `App.vue` gates the
  // router view on `store.snapshot`, so nothing downstream ever renders
  // against null — but mounting WorldScreen directly skips that gate, and
  // several assertions read live figures. ResourceStrip guards on
  // store.snapshot in its own right, so this is convenience, not a crutch.
  useGameStore(pinia).ingest(
    makeSnapshot({ idleAdults: 1, buildings: [makeBuilding(1)] }),
    { paused: true, speed: 1, error: null },
  );
  return mount(WorldScreen, {
    attachTo: document.body, // window keydown listeners need a live document
    global: {
      plugins: [pinia],
      provide: {
        [WORLD_RENDERER_KEY as symbol]: vi.fn(() => makeFake()),
        [ENGINE_KEY as symbol]: { dispatch: vi.fn() },
      },
    },
  });
}

describe('WorldScreen', () => {
  it('renders the rail, the stage and the strip, with no dock by default', () => {
    const wrapper = mountScreen();
    expect(wrapper.find('[data-test="build-palette"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="world-host"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="resource-strip"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="dock"]').exists()).toBe(false);
  });

  it('opens the dock when a panel is chosen', async () => {
    const wrapper = mountScreen();
    useUiStore().openPanel('attention');
    await nextTick();
    expect(wrapper.find('[data-test="dock"]').exists()).toBe(true);
  });

  // The tab strip is the only route to Colony/Population/Economy/Attention
  // that does not require selecting a map subject first (WorldScreen.vue's
  // own comment on the `<nav>`), so it has to be reachable with the dock
  // closed — and it stays mounted, not merely rendered once, after the dock
  // closes again.
  it('offers every panel from a closed dock', async () => {
    const wrapper = mountScreen();
    const ui = useUiStore();
    expect(ui.panel).toBe(null);
    expect(wrapper.find('[data-test="dock"]').exists()).toBe(false);
    for (const panel of ['colony', 'population', 'economy', 'attention'] as const) {
      await wrapper.get(`[data-test="dock-tab-${panel}"]`).trigger('click');
      expect(ui.panel).toBe(panel);
    }
    await wrapper.get('[data-test="dock-close"]').trigger('click');
    expect(ui.panel).toBe(null);
    expect(wrapper.get('[data-test="dock-tab-attention"]').isVisible()).toBe(true);
    wrapper.unmount();
  });

  it('unwinds the Escape ladder mode-first', async () => {
    const wrapper = mountScreen();
    const ui = useUiStore();
    ui.selectBuilding(1);
    ui.armMove(1);
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.mode).toEqual({ kind: 'idle' });
    expect(ui.selection).toEqual({ kind: 'building', id: 1 });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.selection).toEqual({ kind: 'none' });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.panel).toBe(null);
    wrapper.unmount();
  });

  it('collapses the rail to a Build control in a narrow pane, and the popover still arms', async () => {
    const wrapper = mountScreen();
    const ui = useUiStore();
    expect(wrapper.find('[data-test="rail-toggle"]').exists()).toBe(false);
    ui.setNarrow(true);
    await nextTick();
    expect(wrapper.find('[data-test="build-palette"]').exists()).toBe(false);
    await wrapper.get('[data-test="rail-toggle"]').trigger('click');
    await wrapper.get('[data-test="palette-farm"]').trigger('click');
    expect(ui.mode).toEqual({ kind: 'place', defId: 'farm' });
    wrapper.unmount();
  });

  it('overlays the dock rather than shrinking the canvas in a narrow pane', async () => {
    const wrapper = mountScreen();
    const ui = useUiStore();
    ui.openPanel('attention');
    await nextTick();
    expect(wrapper.get('[data-test="dock"]').classes()).not.toContain('is-overlay');
    ui.setNarrow(true);
    await nextTick();
    // The other half of criterion 7. Without this, an implementation that
    // leaves the dock in a grid column and crushes the canvas passes every
    // other check, because Task 13's CSS is where that decision lives.
    expect(wrapper.get('[data-test="dock"]').classes()).toContain('is-overlay');
    wrapper.unmount();
  });

  it('stops listening for Escape while deactivated, and resumes on activate', async () => {
    const active = ref(true);
    const Harness = defineComponent({
      setup: () => () => h(KeepAlive, null, [active.value ? h(WorldScreen) : null]),
    });
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
    useGameStore(pinia).ingest(makeSnapshot({ idleAdults: 1 }), { paused: true, speed: 1, error: null });
    mount(Harness, {
      attachTo: document.body,
      global: {
        plugins: [pinia],
        provide: {
          [WORLD_RENDERER_KEY as symbol]: vi.fn(() => makeFake()),
          [ENGINE_KEY as symbol]: { dispatch: vi.fn() },
        },
      },
    });
    const ui = useUiStore();
    ui.selectBuilding(1);
    active.value = false;
    await nextTick();

    // The Ledger is showing. Escape belongs to it, not to the hidden world.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.selection).toEqual({ kind: 'building', id: 1 });

    active.value = true;
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.selection).toEqual({ kind: 'none' });
  });

  it('detaches its Escape listener on unmount', () => {
    const wrapper = mountScreen();
    const ui = useUiStore();
    ui.selectBuilding(1);
    wrapper.unmount();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(ui.selection).toEqual({ kind: 'building', id: 1 }); // untouched
  });

  // Deliberately NOT seeded, and safe because ResourceStrip guards on
  // store.snapshot. A component that throws against a null snapshot will throw
  // in some context nobody has thought of yet; seeding every mount hides that
  // rather than fixing it.
  it('shows the fallback message when the stage reports a fatal', async () => {
    const wrapper = mount(WorldScreen, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
        provide: {
          [WORLD_RENDERER_KEY as symbol]: vi.fn(() => { throw new Error('no webgl'); }),
          [ENGINE_KEY as symbol]: { dispatch: vi.fn() },
        },
      },
    });
    await nextTick();
    expect(wrapper.find('[data-test="world-fallback"]').exists()).toBe(true);
  });

  // Deletion-inventory A12: WorldLegend rendered inside the world view. This
  // case has no equivalent anywhere else — WorldStage does not render it (the
  // legend is not renderer-specific), so it is WorldScreen's own to carry.
  // Lifted intact from tests/app/world-view.test.ts's "renders the encoding
  // legend" — same swatch-pairing check, so a future entry cannot silently
  // put its label text inside the swatch element the way "output full" and
  // "carrying" once did.
  it('renders the encoding legend', async () => {
    const wrapper = mountScreen();
    await nextTick(); // WorldLegend resolves its theme in onMounted
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
    expect(legend.text()).toContain('carrying out');
    expect(legend.text()).toContain('carrying in');
    expect(legend.text()).toContain('transfer');
    expect(legend.text()).toContain('storing');
    expect(legend.text()).toContain('store fill');
    expect(legend.text()).toContain('housing');
    expect(legend.text()).toContain('child');
    expect(legend.text()).toContain('elder');
    expect(legend.text()).toContain('homeless');

    const entries = legend.findAll('span');
    expect(entries.length).toBe(22);
    let withSwatch = 0;
    for (const entry of entries) {
      const ownsChipClass = entry.classes().includes('obsisim-chip');
      const swatch = entry.find('.obsisim-chip');
      if (!ownsChipClass && !swatch.exists()) continue; // "idle camp": a literal glyph, no encoded color
      expect(ownsChipClass).toBe(false);
      expect(swatch.exists()).toBe(true);
      expect(swatch.text()).toBe('');
      withSwatch += 1;
    }
    expect(withSwatch).toBe(21);
  });
});
