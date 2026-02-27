/**
 * @file rolling-overrides.js
 * @description Intercepts core Combat initiative rolls to apply Group Initiative logic.
 * @version V13 Only
 * @requires lib-wrapper
 */

import { MODULE_ID, logger, CONSTANTS } from "./shared.js";
import { GroupManager, UNGROUPED } from "./class-objects.js";

/* ------------------------------------------------------------------ */
/*  Internationalization Helpers                                      */
/* ------------------------------------------------------------------ */

let _pluralRules;
let _numFormatter;

/**
 * @returns {Intl.PluralRules}
 */
export function getPluralRules() {
  if (!_pluralRules) {
    _pluralRules = new Intl.PluralRules(game.i18n.lang);
  }
  return _pluralRules;
}

/**
 * @param {number} n
 * @param {Intl.NumberFormatOptions} [opts={}]
 * @returns {string}
 */
export function formatNumber(n, opts = {}) {
  if (!_numFormatter) {
    _numFormatter = new Intl.NumberFormat(game.i18n.lang, opts);
  }
  return _numFormatter.format(n);
}

/* ------------------------------------------------------------------ */
/*  Combat Roll Patching                                              */
/* ------------------------------------------------------------------ */

export let wrapped = false;

/**
 * Patches Combat.prototype.rollAll and rollNPC with group initiative logic.
 */
export function overrideRollMethods() {
  if (wrapped) return;
  wrapped = true;

  const log = logger.fn("overrideRollMethods");

  if (!game.modules.get("lib-wrapper")?.active) {
    log.errorNotify("lib-wrapper is missing or inactive. Group rolls will NOT function correctly.");
    return;
  }

  log.debug("Registering libWrapper overrides", {
    libWrapperVersion: game.modules.get("lib-wrapper")?.version,
    combatPrototype: typeof Combat.prototype.rollAll,
  });

  const wrapperCallback = async function (wrappedFn, ...args) {
    const wrapLog = logger.fn("rollWrapper");

    wrapLog.info("=== BULK ROLL TRIGGERED ===", {
      combatId: this.id,
      turnCount: this.turns?.length,
      args: args,
    });

    // Prevent re-entry if already processing
    if (this._groupInitiativeProcessed) {
      wrapLog.warn("Already processing, calling original only");
      return wrappedFn(...args);
    }

    // Set flag to prevent individual updateCombatant hooks from running finalization
    GroupManager._bulkRollInProgress = true;
    wrapLog.debug("Set _bulkRollInProgress = true");

    try {
      wrapLog.debug("Calling original roll function...");
      await wrappedFn(...args);
      wrapLog.debug("Original roll function complete");

      this._groupInitiativeProcessed = true;

      // Small delay to ensure all Foundry updates have propagated
      await new Promise(resolve => setTimeout(resolve, CONSTANTS.BULK_ROLL_DELAY_MS));

      // Get all groups that need finalization
      const groups = GroupManager.getGroups(this.turns, this);
      const groupIds = [...groups.keys()].filter(id => id !== UNGROUPED);

      wrapLog.info("Processing groups after bulk roll", {
        groupCount: groupIds.length,
        groupIds: groupIds,
        groupNames: groupIds.map(id => groups.get(id)?.name || "Unknown"),
      });

      // Process each group sequentially
      for (const groupId of groupIds) {
        wrapLog.debug(`Finalizing group: ${groupId}`);
        await GroupManager.finalizeGroupInitiative(this, groupId, { bypassMutex: true });
      }

      wrapLog.success("Bulk roll group processing complete");
    } catch (err) {
      wrapLog.error("Error in group roll wrapper", err);
    } finally {
      GroupManager._bulkRollInProgress = false;
      wrapLog.debug("Set _bulkRollInProgress = false");

      setTimeout(() => {
        delete this._groupInitiativeProcessed;
      }, 0);
    }
  };

  try {
    // Determine the correct global path for the Combat class
    // For dnd5e, it's under dnd5e.documents.Combat5e
    // For base Foundry, it's just Combat
    let combatPath = "Combat";

    if (game.system.id === "dnd5e" && typeof dnd5e?.documents?.Combat5e === "function") {
      combatPath = "dnd5e.documents.Combat5e";
    }

    log.info("Targeting Combat class for wrapping", {
      combatPath,
      systemId: game.system.id,
    });

    libWrapper.register(
      MODULE_ID,
      `${combatPath}.prototype.rollAll`,
      wrapperCallback,
      "WRAPPER"
    );
    log.debug(`Registered ${combatPath}.prototype.rollAll wrapper`);

    libWrapper.register(
      MODULE_ID,
      `${combatPath}.prototype.rollNPC`,
      wrapperCallback,
      "WRAPPER"
    );
    log.debug(`Registered ${combatPath}.prototype.rollNPC wrapper`);

    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.__groupSortWrappersRegistered = true;

    log.success(`rollAll / rollNPC wrapped successfully on ${combatPath}`);
  } catch (err) {
    log.error("Failed to register lib-wrapper overrides", err);
  }
}