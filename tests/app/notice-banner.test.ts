// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import NoticeBanner from '../../src/app/components/NoticeBanner.vue';
import { useGameStore } from '../../src/app/stores/game-store';

// Mirrors the store's recentNotices entry shape (game-store.ts), not
// Snapshot['notices']: this file tests the banner given a rendered-notice
// list, independent of how the store built it.
interface NoticeFixture {
  id: number;
  tick: number;
  kind: 'success' | 'rejection';
  message: string;
}

// Sets recentNotices directly rather than driving it through store.ingest():
// these tests pin the banner's rendering (classes, vnode keys) given a fixed
// list, not the store's own append/dedupe logic, which game-store.test.ts
// already covers on its own.
function mountBanner(notices: NoticeFixture[]) {
  const wrapper = mount(NoticeBanner, {
    global: { plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })] },
  });
  useGameStore().recentNotices = notices;
  return wrapper;
}

// VTU exposes no public key accessor, so read the render tree. This THROWS
// rather than returning [] when the shape changes, because a silent [] would
// make the uniqueness assertion below pass vacuously.
function noticeKeys(wrapper: VueWrapper): unknown[] {
  const rootChildren = (wrapper.vm.$.subTree as { children?: unknown }).children;
  const fragment = Array.isArray(rootChildren) ? rootChildren[0] : undefined;
  const rows = (fragment as { children?: unknown } | undefined)?.children;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('notice vnodes not found: Vue render-tree shape changed');
  }
  return (rows as { key?: unknown }[]).map((row) => row?.key);
}

describe('NoticeBanner', () => {
  // Both kinds share the base .obsisim-notice class; only the kind-suffixed
  // modifier ('is-success' / 'is-rejection') differs, which is what styles.css
  // keys its color rules off of.
  it('styles notices by kind', async () => {
    const wrapper = mountBanner([
      { id: 1, tick: 5, kind: 'success', message: 'Built a Sawmill.' },
      { id: 2, tick: 5, kind: 'rejection', message: 'Cannot afford Workshop.' },
    ]);
    await wrapper.vm.$nextTick();
    const rows = wrapper.findAll('.obsisim-notice');
    expect(rows[0].classes()).toContain('is-success');
    expect(rows[1].classes()).toContain('is-rejection');
  });

  // Reachable today with two identical rejections queued in the same tick,
  // not just a hypothetical: CommandSystem drains the whole queue per step,
  // so two clicks on a disabled-looking button before the next tick lands
  // both commands in one drain.
  it('keys notices by id, so identical messages in one tick stay distinct', async () => {
    const twice = 'Assigned a worker to Forester.'; // two assign clicks, one tick
    const wrapper = mountBanner([
      { id: 1, tick: 5, kind: 'success', message: twice },
      { id: 2, tick: 5, kind: 'success', message: twice },
    ]);
    await wrapper.vm.$nextTick();
    const keys = noticeKeys(wrapper);
    expect(keys).toEqual([1, 2]); // ids, not tick+kind+message
    expect(new Set(keys).size).toBe(keys.length);
  });
});
