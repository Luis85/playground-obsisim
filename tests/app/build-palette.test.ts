// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import BuildPalette from '../../src/app/components/BuildPalette.vue';
import { useGameStore } from '../../src/app/stores/game-store';
import type { BuildingDefId } from '../../src/shared/content-types';
import { makeSnapshot, stockedWith } from './fixtures';

function mountPalette(armedDefId: BuildingDefId | null = null, wood = 100) {
  const wrapper = mount(BuildPalette, {
    props: { armedDefId },
    global: { plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })] },
  });
  useGameStore().ingest(
    makeSnapshot({ stockpile: stockedWith({ wood }) }),
    { paused: true, speed: 1, error: null },
  );
  return wrapper;
}

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
    const wrapper = mountPalette(null, 0);
    await wrapper.vm.$nextTick();
    expect((wrapper.find('[data-test="palette-forester"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the armed def enabled even when it became unaffordable', async () => {
    // disarming must stay possible after the stockpile drains mid-arm
    const wrapper = mountPalette('forester', 0);
    await wrapper.vm.$nextTick();
    expect((wrapper.find('[data-test="palette-forester"]').element as HTMLButtonElement).disabled).toBe(false);
  });
});
