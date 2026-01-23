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

Hooks.once("ready", () => {
  groupHeaderRendering();
  overrideRollMethods();
  logger.success("Module ready");

  // DIAGNOSTIC: Check what Combat class is actually being used
  setTimeout(() => {
    const log = logger.fn("diagnostics");
    const combatClass = CONFIG.Combat.documentClass;
    log.info("Combat class diagnostics", {
      className: combatClass?.name,
      hasRollAll: typeof combatClass?.prototype?.rollAll,
      hasRollNPC: typeof combatClass?.prototype?.rollNPC,
      hasRollInitiative: typeof combatClass?.prototype?.rollInitiative,
      prototypeChain: getPrototypeChain(combatClass),
    });

    // Check if dnd5e has its own methods
    if (game.system.id === "dnd5e") {
      log.info("dnd5e specific checks", {
        combatTrackerClass: ui.combat?.constructor?.name,
        dnd5eCombat: typeof dnd5e?.documents?.Combat5e,
      });
    }

    // Check libWrapper registration status
    const mod = game.modules.get(MODULE_ID);
    log.info("libWrapper status", {
      libWrapperActive: game.modules.get("lib-wrapper")?.active,
      wrappersRegistered: mod?.__groupSortWrappersRegistered,
      registeredWrappers: libWrapper?.wrappers ? Object.keys(libWrapper.wrappers).filter(k => k.includes("rollAll") || k.includes("rollNPC")) : "N/A",
    });
  }, 1000);
});

function getPrototypeChain(cls) {
  const chain = [];
  let current = cls;
  while (current && current.name) {
    chain.push(current.name);
    current = Object.getPrototypeOf(current);
  }
  return chain;
}

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
/*  UI Rendering Hooks                                                */
/* ------------------------------------------------------------------ */

Hooks.on("renderCombatTracker", (app, html, data) => {
  const element = normalizeHtml(html);
  renderBatcher.schedule(app, element);
  combatTrackerRendering(app, element);
});

console.log(`${MODULE_ID} | Core hooks registered.`);