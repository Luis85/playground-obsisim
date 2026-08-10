// The spatial law of the colony in one pure module: which tiles exist, which
// are buildable, and where an unpositioned construction lands. Three
// consumers must never disagree — the engine's command handlers
// (authoritative validation), the app's ghost preview (cosmetic pre-check),
// and the v1->v2 save migration (position synthesis for pre-spatial saves).
// relocationTicks (the relocation-downtime law) and ticksForDistance (the
// floor-and-ceiling arithmetic it shares with haulTicks in haul.ts) live
// here too, but are a separate law with a single caller
// (placement-handlers.ts) — not part of the three-consumer contract above.
// Imports nothing, so src/shared/ siblings (save.ts, save-migration.ts,
// haul.ts) can import from it without cycles.

/** Map dimensions in tiles. Persisted per colony since save v2. */
export interface WorldMapSize {
  cols: number;
  rows: number;
}

/** A tile position. SavedBuilding and BuildingSnapshot both satisfy it. */
export interface TileRef {
  col: number;
  row: number;
}

/** The fixed world size every new (and every migrated) colony starts with. */
export const DEFAULT_MAP: WorldMapSize = { cols: 24, rows: 16 };

/** Structural bounds for a persisted map size (isSaveGameV2). */
export const MIN_MAP: WorldMapSize = { cols: 8, rows: 6 };
export const MAX_MAP: WorldMapSize = { cols: 256, rows: 256 };

/**
 * The left CAMP_COLS columns are the idle-camp band — the tent and idle
 * workers live there, buildings never. Derived from the map by constant
 * rather than persisted: it has exactly one legal value per map today.
 */
export const CAMP_COLS = 3;

// Legacy plot pattern — increment 2's derived layout, frozen here so
// autoPlacePosition can replay it: 5 plots per row at cols 4,6,8,10,12,
// plot rows at 1,3,5,...
const PLOT_COL0 = 4;
const PLOTS_PER_ROW = 5;
const PLOT_ROW0 = 1;

export function isInsideMap(map: WorldMapSize, col: number, row: number): boolean {
  return (
    Number.isSafeInteger(col) && Number.isSafeInteger(row) &&
    col >= 0 && col < map.cols && row >= 0 && row < map.rows
  );
}

/**
 * THE placement predicate: inside the map, off the camp band, not occupied.
 * `occupied` is whatever building list the caller holds — saved records,
 * live component rows, and snapshot buildings all carry col/row.
 */
export function isTileBuildable(map: WorldMapSize, occupied: readonly TileRef[], col: number, row: number): boolean {
  if (!isInsideMap(map, col, row) || col < CAMP_COLS) return false;
  return !occupied.some((tile) => tile.col === col && tile.row === row);
}

/**
 * Where a construction with no player-chosen tile lands: the first free tile
 * in the legacy plot sequence (so migrated and table-built colonies keep the
 * geometry increment 2 drew), then the first free buildable tile row-major,
 * then null (map full). Occupancy is a prebuilt Set, not per-candidate
 * `occupied.some()` — a table-build in a migrated colony near the guard's
 * 10,000-record cap would otherwise pay ~50M comparisons inside one tick.
 * O(occupied + tiles scanned).
 */
export function autoPlacePosition(map: WorldMapSize, occupied: readonly TileRef[]): TileRef | null {
  const taken = new Set(occupied.map((tile) => `${tile.col},${tile.row}`));
  const free = (col: number, row: number) =>
    isInsideMap(map, col, row) && col >= CAMP_COLS && !taken.has(`${col},${row}`);
  for (let row = PLOT_ROW0; row < map.rows; row += 2) {
    for (let plot = 0; plot < PLOTS_PER_ROW; plot++) {
      const col = PLOT_COL0 + 2 * plot;
      if (col < map.cols && free(col, row)) return { col, row };
    }
  }
  for (let row = 0; row < map.rows; row++) {
    for (let col = CAMP_COLS; col < map.cols; col++) {
      if (free(col, row)) return { col, row };
    }
  }
  return null;
}

/**
 * The map a migrated colony of this size needs. Fidelity first: rows tall
 * enough that the LEGACY PLOT SEQUENCE alone holds every building, because
 * increment 2's derived grid grew rows without bound and the compatibility
 * promise is "every building keeps the exact tile increment 2 drew" —
 * sizing for raw capacity would spill building 41 of a 24×16 map into the
 * row-major scan at (3,0) instead of its legacy (4,17). That fidelity holds
 * through 640 buildings (128 plot rows × 5 inside MAX_MAP's 256 rows), far
 * past any organic v1 colony. Capacity second: for pathological saves
 * beyond the legacy band (the structural guard admits 10,000 records),
 * grow rows then columns until the count simply fits — those buildings get
 * compact, not historical, positions. Migration must never classify a
 * valid oversized colony as corrupt.
 */
export function mapThatFits(buildingCount: number): WorldMapSize {
  const map = { ...DEFAULT_MAP };
  const plotRows = Math.ceil(buildingCount / PLOTS_PER_ROW);
  map.rows = Math.max(map.rows, Math.min(PLOT_ROW0 + 2 * plotRows - 1, MAX_MAP.rows));
  const fits = () => (map.cols - CAMP_COLS) * map.rows >= buildingCount;
  while (!fits() && map.rows < MAX_MAP.rows) map.rows += 1;
  while (!fits() && map.cols < MAX_MAP.cols) map.cols += 1;
  return map;
}

/**
 * The order auto-placement consumes an EMPTY map: the legacy plot pass, then
 * row-major over everything not already yielded. Exists for the migration,
 * which places every building of a save onto a fresh map — walking this
 * sequence is linear, where replaying autoPlacePosition against a growing
 * occupied-array is cubic in the building count (the structural guard admits
 * 10,000 records; a migration must not stall plugin startup). Equivalence
 * with autoPlacePosition-over-empty-map is pinned by a test.
 */
export function* autoPlaceSequence(map: WorldMapSize): Generator<TileRef> {
  const yielded = new Set<string>();
  for (let row = PLOT_ROW0; row < map.rows; row += 2) {
    for (let plot = 0; plot < PLOTS_PER_ROW; plot++) {
      const col = PLOT_COL0 + 2 * plot;
      if (col < map.cols) {
        yielded.add(`${col},${row}`);
        yield { col, row };
      }
    }
  }
  for (let row = 0; row < map.rows; row++) {
    for (let col = CAMP_COLS; col < map.cols; col++) {
      if (!yielded.has(`${col},${row}`)) yield { col, row };
    }
  }
}

/**
 * Ticks to cover `distance` at `tilesPerTick`, floored at one so a
 * distance-scaled cost is never free. The law both `relocationTicks` below
 * and `haulTicks` (src/shared/haul.ts) charge for a move — factored out so
 * the floor-and-ceiling rule lives in one place rather than two copies that
 * could quietly drift apart. Not itself a public API: the meaningful
 * surface is the two named functions that call it, which keep their own
 * signatures and doc comments.
 */
export function ticksForDistance(distance: number, tilesPerTick: number): number {
  return Math.max(1, Math.ceil(distance / tilesPerTick));
}

/**
 * Ticks a building is out of action after being moved `tilesMoved` tiles.
 *
 * `tilesPerTick` arrives as an argument rather than an import, for the same
 * reason `haulTicks` takes one: this module lives in src/shared/, which may
 * import nothing outside itself, while the tunable rate belongs to BALANCE.
 *
 * Never zero. Relocation used to be free and instant, which let a player
 * cluster every building beside the camp and never feel increment 4's haul
 * pressure at all — the gradient existed but need never be paid. The floor
 * means even a one-tile nudge costs something, while distance-scaling keeps
 * iterating on a layout cheap.
 */
export function relocationTicks(tilesMoved: number, tilesPerTick: number): number {
  return ticksForDistance(tilesMoved, tilesPerTick);
}

/**
 * THE relocation boundary: is this building mid-move, and therefore providing
 * none of its service right now — no production, no beds, no storage?
 *
 * One function rather than a `ticksLeft > 0` written out at each reader, and
 * that is OBS-6-08's whole point. This project has already spent two rounds on
 * this exact comparison (`> 0` vs `> 1`, task 6), and increment 7 was about to
 * add a third reader — a relocating storehouse is not a store site — beside the
 * two that already drew it independently in `ProductionSystem` and the
 * snapshot. The value it takes is the POST-decrement countdown wherever the
 * snapshot is the source, which is the forward-looking "will the next
 * production pass skip this building" the published `relocatingTicks` is
 * documented as; see `relocatingIdsOf` below.
 */
export function isRelocating(ticksLeft: number): boolean {
  return ticksLeft > 0;
}

/**
 * The buildings out of action right now, by id — the ONE derivation of a
 * relocating crew's zero work power (OBS-6-08).
 *
 * `ProductionSystem` used to compute every relocating worker's real
 * contribution into `powerByBuilding` and then discard it by `continue`ing
 * past the building before the map was ever read, while the snapshot reached
 * the same zero by testing set membership before computing anything. Two
 * shapes of the same boundary, agreeing only because two tests happened to
 * exercise both systems from one fixture. Both now skip on this set, so there
 * is a single membership question and a single place to get it wrong.
 */
export function relocatingIdsOf(buildings: readonly { id: number; relocatingTicks: number }[]): ReadonlySet<number> {
  return new Set(buildings.filter((b) => isRelocating(b.relocatingTicks)).map((b) => b.id));
}
