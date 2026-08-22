<script setup lang="ts">
import { useUiStore } from '../stores/ui-store';
import { DOCK_LABELS, DOCK_PANELS } from '../labels';

// The dock's tab strip, split out of WorldScreen.vue's own template rather
// than left inline: it is genuinely self-contained (reads `ui.panel` and
// `DOCK_PANELS`/`DOCK_LABELS`, calls `ui.openPanel`, nothing else), and
// folding it back into WorldScreen's `<template>` — a `v-for` over five
// buttons with a ternary class and a click, nested beside the dock's own
// five-branch panel switch — is what pushed that template's cognitive
// complexity past fallow's gate. This split is the fix, not a workaround:
// the strip is exactly as reusable a unit as any other component in
// `components/`, it just has not needed its own file before this task grew
// it from a placeholder label to five real buttons.
const ui = useUiStore();
</script>

<template>
  <!-- OUTSIDE the dock's own `v-if` in WorldScreen.vue, and always mounted:
       these buttons are what replaced the old nav strip, so they cannot
       live inside the panel body they open. With no panel yet chosen there
       would be nothing to click, and the only route to Colony, Population,
       Economy or Attention would be selecting a map subject first to force
       the Inspector open.

       Inspector itself is handled separately from DOCK_PANELS' four (see
       that constant's own comment): it has no unconditional button, because
       one clicked with no selection behind it would show an empty panel with
       nothing to point at — but it DOES get a tab the moment a selection
       exists, gated on `ui.selection.kind !== 'none'` right here rather than
       folded into DOCK_PANELS' fixed array. Without this, spec §2.3's "the
       bakery is selected with the Inspector one click away" was only true
       from the canvas, which auto-opens it — an Attention row that used
       `selectKeepingPanel` on purpose (to stay on Attention, see that
       method's own comment) left a player with a selection and no dock
       route back to it at all short of clicking the ringed building on the
       canvas itself (I3, whole-branch review). -->
  <nav class="obsisim-dock-tabs">
    <button
      v-if="ui.selection.kind !== 'none'" data-test="dock-tab-inspector"
      :class="{ 'is-active': ui.panel === 'inspector' }" @click="ui.openPanel('inspector')"
    >
      {{ DOCK_LABELS.inspector }}
    </button>
    <button
      v-for="p in DOCK_PANELS" :key="p" :data-test="`dock-tab-${p}`"
      :class="{ 'is-active': ui.panel === p }" @click="ui.openPanel(p)"
    >
      {{ DOCK_LABELS[p] }}
    </button>
  </nav>
</template>
