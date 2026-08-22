// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import Icon from '../../src/app/components/Icon.vue';
import { ICONS, type IconName } from '../../src/app/icons';

// The sprite itself: a name in ICONS has to be a real, drawable path (spec
// §2.9's icon sprite) — an empty or absent entry would compile (the type is
// just Record<IconName, string>) and render an empty <path>, silently.
describe('ICONS', () => {
  it.each(Object.keys(ICONS) as IconName[])('%s has a non-empty path', (name) => {
    expect(ICONS[name].length).toBeGreaterThan(0);
    // Path data starts with a moveto command — a sanity check that this is
    // actually SVG path syntax, not a stray placeholder string.
    expect(ICONS[name].trim()[0].toUpperCase()).toBe('M');
  });
});

describe('Icon', () => {
  it('renders the named path with fill="currentColor" so it takes the surrounding text colour', () => {
    const wrapper = mount(Icon, { props: { name: 'warning' } });
    const path = wrapper.get('path');
    expect(path.attributes('d')).toBe(ICONS.warning);
    expect(path.attributes('fill')).toBe('currentColor');
  });

  it('is hidden from assistive tech, since every call site pairs it with text saying the same thing', () => {
    const wrapper = mount(Icon, { props: { name: 'population' } });
    expect(wrapper.attributes('aria-hidden')).toBe('true');
  });
});
