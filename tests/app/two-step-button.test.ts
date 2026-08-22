// @vitest-environment happy-dom
//
// TwoStepButton is exercised end-to-end through BuildingTableRow's and
// InspectorFooter's own demolish tests (arm, then confirm, then the
// double-click and cross-subject-reset guards), but none of those callers
// ever blurs the button — so `@blur="armed = false"` is never invoked and
// Task 14's coverage run reported the component at 50% function coverage
// despite 100% statements: v8 counts the compiled inline handler as its own
// function entry, and a component can execute every STATEMENT in its
// `<script>` while never once calling that particular handler. A direct
// mount is the natural place to pin the behaviour its own comment
// describes — "Blur disarms so a wandering click can't confirm something
// armed long ago" — rather than threading a blur trigger through an
// unrelated Inspector or table test.
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TwoStepButton from '../../src/app/components/TwoStepButton.vue';

function mountButton() {
  return mount(TwoStepButton, {
    props: { label: 'Demolish', confirmLabel: 'Confirm demolish?', dataTest: 'demolish' },
  });
}

describe('TwoStepButton', () => {
  it('arms on the first click and confirms on the second', async () => {
    const wrapper = mountButton();
    const button = wrapper.get('[data-test="demolish"]');
    expect(button.text()).toBe('Demolish');
    await button.trigger('click');
    expect(button.text()).toBe('Confirm demolish?');
    await button.trigger('click');
    expect(wrapper.emitted('confirm')).toHaveLength(1);
    // A confirm disarms, same as the fresh state — the label reverts.
    expect(button.text()).toBe('Demolish');
  });

  it('disarms on blur without emitting, so a wandering click cannot confirm a stale arm', async () => {
    const wrapper = mountButton();
    const button = wrapper.get('[data-test="demolish"]');
    await button.trigger('click'); // arms
    expect(button.text()).toBe('Confirm demolish?');
    await button.trigger('blur');
    expect(button.text()).toBe('Demolish');
    // The next click only re-arms; it must not fall through to confirm.
    await button.trigger('click');
    expect(button.text()).toBe('Confirm demolish?');
    expect(wrapper.emitted('confirm')).toBeUndefined();
  });
});
