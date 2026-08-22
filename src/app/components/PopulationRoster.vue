<script setup lang="ts">
import { computed, inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { useUiStore } from '../stores/ui-store';
import { BALANCE } from '../../engine/content';
// The engine's own rejection strings, not a view-side paraphrase of them: the
// sentence beside the disabled button is exactly the notice a click would
// produce, because both sides read this one Record.
import { NOMAD_REJECTIONS } from '../../shared/population';
// Presentation lives in labels.ts, never in the template: LIFE_STAGE_LABELS is
// a Record keyed by the LifeStage union, so a stage added without a label is a
// type error here rather than a raw union member in the rendered cell.
import { ageLabel, buildingNamesById, commuteLabel, jobLabel, LIFE_STAGE_LABELS, starvingLabel } from '../labels';
// The stage/beds/homeless/meals block, shared with the Dashboard so all three
// screens cannot disagree about a number the player compares across tabs.
import PopulationSummary from './PopulationSummary.vue';

/*
 * The headline (population count, PopulationSummary, "Welcome a nomad") and
 * colonist table, factored out of PopulationView.vue rather than duplicated
 * into PopulationPanel.vue.
 *
 * This is the same "share, don't copy" call ColonyPanel/DashboardView made
 * for their own resource tables (Task 8) — but the OTHER branch of it: those
 * two tables genuinely differ in shape (eight columns sized for the routed
 * Ledger page vs. four sized for the dock's narrow column), so sharing there
 * meant sharing the getters and keeping two markups. This table does not
 * differ: the brief for the Population panel names PopulationView's headline
 * block and colonist table verbatim, unmodified except for a click added to
 * each row. Two components rendering byte-for-byte the same ten-column
 * `<table>` would be exactly the clone check:quality's `cloneGroups` and
 * `duplicatedLines` counters exist to catch, and the fix is the one this
 * codebase already uses elsewhere for a component with more than one render
 * site (InspectorColonist.vue, PopulationSummary.vue itself) — one
 * component, mounted from both places, rather than a second paste of it.
 *
 * Fix round 1 (Important): the paragraph above stops at "the markup is
 * identical", and that is as far as sharing should go. A row selecting its
 * colonist (spec §2.3) is premised on a canvas beside the panel to select
 * INTO — true of the dock's PopulationPanel, not true of PopulationView on
 * the routed `/ledger` page. Spec §2.5's Ledger contract is numbers and
 * commands; a selection is neither. So the click is a `selectable` prop,
 * defaulting to `false`, and only PopulationPanel passes `true` — see the
 * prop's own comment below for the concrete harm (`ui.select()` moving the
 * dock's panel) a click on the Ledger would otherwise cause silently.
 */
const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
const ui = useUiStore();

// Fix round 1 (Important): the click this component's own comment above
// describes ("every row selects its colonist") is a DOCK behaviour, not a
// property of the table itself — PopulationView.vue mounts this same
// component on the routed `/ledger` page, which has no canvas for a
// selection to reach (spec §2.3's click table is premised on a panel sitting
// beside one), and `ui.select()` unconditionally sets `panel = 'inspector'`
// (ui-store.ts), so a click there would silently arm the DOCK's Inspector to
// open the next time the player is back on `/` — an effect with no visible
// cause on the page where the click happened. `selectable` defaults to
// `false` so a new caller has to ask for the canvas-linked behaviour rather
// than remember to switch it off; only PopulationPanel.vue (the dock) passes
// `true`.
const props = withDefaults(defineProps<{ selectable?: boolean }>(), { selectable: false });

// A worker's own JobAssignment only carries a buildingId, not the building's
// name, so this table needs a defId -> name lookup to render the Job column.
// Recomputed whenever the snapshot's buildings change, not once at mount.
// The map itself comes from labels.ts (buildingNamesById) rather than being
// walked again here, for the same one-derivation reason jobLabel does.
const jobNames = computed(() => buildingNamesById(store.snapshot?.buildings ?? []));

// Tool coverage counts down to zero rather than toggling off, so the em-dash
// here mirrors the "—" used for an unstaffed building's tooled-worker column.
function toolLabel(toolTicks: number): string {
  return toolTicks > 0 ? `⚒ ${toolTicks}t` : '—';
}

// Beside Efficiency rather than replacing it (OBS-6-06): efficiency is a real,
// independently meaningful number on its own — it is what the world renderer
// colors a colonist's dot by (layout.ts, renderer.ts), unrelated to housing —
// so dropping it would lose a hunger-only signal the rest of the app still
// uses. Showing both together is the fix: a colonist reading 100% under
// Efficiency and 0.50 under Delivered on the SAME row is the exact confusion
// OBS-6-06 names, made legible instead of hidden behind one misleading cell.
//
// Same em-dash convention as toolLabel above: null means this colonist isn't
// assigned to a building right now (idle, or hauling — a hauler's throughput
// is carried capacity, not work power), so there is nothing to show, not a
// zero to round down to. Two decimals to match BuildingsView's own
// `workPower.toFixed(2)`, so the two screens report the same quantity in the
// same units — a player could sum this column, per building, against that one.
function deliveredLabel(power: number | null): string {
  return power === null ? '—' : power.toFixed(2);
}

// hunger reads backwards next to efficiency (higher = worse), so the cell is
// colored once the worker is at the meal threshold and again when fully
// starving. Bound to the hunger <td> only (Step 3): efficiency already has
// its own column, and coloring both would say the same thing twice.
//
// Reuses BALANCE.mealThreshold/hungerMax rather than new literals, so a
// balance retune can't silently desync this coloring from colonistEfficiency()
// in content/balance.ts. The `>=` here (vs. colonistEfficiency's `<=`) is
// deliberate: the warning fires at hunger === mealThreshold itself, one tick
// before efficiency actually starts to drop.
function hungerClass(hunger: number): string {
  if (hunger >= BALANCE.hungerMax) return 'obsisim-negative';
  if (hunger >= BALANCE.mealThreshold) return 'obsisim-warning';
  return '';
}

// Warning, not negative: a homeless colonist is losing half their work power
// (BALANCE.homelessFactor), which is a standing cost the player should fix —
// but unlike the starvation clock below, nothing is counting down to a death.
function commuteClass(homeId: number | null): string {
  return homeId === null ? 'obsisim-warning' : '';
}

// The starvation clock is the one cell on this screen that names a deadline, so
// it goes straight to negative the moment it starts rather than passing through
// a warning tier: by the time starvingTicks is above zero the colonist is
// already pinned at hungerMax, and the hunger cell beside it is red too.
function starvingClass(starvingTicks: number): string {
  return starvingTicks > 0 ? 'obsisim-negative' : '';
}
</script>

<template>
  <div v-if="store.snapshot">
    <div class="obsisim-headline">
      <span>Population: <strong>{{ store.snapshot.population }}</strong></span>
      <PopulationSummary />
      <button
        data-test="recruit"
        :disabled="store.nomadBlocker !== null"
        @click="engine.dispatch({ type: 'recruitWorker' })"
      >
        Welcome a nomad
      </button>
      <span v-if="store.nomadBlocker" data-test="recruit-reason">{{ NOMAD_REJECTIONS[store.nomadBlocker] }}</span>
      <span v-if="store.nomadBlocker === 'cooldown'" data-test="recruit-wait">{{ store.recruitCooldownRemaining }}t</span>
    </div>
    <table class="obsisim-table">
      <thead>
        <tr><th>Colonist</th><th>Age</th><th>Stage</th><th>Home</th><th>Job</th><th>Hunger</th><th>Starving</th><th>Efficiency</th><th>Delivered</th><th>Tool</th></tr>
      </thead>
      <tbody>
        <!-- Spec §2.3: a Population colonist row selects that colonist —
             but only where a canvas is on screen to receive it (the dock's
             PopulationPanel, `selectable="true"`). On the Ledger
             (`selectable` false, the default) the row must be genuinely
             INERT: `v-on` bound to an empty object attaches no listener at
             all, the same "absence, not a no-op" shape ColonyPanel.vue's
             resource rows use, rather than a handler that reads `selectable`
             and early-returns — a no-op still leaves a live code path and a
             clickable-looking row behind. When selectable, the row itself
             carries the click, not a cell inside it, so anywhere on the row
             (not just one column) reaches the map. -->
        <tr
          v-for="w in store.snapshot.colonists"
          :key="w.id"
          :data-test="`colonist-row-${w.id}`"
          v-on="props.selectable ? { click: () => ui.selectColonist(w.id) } : {}"
        >
          <td>#{{ w.id }}</td>
          <td :data-test="`age-${w.id}`">{{ ageLabel(w.ageTicks) }}</td>
          <td :data-test="`stage-${w.id}`">{{ LIFE_STAGE_LABELS[w.stage] }}</td>
          <td :data-test="`commute-${w.id}`" :class="commuteClass(w.homeId)">{{ commuteLabel(w.homeId, w.commuteTiles, w.commuteFactor) }}</td>
          <td :data-test="`job-${w.id}`">{{ jobLabel(w.buildingId, w.hauling, w.haulKind, jobNames) }}</td>
          <td :data-test="`hunger-${w.id}`" :class="hungerClass(w.hunger)">{{ w.hunger }} / {{ BALANCE.hungerMax }}</td>
          <td :data-test="`starving-${w.id}`" :class="starvingClass(w.starvingTicks)">{{ starvingLabel(w.starvingTicks) }}</td>
          <td :data-test="`efficiency-${w.id}`">{{ (w.efficiency * 100).toFixed(0) }}%</td>
          <td :data-test="`delivered-${w.id}`">{{ deliveredLabel(w.deliveredWorkPower) }}</td>
          <td>{{ toolLabel(w.toolTicks) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
