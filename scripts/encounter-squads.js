/**
 * @file encounter-squads.js
 * @description Groups the combatants of a placed dnd5e Encounter actor into one squad.
 * @version Foundry V14+
 * @requires lib-wrapper
 */

import { MODULE_ID, logger, unnamedGroup } from "./shared.js";
import { GroupManager } from "./group-manager.js";

const PLACE_MEMBERS_PATH = "dnd5e.dataModels.actor.EncounterData.prototype.placeMembers";

/**
 * Wraps Encounter placement when dnd5e exposes it. Placement never fails because of a squad error.
 * @returns {boolean} Whether the wrapper was registered.
 */
export function registerEncounterSquads() {
  if (game.system.id !== "dnd5e" || !game.modules.get("lib-wrapper")?.active) return false;
  if (typeof globalThis.dnd5e?.dataModels?.actor?.EncounterData?.prototype?.placeMembers !== "function") {
    logger.warn("dnd5e Encounter placement is not available; Encounter squads are off");
    return false;
  }

  libWrapper.register(MODULE_ID, PLACE_MEMBERS_PATH, async function (wrapped, config = {}) {
    // dnd5e resolves config.combatBehavior in place, so the handler sees the value it used.
    const tokens = await wrapped(config);
    try {
      await onEncounterPlaced(this.parent, tokens, config);
    } catch (err) {
      logger.error("Encounter placed but its squad could not be created", err);
      ui.notifications.error(game.i18n.localize("SCI.Errors.EncounterSquad"));
    }
    return tokens;
  }, "WRAPPER");
  return true;
}

/**
 * Creates one squad from the combatants a placement added. The captain comes from roster order,
 * because tokens are not always returned from creation in request order.
 * @param {Actor} encounter - The Encounter actor
 * @param {TokenDocument[]} tokens - The placed tokens
 * @param {Object} [config]
 * @param {string} [config.combatBehavior] - dnd5e's resolved placement behavior
 * @returns {Promise<string|null>} The new group's id, or null when no squad was created
 */
export async function onEncounterPlaced(encounter, tokens, config = {}) {
  if (game.settings.get(MODULE_ID, "encounterSquads") !== true) return null;
  if (!tokens?.length || config.combatBehavior === "none") return null;

  const combat = game.combats.viewed ?? game.combat;
  if (!combat) return null;
  const tokenIds = new Set(tokens.map((token) => token.id));
  const members = combat.combatants.filter((combatant) => tokenIds.has(combatant.tokenId));
  if (!members.length) return null;

  // Token documents, not ids: dnd5e's placement usually leaves the encounter with no linked scene to look ids up in.
  const groupId = await GroupManager.createGroup(combat, {
    name: encounter?.name || unnamedGroup(),
    img: encounter?.img,
    initiativeMode: game.settings.get(MODULE_ID, "defaultInitiativeMode"),
  }, members.map((combatant) => tokens.find((token) => token.id === combatant.tokenId)));
  if (!groupId) return null;

  const captain = members.find((combatant) => combatant.actor?.system?.traits?.important === true);
  if (captain) await GroupManager.setCaptain(combat, groupId, captain.id);
  return groupId;
}
