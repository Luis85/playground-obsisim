<script setup lang="ts">
import { ICONS, type IconName } from '../icons';

// `vue/multi-word-component-names` wants a registered name with more than
// one word — Vue's SFC compiler would otherwise infer one word ("Icon")
// straight from the filename. Named explicitly rather than renaming the
// file: `Icon.vue` is what this task's brief calls it, and every call site
// imports it as `Icon`, so the registered name is the one thing worth
// lengthening rather than the file both callers and this component's own
// tests already agree on.
defineOptions({ name: 'ObsisimIcon' });

/*
 * The chrome's icon sprite, rendered (spec §2.9's whole point): `fill=
 * "currentColor"` is why this replaces emoji rather than merely
 * decorating alongside them — an icon takes on whatever colour the text it
 * sits beside already has (including TopBar's vitals value-change flash),
 * with no second palette to keep in step with the world theme. See
 * icons.ts's own comment for why this is a hand-rolled sprite instead of
 * Obsidian's `setIcon`.
 *
 * `aria-hidden="true"`: every call site pairs this with adjacent text (a
 * count, a label) that already says what the icon repeats visually, so the
 * icon itself carries no information a screen reader needs read out twice.
 */
defineProps<{ name: IconName }>();
</script>

<template>
  <svg class="obsisim-icon" viewBox="0 0 24 24" aria-hidden="true"><path :d="ICONS[name]" fill="currentColor" /></svg>
</template>
