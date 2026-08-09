export type ResourceId = 'berries' | 'wheat' | 'wood' | 'flour' | 'planks' | 'bread' | 'tools';

export type BuildingDefId =
  | 'gatherersHut'
  | 'farm'
  | 'mill'
  | 'bakery'
  | 'forester'
  | 'sawmill'
  | 'workshop'
  | 'house'
  | 'storehouse';

export type ResourceTier = 'raw' | 'processed' | 'finished';

export type CostMap = Partial<Record<ResourceId, number>>;

export interface ResourceDef {
  id: ResourceId;
  name: string;
  tier: ResourceTier;
  value: number;
  edible: boolean;
}

export interface RecipeDef {
  inputs: CostMap;
  outputs: CostMap;
  /** Colonist-ticks of accumulated progress needed to finish one batch. */
  ticksPerBatch: number;
}

export interface BuildingDef {
  id: BuildingDefId;
  name: string;
  cost: CostMap;
  workerSlots: number;
  /** Null for a building that shelters or stores instead of producing.
   * Exactly one of `recipe`, `beds`, and `storage` is set — pinned by a
   * content test (increment 6's recipe-or-beds pair, generalised to a third
   * role in increment 7). */
  recipe: RecipeDef | null;
  /** Sleeping places this building provides. 0 for a producer or a store. */
  beds: number;
  /** Units of goods this building can hold for haulers to drop off and
   * collect. 0 for everything that is not a store. */
  storage: number;
}

export interface ChainStep {
  building: BuildingDefId;
  output: ResourceId;
}

export interface Chain {
  name: string;
  steps: readonly ChainStep[];
}
