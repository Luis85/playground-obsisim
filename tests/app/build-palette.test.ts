// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import BuildPalette from '../../src/app/components/BuildPalette.vue';
import { useGameStore } from '../../src/app/stores/game-store';
import type { BuildingDefId, ResourceId } from '../../src/shared/content-types';
import { makeSnapshot, stockedWith } from './fixtures';

function mountPalette(
  armedDefId: BuildingDefId | null = null,
  stocks: Partial<Record<ResourceId, number>> = { wood: 100 },
) {
  const wrapper = mount(BuildPalette, {
    props: { armedDefId },
    global: { plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })] },
  });
  useGameStore().ingest(
    makeSnapshot({ stockpile: stockedWith(stocks) }),
    { paused: true, speed: 1, error: null },
  );
  return wrapper;
}

const disabled = (wrapper: ReturnType<typeof mountPalette>, defId: BuildingDefId) =>
  (wrapper.get(`[data-test="palette-${defId}"]`).element as HTMLButtonElement).disabled;

describe('BuildPalette', () => {
  it('lists every def and emits arm with the clicked id', async () => {
    const wrapper = mountPalette();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    expect(wrapper.emitted('arm')).toEqual([['forester']]);
  });

  it('emits disarm when the armed def is clicked again, and marks it armed', async () => {
    const wrapper = mountPalette('forester');
    await wrapper.vm.$nextTick();
    const button = wrapper.find('[data-test="palette-forester"]');
    expect(button.classes()).toContain('is-armed');
    await button.trigger('click');
    expect(wrapper.emitted('disarm')).toHaveLength(1);
    expect(wrapper.emitted('arm')).toBeUndefined();
  });

  // Spec §2.1, increment 10: ordering is a request, not a claim, so the
  // palette no longer refuses to arm an unaffordable def — REQUIRED
  // separately from the engine-level pin (command-system.test.ts), because
  // that test passes regardless of whether any of the three view gates were
  // ever removed, and on its own would let a version ship where the model
  // allows a queue the player has no way to express through this surface.
  // `mountPalette`'s `stocks` argument is inert for BuildPalette itself now —
  // the component no longer reads the store at all — but the fixture stays a
  // genuinely EMPTY ledger (not merely a wood shortfall) so that a gate
  // restored here would have something (or, being empty, nothing) to read
  // and redden this test rather than passing regardless.
  it('the palette arms on an empty ledger', async () => {
    const wrapper = mountPalette(null, {});
    await wrapper.vm.$nextTick();
    expect(disabled(wrapper, 'forester')).toBe(false);
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    expect(wrapper.emitted('arm')).toEqual([['forester']]);
  });
});
