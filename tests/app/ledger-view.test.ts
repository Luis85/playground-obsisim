// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import LedgerView from '../../src/app/views/LedgerView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { useUiStore } from '../../src/app/stores/ui-store';
import { makeBuilding, makeFake, makeSnapshot, mountApp } from './fixtures';

describe('LedgerView', () => {
  it('carries a control for every engine verb, move included', async () => {
    const engine = { dispatch: vi.fn() };
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
    useGameStore(pinia).ingest(
      makeSnapshot({ idleAdults: 1, buildings: [makeBuilding(1)] }),
      { paused: true, speed: 1, error: null },
    );
    const wrapper = mount(LedgerView, { global: { plugins: [pinia], provide: { [ENGINE_KEY as symbol]: engine } } });
    for (const test of ['construct-farm', 'assign-1', 'unassign-1', 'demolish-1', 'move-1', 'assign-hauler', 'unassign-hauler', 'recruit']) {
      expect(wrapper.find(`[data-test="${test}"]`).exists()).toBe(true);
    }
  });

  // Criterion 5: the renderer factory is called exactly once across a tour
  // that visits every dock panel AND makes the real `/` -> `/ledger` -> `/`
  // round trip. The round trip is the part a panel-only tour cannot catch —
  // deleting the `<keep-alive>` (or letting its `include` drift out of sync
  // with `WorldScreen`'s own `defineOptions({ name })`, see App.vue's own
  // comment) still passes a tour that never actually navigates away from `/`.
  // `dispose` must stay uncalled (the renderer is kept, not torn down) while
  // `stop`/`start` bracket the trip (deactivated on the way out, reactivated
  // on the way back) — those three together are what tell "kept alive
  // correctly" apart from "never left in the first place".
  it('builds the renderer exactly once across the panels AND the ledger round trip', async () => {
    const { renderer, factory } = makeFake();
    const { wrapper, router } = await mountApp(factory);
    const ui = useUiStore();
    for (const panel of ['colony', 'population', 'economy', 'attention', 'inspector'] as const) {
      ui.openPanel(panel);
      await nextTick();
    }
    await router.push('/ledger');
    await router.push('/');
    await flushPromises();
    expect(factory).toHaveBeenCalledOnce();
    expect(renderer.dispose).not.toHaveBeenCalled();
    expect(renderer.stop).toHaveBeenCalled(); // deactivated on the way out
    expect(renderer.start).toHaveBeenCalled(); // reactivated on the way back
    wrapper.unmount();
  });
});
