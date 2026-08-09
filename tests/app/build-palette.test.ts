// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import BuildPalette from '../../src/app/components/BuildPalette.vue';
import { useGameStore } from '../../src/app/stores/game-store';
import { BUILDINGS } from '../../src/engine/content/buildings';
import type { BuildingDefId, ResourceId } from '../../src/shared/content-types';
import { makeSnapshot, stockedWith } from './fixtures';

// Takes a whole stock map, not just wood: the house is the first def to cost
// two resources, so a wood-only fixture cannot express "rich in one, short of
// the other" — the case its gating actually turns on.
function mountPalette(armedDefId: BuildingDefId | null = null, stocks: Partial<Record<ResourceId, number>> = { wood: 100 }) {
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

  it('disables unaffordable defs (but never the armed one)', async () => {
    const wrapper = mountPalette(null, { wood: 0 });
    await wrapper.vm.$nextTick();
    expect(disabled(wrapper, 'forester')).toBe(true);
  });

  it('keeps the armed def enabled even when it became unaffordable', async () => {
    // disarming must stay possible after the stockpile drains mid-arm
    const wrapper = mountPalette('forester', { wood: 0 });
    await wrapper.vm.$nextTick();
    expect(disabled(wrapper, 'forester')).toBe(false);
  });

  // The house is increment 6's new def and the first to cost TWO resources, so
  // it is also the first whose gating can look right while checking only one
  // of them. Each resource in the cost is dropped a unit short in turn, read
  // off BUILDINGS rather than retyped, so a retune moves the test with it.
  it('lists the house and gates it on every resource in its cost, not just the first', async () => {
    const cost = Object.entries(BUILDINGS.house.cost) as [ResourceId, number][];
    expect(cost.length).toBeGreaterThan(1); // the property this test exists for
    const exact = Object.fromEntries(cost) as Partial<Record<ResourceId, number>>;

    const affordable = mountPalette(null, exact);
    await affordable.vm.$nextTick();
    expect(affordable.get('[data-test="palette-house"]').text()).toContain(BUILDINGS.house.name);
    expect(disabled(affordable, 'house')).toBe(false); // exactly the cost is enough

    for (const [id, amount] of cost) {
      const short = mountPalette(null, { ...exact, [id]: amount - 1 });
      await short.vm.$nextTick();
      expect(disabled(short, 'house'), `one ${id} short must still disable the house`).toBe(true);
    }
  });
});
