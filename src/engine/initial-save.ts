import { LATEST_SAVE_VERSION } from '../shared/save';
import type { SaveGameV6 } from '../shared/save';
import { autoPlacePosition, DEFAULT_MAP } from '../shared/placement';
import { SALT, spreadFor } from '../shared/population';
import { BALANCE, STARTING_STOCK, STARTING_COLONISTS } from './content/balance';

/** The starter house's id, and therefore every founder's `homeId`. Taking id 1
 * keeps the founders on the ids that follow, so the first thing the player
 * builds still gets the id after the last founder. */
const STARTER_HOUSE_ID = 1;

export function initialSave(): SaveGameV6 {
  return {
    version: LATEST_SAVE_VERSION,
    tick: 0,
    lastRecruitTick: -BALANCE.recruitCooldownTicks,
    lastBirthTick: -BALANCE.birthCooldownTicks,
    stockpile: { ...STARTING_STOCK },
    map: { ...DEFAULT_MAP },
    // The first pre-placed building in the game's history, and worth the
    // exception: a house costs planks, planks need a sawmill, and a colony that
    // opens with 30 wood cannot build one for a long time — so without this the
    // whole opening is spent at homelessFactor for reasons the player cannot act
    // on. With it, the pressure starts legibly: you are housed, you have one
    // spare bed, and the fourth colonist is the first thing you must build for.
    buildings: [{
      id: STARTER_HOUSE_ID, defId: 'house', ...autoPlacePosition(DEFAULT_MAP, [])!,
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0, inputBuffer: {}, stored: {},
    }],
    colonists: Array.from({ length: STARTING_COLONISTS }, (_, index) => ({
      id: index + 1 + STARTER_HOUSE_ID,
      hunger: 0,
      buildingId: null,
      toolTicks: 0,
      hauling: false,
      ageTicks: BALANCE.startingAgeTicks
        + spreadFor(index + 1 + STARTER_HOUSE_ID, BALANCE.lifeBands.spreadTicks, SALT.startingAge),
      homeId: STARTER_HOUSE_ID,
      starvingTicks: 0,
    })),
    nextEntityId: STARTING_COLONISTS + 1 + STARTER_HOUSE_ID,
  };
}
