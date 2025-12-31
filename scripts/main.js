/**
 * @file main.js
 * @description Entry point for the Squad Combat Initiative module.
 * @version V13 Only
 */

import {
  MODULE_ID,
  logger,
  skipFinalizeSet,
  renderBatcher,
  normalizeHtml,
} from "./shared.js";
import { registerSettings } from "./settings.js";
import {
  onDeleteCombat,
  onCreateCombatant,
  onUpdateCombat,
  combatTrackerRendering,
} from "./combat-tracker.js";
import { groupHeaderRendering } from "./group-header-rendering.js";
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
Hooks.on("createCombatant", onCreateCombatant);
Hooks.on("updateCombat", onUpdateCombat);

/**
 * Monitors individual initiative updates.
 */
Hooks.on("updateCombatant", async (combatant, changes) => {
  // Guard: Mutex & Internal Sets
  if (GroupManager._mutex || skipFinalizeSet.has(combatant)) return;

  // Guard: Only care if initiative changed
  if (!("initiative" in changes)) return;

  const groupId = combatant.getFlag(MODULE_ID, "groupId");
  if (!groupId || groupId === "ungrouped") return;

  const combat = combatant.parent;
  if (!combat) return;

  // Guard: Skip flag (set during batch operations)
  const skip = combat.getFlag(MODULE_ID, `skipFinalize.${groupId}`);
  if (skip) return;

  logger.trace("Manual initiative change detected, finalizing group", { 
    fn: "updateCombatant",
    data: { combatant: combatant.name, groupId }
  });

  await GroupManager.finalizeGroupInitiative(combat, groupId);
});

/* ------------------------------------------------------------------ */
/*  UI Rendering Hooks                                                */
/* ------------------------------------------------------------------ */

Hooks.on("renderCombatTracker", (app, html, data) => {
  const element = normalizeHtml(html);
  renderBatcher.schedule(app, element);
  combatTrackerRendering(app, element);
});

console.log(`${MODULE_ID} | Core hooks registered.`);