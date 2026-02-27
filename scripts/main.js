/**
 * @file main.js
 * @description Entry point for the Squad Combat Initiative module.
 * @version V13 Only
 */

import {
  MODULE_ID,
  logger,
  isGM,
  skipFinalizeSet,
  visibilitySyncInProgress,
  renderBatcher,
  normalizeHtml,
} from "./shared.js";
import { registerSettings, VISIBILITY_SYNC_MODE } from "./settings.js";
import {
  onDeleteCombat,
  onCreateCombatant,
  onUpdateCombat,
  combatTrackerRendering,
} from "./combat-tracker.js";
import { groupHeaderRendering, clearAllTokenHighlights } from "./group-header-rendering.js";
import { GroupManager } from "./class-objects.js";
import { overrideRollMethods } from "./rolling-overrides.js";

/* ------------------------------------------------------------------ */
/*  Initialization Hooks                                              */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  logger.info("Initializing...");
  registerSettings();
});

Hooks.once("ready", () => {
  groupHeaderRendering();
  overrideRollMethods();
  logger.success("Module ready");
});

/* ------------------------------------------------------------------ */
/*  Combat Logic Hooks                                                */
/* ------------------------------------------------------------------ */

Hooks.on("deleteCombat", onDeleteCombat);
Hooks.on("deleteCombat", clearAllTokenHighlights);
Hooks.on("canvasReady", clearAllTokenHighlights);
Hooks.on("createCombatant", onCreateCombatant);
Hooks.on("updateCombat", onUpdateCombat);

/**
 * Monitors individual initiative updates.
 */
Hooks.on("updateCombatant", async (combatant, changes) => {
  const log = logger.fn("updateCombatant");

  // Guard: Only care if initiative changed
  if (!("initiative" in changes)) return;

  log.trace("Initiative change detected", {
    combatant: combatant.name,
    newInit: changes.initiative,
    mutex: GroupManager._mutex,
    bulkRoll: GroupManager._bulkRollInProgress,
    inSkipSet: skipFinalizeSet.has(combatant),
  });

  // Guard: Mutex, bulk roll in progress, or internal skip set
  if (GroupManager._mutex) {
    log.trace("Skipping - mutex held");
    return;
  }
  if (GroupManager._bulkRollInProgress) {
    log.trace("Skipping - bulk roll in progress");
    return;
  }
  if (skipFinalizeSet.has(combatant)) {
    log.trace("Skipping - in skip set");
    return;
  }

  const groupId = combatant.getFlag(MODULE_ID, "groupId");
  if (!groupId || groupId === "ungrouped") {
    log.trace("Skipping - no group or ungrouped", { groupId });
    return;
  }

  const combat = combatant.parent;
  if (!combat) return;

  // Guard: Skip flag (set during batch operations)
  const skip = combat.getFlag(MODULE_ID, `skipFinalize.${groupId}`);
  if (skip) {
    log.trace("Skipping - skipFinalize flag set for group");
    return;
  }

  log.debug("Manual initiative change, finalizing group", {
    combatant: combatant.name,
    groupId
  });

  await GroupManager.finalizeGroupInitiative(combat, groupId);
});

/* ------------------------------------------------------------------ */
/*  Visibility Sync Hooks                                             */
/* ------------------------------------------------------------------ */

/**
 * Syncs combatant.hidden → token.hidden (tracker combatant toggle → canvas).
 * Only active in BIDIRECTIONAL mode. Separate from the initiative hook above.
 */
Hooks.on("updateCombatant", async (combatant, changes) => {
  const log = logger.fn("updateCombatant:visibility");

  if (!("hidden" in changes)) return;
  if (!isGM()) return;

  const syncMode = game.settings.get(MODULE_ID, "visibilitySyncMode");
  if (syncMode !== VISIBILITY_SYNC_MODE.BIDIRECTIONAL) return;

  // Guard: prevent loop with the updateToken hook
  if (visibilitySyncInProgress.has(combatant.id)) {
    log.trace("Skipping - visibilitySyncInProgress guard", { combatant: combatant.name });
    return;
  }

  const token = combatant.token;
  if (!token) return;

  const newHidden = changes.hidden;
  log.debug("Combatant hidden changed, syncing token", { combatant: combatant.name, newHidden });

  visibilitySyncInProgress.add(combatant.id);
  try {
    await token.update({ hidden: newHidden });
    await syncGroupFlag(combatant.parent, combatant, newHidden);
  } catch (err) {
    log.error("Error syncing token visibility from combatant update", err);
  } finally {
    visibilitySyncInProgress.delete(combatant.id);
  }
});

/**
 * Syncs token.hidden → combatant.hidden (native canvas hide → tracker).
 * Only active in BIDIRECTIONAL mode.
 */
Hooks.on("updateToken", async (tokenDocument, changes) => {
  const log = logger.fn("updateToken:visibility");

  if (!("hidden" in changes)) return;
  if (!isGM()) return;

  const syncMode = game.settings.get(MODULE_ID, "visibilitySyncMode");
  if (syncMode !== VISIBILITY_SYNC_MODE.BIDIRECTIONAL) return;

  const combat = game.combat;
  if (!combat) return;

  const combatant = combat.combatants.find((c) => c.tokenId === tokenDocument.id);
  if (!combatant) return;

  // Guard: prevent loop with the updateCombatant hook
  if (visibilitySyncInProgress.has(combatant.id)) {
    log.trace("Skipping - visibilitySyncInProgress guard", { token: tokenDocument.name });
    return;
  }

  const newHidden = changes.hidden;
  if (combatant.hidden === newHidden) return; // already in sync

  log.debug("Token hidden changed, syncing combatant", { token: tokenDocument.name, combatant: combatant.name, newHidden });

  visibilitySyncInProgress.add(combatant.id);
  try {
    await combatant.update({ hidden: newHidden });
    await syncGroupFlag(combat, combatant, newHidden);
  } catch (err) {
    log.error("Error syncing combatant visibility from token update", err);
  } finally {
    visibilitySyncInProgress.delete(combatant.id);
  }
});

/**
 * Updates the group's hidden flag when all members reach a unanimous hidden state.
 * Only fires when the entire group is unanimously hidden or unanimously visible.
 * @param {Combat|null} combat
 * @param {Combatant} changedCombatant - The combatant whose hidden state just changed
 * @param {boolean} newHidden - The new hidden value for that combatant
 */
async function syncGroupFlag(combat, changedCombatant, newHidden) {
  if (!combat) return;
  const groupId = changedCombatant.getFlag(MODULE_ID, "groupId");
  if (!groupId || groupId === "ungrouped") return;

  const members = combat.combatants.filter(
    (c) => c.getFlag(MODULE_ID, "groupId") === groupId
  );
  // Account for the fact that the changed combatant's doc may not have updated yet
  const allHidden = members.every((c) => (c.id === changedCombatant.id ? newHidden : c.hidden));
  const noneHidden = members.every((c) => (c.id === changedCombatant.id ? !newHidden : !c.hidden));
  if (!allHidden && !noneHidden) return; // mixed state — leave the group flag alone

  const currentGroupHidden = combat.getFlag(MODULE_ID, `groups.${groupId}.hidden`);
  if (currentGroupHidden !== allHidden) {
    await combat.setFlag(MODULE_ID, `groups.${groupId}.hidden`, allHidden);
  }
}

/* ------------------------------------------------------------------ */
/*  UI Rendering Hooks                                                */
/* ------------------------------------------------------------------ */

Hooks.on("renderCombatTracker", (app, html, data) => {
  const element = normalizeHtml(html);
  renderBatcher.schedule(app, element);
  combatTrackerRendering(app, element);
});

console.log(`${MODULE_ID} | Core hooks registered.`);