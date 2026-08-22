<script setup lang="ts">
import { inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { NO_HAULERS_REASON, NO_IDLE_ADULTS_REASON } from '../labels';

/*
 * The hauler count and its two verbs (assignHauler, unassignHauler) — spec
 * §2.2's rule ("a control the engine would refuse is disabled with its
 * reason stated in the panel, not hidden in a `title`") applied to both
 * directions, on the one markup both surfaces render.
 *
 * ResourceStrip and DashboardView used to each carry their own copy of this
 * block. That was deliberate at first — ResourceStrip's own comment argued
 * for "a distinct, shorter markup rather than a reworded copy" so the two
 * views could agree on what a hauler count MEANS without fallow's clone
 * detector reading one control duplicated twice — but bringing DashboardView
 * up to the same §2.2 standard (stating both refusals in the panel, Task
 * 12's sweep) made the two blocks structurally identical rather than merely
 * similar: same two buttons, same two gated reasons, same data-test names.
 * At that point "distinct markup" was no longer available as the fix, and
 * the ONE remaining option that does not regress `cloneGroups` is the same
 * one `ResourceTable.vue`/`PopulationRoster.vue`/`ChainTable.vue` already
 * took for an identical situation: one component, mounted from both places,
 * reading `useGameStore()` and `ENGINE_KEY` itself rather than taking props
 * — both callers already hold that store and that engine for everything
 * around this block, so a prop here would just be a second name for what
 * each already has.
 */
const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
</script>

<template>
  <span v-if="store.snapshot" class="obsisim-haulers" data-test="hauler-count-wrap">
    <strong data-test="hauler-count">{{ store.haulerCount }}</strong> hauling
    <button
      data-test="unassign-hauler" :disabled="store.haulerCount === 0"
      @click="engine.dispatch({ type: 'unassignHauler' })"
    >−</button>
    <button
      data-test="assign-hauler" :disabled="store.snapshot.idleAdults === 0"
      @click="engine.dispatch({ type: 'assignHauler' })"
    >+</button>
    <small v-if="store.snapshot.idleAdults === 0" class="obsisim-reason" data-test="hauler-reason">
      {{ NO_IDLE_ADULTS_REASON }}
    </small>
    <small v-if="store.haulerCount === 0" class="obsisim-reason" data-test="unassign-hauler-reason">
      {{ NO_HAULERS_REASON }}
    </small>
  </span>
</template>
