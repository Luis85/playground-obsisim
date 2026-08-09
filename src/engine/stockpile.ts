import type { CostMap, ResourceId } from '../shared/content-types';
import { CAMP_SITE_ID, type StoreSite } from '../shared/haul';
import { MAX_SAVED_COUNTER } from '../shared/save';

/**
 * The colony's goods, one spendable total held across one or more places — the
 * camp (`CAMP_SITE_ID`, always present and unbounded) plus zero or more
 * storehouse sites. `get`/`canAfford`/`pay`/`take`/`add`/`refund` are the
 * aggregate: a goods total is a goods total wherever it stands, so hunger
 * meals, construction costs, demolition refunds, `colonyWealth` and
 * `StatsSystem` read and spend through them exactly as before increment 7.
 *
 * `*At` methods are the site-aware half, for `HaulSystem`, the command
 * handlers and the save — the only callers that need to know WHERE a good
 * sits rather than merely how much of it the colony has.
 */
export class Stockpile {
  private readonly sites = new Map<number, Map<ResourceId, number>>();
  readonly producedThisTick = new Map<ResourceId, number>();
  readonly consumedThisTick = new Map<ResourceId, number>();

  constructor(initial: Partial<Record<ResourceId, number>> = {}) {
    const camp = new Map<ResourceId, number>();
    for (const [id, amount] of Object.entries(initial)) {
      camp.set(id as ResourceId, amount);
    }
    this.sites.set(CAMP_SITE_ID, camp);
  }

  private siteMap(siteId: number): Map<ResourceId, number> {
    let map = this.sites.get(siteId);
    if (map === undefined) {
      map = new Map();
      this.sites.set(siteId, map);
    }
    return map;
  }

  /** What one site holds of one resource. 0 for a site that holds none, or
   * that has never been banked into. */
  getAt(siteId: number, id: ResourceId): number {
    return this.sites.get(siteId)?.get(id) ?? 0;
  }

  /** The colony-wide total: every site's holding of this resource, summed. */
  get(id: ResourceId): number {
    let total = 0;
    for (const site of this.sites.values()) total += site.get(id) ?? 0;
    return total;
  }

  /** Everything one site holds, across every resource — what a `StoreSite`'s
   * capacity is measured against, and what a save needs per building. */
  totalAt(siteId: number): number {
    const site = this.sites.get(siteId);
    if (site === undefined) return 0;
    let total = 0;
    for (const amount of site.values()) total += amount;
    return total;
  }

  /**
   * Camp first, then every other site by ascending id — the ONE place this
   * order is written down. `pay`/`take`/`remove` draw against it, so what a
   * colony spends never depends on which site a hauler happened to bank into
   * first.
   */
  private drawOrder(): number[] {
    const others = [...this.sites.keys()].filter((id) => id !== CAMP_SITE_ID).sort((a, b) => a - b);
    return [CAMP_SITE_ID, ...others];
  }

  /**
   * Site ids currently tracked, in `drawOrder` order (camp first, then
   * ascending). Reuses the one place draw order is written down rather than
   * sorting again, so there is only ever one comparator to get wrong.
   */
  siteIds(): number[] {
    return this.drawOrder();
  }

  /** One site's contents, for the save — `{}` for a site that holds nothing. */
  siteJSON(siteId: number): Partial<Record<ResourceId, number>> {
    const site = this.sites.get(siteId);
    return site === undefined ? {} : (Object.fromEntries(site) as Partial<Record<ResourceId, number>>);
  }

  /**
   * Saturates at MAX_SAVED_COUNTER (like IdCounter): banking onto a stock
   * sitting at the save-format ceiling must not write an amount the load
   * guard would reject on the next reopen. Organically unreachable (~9e15).
   * Shared by every banking path — they differ only in which site they touch
   * and whether the bank counts as a delivery, never in how it is clamped.
   */
  private bank(siteId: number, id: ResourceId, amount: number): number {
    const held = this.getAt(siteId, id);
    const banked = Math.min(amount, MAX_SAVED_COUNTER - held);
    this.siteMap(siteId).set(id, held + banked);
    return banked;
  }

  /**
   * Banks at `site` up to its capacity, forwarding whatever does not fit to
   * the camp — which is unbounded and cannot refuse, so this can never
   * partially fail and no caller is ever handed a remainder (§2.4 invariant
   * 1). Capacity is measured against the site's TOTAL occupancy across every
   * resource, the same quantity `nearestSiteWithRoom` checks, not against
   * this one resource alone. Returns the total actually banked (post-clamp),
   * for callers that record it as a delivery.
   */
  private bankWithSpill(site: StoreSite, id: ResourceId, amount: number): number {
    const headroom = site.capacity === null ? amount : Math.max(0, site.capacity - this.totalAt(site.id));
    const atSite = Math.min(amount, headroom);
    const overflow = amount - atSite;
    return this.bank(site.id, id, atSite) + this.bank(CAMP_SITE_ID, id, overflow);
  }

  /**
   * Banks resources a hauler actually carried in, recording into
   * `producedThisTick` — stats record only what was actually banked, never
   * the pre-saturation amount. Deposits at the camp: unchanged from before
   * increment 7, and still what `HaulSystem`'s current single-destination
   * trips call.
   */
  add(id: ResourceId, amount: number): void {
    const banked = this.bank(CAMP_SITE_ID, id, amount);
    this.producedThisTick.set(id, (this.producedThisTick.get(id) ?? 0) + banked);
  }

  /**
   * Banks resources without recording a delivery. `producedThisTick` is what
   * `StatsSystem` publishes as `deliveredRate`, so anything banked that a
   * hauler did not carry — a demolition's construction-cost refund, for
   * instance — must go through here rather than through `add`, or it
   * inflates the Economy view's Delivered/t for a resource nobody hauled.
   */
  refund(id: ResourceId, amount: number): void {
    this.bank(CAMP_SITE_ID, id, amount);
  }

  /** Site-aware `add`: banks at `site` (spilling excess to the camp) and
   * records the delivery, same as `add`. */
  addAt(site: StoreSite, id: ResourceId, amount: number): void {
    const banked = this.bankWithSpill(site, id, amount);
    this.producedThisTick.set(id, (this.producedThisTick.get(id) ?? 0) + banked);
  }

  /** Site-aware `refund`: banks at `site` (spilling excess to the camp)
   * without recording a delivery, same as `refund`. */
  refundAt(site: StoreSite, id: ResourceId, amount: number): void {
    this.bankWithSpill(site, id, amount);
  }

  /**
   * Takes up to `amount` from one site and returns what was actually taken —
   * partial, unlike `take`, because a hauler loading a supply trip takes
   * whatever a site has rather than failing the whole pickup over a shortfall.
   * Does NOT touch `consumedThisTick`: §2.4 moves the moment of consumption
   * away from the moment goods leave a site (a supply load can sit in transit,
   * then in a building's input buffer, for several ticks before the colony has
   * actually spent it) — see `recordConsumed`.
   */
  takeAt(siteId: number, id: ResourceId, amount: number): number {
    const held = this.getAt(siteId, id);
    const taken = Math.min(held, Math.max(0, amount));
    if (taken > 0) this.siteMap(siteId).set(id, held - taken);
    return taken;
  }

  /**
   * Moves everything `fromSiteId` holds into `toSiteId`, saturating at the
   * same ceiling every other bank does, then empties the source. For a
   * storehouse leaving play (demolished, or beginning a relocation) with
   * stock still in it — the goods still belong to the colony, so they land
   * back on a site rather than vanishing.
   */
  spillTo(toSiteId: number, fromSiteId: number): void {
    const from = this.sites.get(fromSiteId);
    if (from === undefined) return;
    for (const [id, amount] of from) {
      if (amount > 0) this.bank(toSiteId, id, amount);
    }
    this.sites.delete(fromSiteId);
  }

  /**
   * Records consumption without removing anything — the second half of the
   * split `takeAt` creates (see there). Called when a good already taken off
   * a site is actually spent, e.g. entering a building's input buffer.
   */
  recordConsumed(id: ResourceId, amount: number): void {
    this.consumedThisTick.set(id, (this.consumedThisTick.get(id) ?? 0) + amount);
  }

  /**
   * Restore-only: reconstructs a site's contents exactly as the engine
   * previously wrote them, recording no delivery. The `StoreSite`-typed
   * banking calls above deliberately cannot express "bank into a store that
   * is not a live site" — that is what stops an orphan site being created
   * during play. Loading needs exactly that: a save taken while a stocked
   * storehouse was mid-relocation holds contents for a building the site list
   * excludes until its countdown ends, so there is no `StoreSite` to hand
   * `addAt`. Called once per building by the restore path only — if this ever
   * appears in `HaulSystem`, the invariant it protects has been bypassed
   * rather than served.
   */
  seedSite(siteId: number, contents: Partial<Record<ResourceId, number>>): void {
    const map = this.siteMap(siteId);
    for (const [id, amount] of Object.entries(contents)) {
      map.set(id as ResourceId, amount);
    }
  }

  canAfford(cost: CostMap): boolean {
    return Object.entries(cost).every(([id, amount]) => this.get(id as ResourceId) >= amount);
  }

  /** All-or-nothing across the whole cost map. Returns success. */
  pay(cost: CostMap): boolean {
    if (!this.canAfford(cost)) return false;
    for (const [id, amount] of Object.entries(cost)) this.remove(id as ResourceId, amount);
    return true;
  }

  /** Take a quantity of one resource if fully available. Returns success. */
  take(id: ResourceId, amount: number): boolean {
    if (this.get(id) < amount) return false;
    this.remove(id, amount);
    return true;
  }

  resetTickFlows(): void {
    this.producedThisTick.clear();
    this.consumedThisTick.clear();
  }

  /** The camp alone, so a v5 stockpile — which never had storehouses — round-
   * trips unchanged. Per-site contents are the save's job, via `siteJSON`. */
  toJSON(): Partial<Record<ResourceId, number>> {
    return this.siteJSON(CAMP_SITE_ID);
  }

  /** Draws `amount` across sites in `drawOrder`, camp first: the shared tail
   * of `pay` and `take`, called only once the caller has confirmed the whole
   * colony (not any one site) can afford it. */
  private remove(id: ResourceId, amount: number): void {
    let remaining = amount;
    for (const siteId of this.drawOrder()) {
      if (remaining <= 0) break;
      const held = this.getAt(siteId, id);
      if (held <= 0) continue;
      const draw = Math.min(held, remaining);
      this.siteMap(siteId).set(id, held - draw);
      remaining -= draw;
    }
    this.consumedThisTick.set(id, (this.consumedThisTick.get(id) ?? 0) + amount);
  }
}
