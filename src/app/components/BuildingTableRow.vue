<script setup lang="ts">
import { inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { BUILDINGS } from '../../engine/content';
import { isTileBuildable } from '../../shared/placement';
import type { WorldMapSize } from '../../shared/placement';
import type { BuildingSnapshot } from '../../shared/snapshot';
import {
  batchLabel, BUILDING_STATE_LABELS, downtimeLabel, MOVE_SITE_REASON, suppliedLabel, TILE_UNAVAILABLE_REASON,
  waitingLabel, WHOLE_TILES_ONLY_REASON,
} from '../labels';
import { staffingRefusal, unassignRefusal } from '../staffing';
import TwoStepButton from './TwoStepButton.vue';

/*
 * One row of the Buildings table, split out of BuildingsView.vue's own
 * template for the same reason InspectorProducer/House/Storehouse were split
 * out of InspectorPanel.vue (see that component's own comment): the parent's
 * table shell plus every field this row carries — waiting, needs, downtime,
 * the countdown, staffing with its two stated reasons, state, batch, work
 * power, tools, the Move inputs with their own stated reason, and Demolish —
 * was enough branching in one `<template>` to trip fallow's cognitive-
 * complexity gate (`scripts/check-quality.mjs`'s `complexFunctions`
 * counter). A row is the natural seam: it already corresponds to exactly one
 * `BuildingSnapshot`, the same way each Inspector detail region corresponds
 * to exactly one building kind.
 *
 * Props rather than reading the store directly (unlike, say, ResourceTable):
 * `moveRefusal` below needs the FULL building list and the map to run
 * `isTileBuildable`, not just this row's own building, and taking that as a
 * prop — rather than injecting the store and reading `store.snapshot!` a
 * second time — keeps this component testable in isolation the way
 * InspectorProducer.vue already is, with no risk of it quietly reading a
 * snapshot the parent's `v-if="store.snapshot"` guard did not actually
 * clear yet.
 *
 * The two coordinates are `defineModel`s, not a plain `{ col, row }` object
 * prop: this row needs to WRITE the parent's `moveTargets[b.id]` entry as
 * the player types (that entry is the one source of truth, read again by
 * `moveTo` below), and mutating a nested field of an object prop directly
 * (`props.moveTarget.col = …`) is exactly what `vue/no-mutating-props`
 * exists to forbid — silent parent mutation from a child is how two
 * components end up disagreeing about which one owns a value. `defineModel`
 * compiles to the same `update:*` emit `v-model` always has, so the parent's
 * `v-model:move-col="moveTargets[b.id].col"` still writes through to the one
 * record BuildingsView.vue owns, just via an explicit event instead of a
 * silent write.
 */
const props = defineProps<{
  building: BuildingSnapshot;
  idleAdults: number;
  map: WorldMapSize;
  buildings: readonly BuildingSnapshot[];
}>();

const moveCol = defineModel<number>('moveCol', { required: true });
const moveRow = defineModel<number>('moveRow', { required: true });

const engine = inject(ENGINE_KEY)!;

/**
 * Why Move is disabled, or null — gated on the SAME predicate the canvas's
 * ghost paints red with (`isTileBuildable`, `shared/placement.ts`), not a
 * second derivation of it: the world screen's `useWorldInteraction.tileValid`
 * calls the identical function, so a tile the Ledger would offer and the
 * canvas would refuse can never happen. The first branch (a site) matches
 * InspectorFooter's own `moveReason` — the SAME reason text, from
 * `labels.ts` — but is not itself shared as one function with it:
 * InspectorFooter checks a mode-armed building before any target is chosen,
 * this checks an already-typed target too, and the two functions have only
 * their first line in common, not a shape worth forcing through one
 * signature.
 */
function moveRefusal(): string | null {
  if (props.building.constructionTicks > 0) return MOVE_SITE_REASON;
  const col = moveCol.value;
  const row = moveRow.value;
  if (!Number.isInteger(col) || !Number.isInteger(row)) return WHOLE_TILES_ONLY_REASON;
  if (!isTileBuildable(props.map, props.buildings, col, row)) {
    return TILE_UNAVAILABLE_REASON;
  }
  return null;
}

/**
 * Copies the typed coordinates into the command rather than handing over
 * the model refs themselves. `GameEngine.dispatch` passes the Command object
 * straight through to `CommandQueue.push`, which stores the reference
 * (`resources.ts`) — nothing downstream clones it. `{ col, row }` here is a
 * fresh plain object built from the two CURRENT values, so a later edit to
 * either input cannot reach back into a command already sitting in the
 * queue: a player who clicks Move for (9, 4) and then edits either field
 * before the queue drains on the next tick must not watch the building land
 * somewhere they never asked for — a window that never closes on its own
 * while paused.
 */
function moveTo() {
  engine.dispatch({ type: 'moveBuilding', buildingId: props.building.id, to: { col: moveCol.value, row: moveRow.value } });
}
</script>

<template>
  <tr :data-test="`building-row-${building.id}`">
    <td>{{ BUILDINGS[building.defId].name }}</td>
    <td>({{ building.col }}, {{ building.row }})</td>
    <td :data-test="`waiting-${building.id}`">{{ waitingLabel(building.storage, building.stored, building.buffered) }}</td>
    <td :data-test="`in-${building.id}`">{{ building.inputBuffered }}</td>
    <!-- The Inspector's own `have / need` (`suppliedLabel`), not the bare
         shortfall: §2.5 promises every number a panel shows survives into
         the table, and "14 Wood" alone reads the same on a site just ordered
         as on one load from finishing — suppliedLabel's "11 / 25 Wood" is
         the progress that shortfall cannot show. `—` for anything that is
         not a site, matching `downtimeLabel`'s convention. -->
    <td :data-test="`needs-${building.id}`">
      {{ building.constructionTicks > 0 ? suppliedLabel(building.defId, building.constructionNeeds) : '—' }}
    </td>
    <td :data-test="`downtime-${building.id}`">{{ downtimeLabel(building.relocatingTicks) }}</td>
    <!-- The Inspector's construction countdown, restated: today's row already
         carries State ("Under construction"), Needs (the shortfall) and
         Downtime (relocatingTicks) — none of which IS constructionTicks, so
         a renderer failure used to lose this figure outright. Same em-dash
         convention as Downtime for a settled building. -->
    <td :data-test="`building-ticks-${building.id}`">{{ downtimeLabel(building.constructionTicks) }}</td>
    <td>
      <button
        :data-test="`unassign-${building.id}`" :disabled="unassignRefusal(building) !== null"
        @click="engine.dispatch({ type: 'unassignWorker', buildingId: building.id })"
      >−</button>
      {{ building.workers }} / {{ building.workerSlots }}
      <button
        :data-test="`assign-${building.id}`" :disabled="staffingRefusal(building, idleAdults) !== null"
        @click="engine.dispatch({ type: 'assignWorker', buildingId: building.id })"
      >+</button>
      <!-- §2.2: stated here, not left in a `title` — the exact miss a
           reviewer found two tasks ago on this surface's own hauler pair
           (DashboardView), fixed alongside this. -->
      <small v-if="unassignRefusal(building)" class="obsisim-reason" :data-test="`unassign-reason-${building.id}`">
        {{ unassignRefusal(building) }}
      </small>
      <small v-if="staffingRefusal(building, idleAdults)" class="obsisim-reason" :data-test="`assign-reason-${building.id}`">
        {{ staffingRefusal(building, idleAdults) }}
      </small>
    </td>
    <td>{{ BUILDING_STATE_LABELS[building.state] }}</td>
    <td :data-test="`batch-${building.id}`">{{ batchLabel(building.beds, building.occupants, building.progressPct) }}</td>
    <td>{{ building.workPower.toFixed(2) }}</td>
    <td>{{ building.tooledWorkers > 0 ? `⚒ ${building.tooledWorkers}/${building.workers}` : '—' }}</td>
    <td>
      <!-- Deliberately worse than dragging a ghost across the map: this
           exists so the fallback is complete (spec §2.2), not so it is nice.
           `moveCol`/`moveRow` are guaranteed seeded by BuildingsView's own
           watch before this row can ever exist — the trap this exists to
           avoid is a bare `reactive({})` that throws on `.col` at first
           paint. Gated on `moveRefusal`, which covers the site case AND
           every coordinate the engine would reject, with the reason
           rendered in the row rather than hidden in a title. -->
      <input v-model.number="moveCol" :data-test="`move-col-${building.id}`" type="number" min="0">
      <input v-model.number="moveRow" :data-test="`move-row-${building.id}`" type="number" min="0">
      <button :data-test="`move-${building.id}`" :disabled="moveRefusal() !== null" @click="moveTo">Move</button>
      <small v-if="moveRefusal()" class="obsisim-reason" :data-test="`move-reason-${building.id}`">
        {{ moveRefusal() }}
      </small>
    </td>
    <td>
      <TwoStepButton
        label="Demolish" confirm-label="Confirm demolish?" :data-test="`demolish-${building.id}`"
        @confirm="engine.dispatch({ type: 'demolishBuilding', buildingId: building.id })"
      />
    </td>
  </tr>
</template>
