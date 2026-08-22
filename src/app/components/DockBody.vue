<script setup lang="ts">
import { useUiStore } from '../stores/ui-store';
import InspectorPanel from './dock/InspectorPanel.vue';
import ColonyPanel from './dock/ColonyPanel.vue';
import PopulationPanel from './dock/PopulationPanel.vue';
import EconomyPanel from './dock/EconomyPanel.vue';
import AttentionPanel from './dock/AttentionPanel.vue';

/*
 * The dock's body: zero or one panel, switched on `ui.panel` (spec §2.3),
 * split out of WorldScreen.vue's own template for the same reason DockTabs
 * did (see that component's comment) — a five-branch panel switch nested
 * inside WorldScreen's already-nested layout pushed that template's
 * cognitive complexity past fallow's gate. Splitting it out here is the
 * fix, not a workaround: this is a genuinely self-contained unit (it reads
 * `ui.panel` and dispatches `ui.closeDock`, and needs nothing from
 * WorldScreen except the Inspector's remount key, taken as a prop below).
 *
 * `inspectorKey` is a PROP, not recomputed here, deliberately: WorldScreen's
 * own comment on that computed explains why it exists as a single
 * expression at all — so the render site and `dock-panels.test.ts`'s
 * `mountKeyedInspector` helper cannot drift apart by each restating the
 * string differently. A second computed in this file, even one that started
 * out identical, would be exactly the second copy that comment exists to
 * prevent; passing the one WorldScreen already owns keeps it singular.
 */
defineProps<{ inspectorKey: string }>();
const ui = useUiStore();
</script>

<template>
  <!-- `is-overlay` is state, not a media query, so criterion 7's other half
       is assertable in jsdom: the CSS keys off this class rather than off a
       container query alone, and a test can prove the dock stops taking a
       grid column instead of only proving the rail collapsed. -->
  <aside v-if="ui.panel" class="obsisim-dock" :class="{ 'is-overlay': ui.narrow }" data-test="dock">
    <!-- Keyed by the subject, exactly as WorldView keyed SelectionPanel by
         `selectedId` — see the `inspectorKey` prop's own comment above for
         why a bare id is not enough once colonists are selectable too. -->
    <InspectorPanel v-if="ui.panel === 'inspector'" :key="inspectorKey" />
    <ColonyPanel v-else-if="ui.panel === 'colony'" />
    <PopulationPanel v-else-if="ui.panel === 'population'" />
    <EconomyPanel v-else-if="ui.panel === 'economy'" />
    <!-- `v-else-if`, not a bare `v-else`: `ui.panel` is a `DockPanel` and
         every member is handled above by name, so an `else-if` chain that
         falls through with nothing rendered is a stronger signal of an
         unreachable state than an `AttentionPanel` that would otherwise
         render for any value it does not recognise. -->
    <AttentionPanel v-else-if="ui.panel === 'attention'" />
    <button data-test="dock-close" aria-label="Close panel" @click="ui.closeDock()">✕</button>
  </aside>
</template>
