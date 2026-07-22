/**
 * @file rolling-overrides.js
 * @description Intercepts core Combat initiative rolls to apply Group Initiative logic.
 * @version Foundry V14+
 * @requires lib-wrapper
 */

import { MODULE_ID, logger, CONSTANTS } from "./shared.js";
import { GroupManager, UNGROUPED } from "./group-manager.js";
import { compareGroupedCombatants } from "./initiative-ordering.js";

/* ------------------------------------------------------------------ */
/*  Internationalization Helpers                                      */
/* ------------------------------------------------------------------ */

let _pluralRules;
let _pluralRulesLang;
const _numFormatters = new Map();

/**
 * @returns {Intl.PluralRules}
 */
export function getPluralRules() {
  if (!_pluralRules || _pluralRulesLang !== game.i18n.lang) {
    _pluralRulesLang = game.i18n.lang;
    _pluralRules = new Intl.PluralRules(_pluralRulesLang);
  }
  return _pluralRules;
}

/**
 * @param {number} n
 * @param {Intl.NumberFormatOptions} [opts={}]
 * @returns {string}
 */
export function formatNumber(n, opts = {}) {
  const key = `${game.i18n.lang}:${JSON.stringify(opts)}`;
  if (!_numFormatters.has(key)) {
    _numFormatters.set(key, new Intl.NumberFormat(game.i18n.lang, opts));
  }
  return _numFormatters.get(key).format(n);
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
    log.errorNotify(game.i18n.localize("SCI.Notifications.LibWrapperMissing"));
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
    GroupManager.setBulkRollInProgress(this, true);
    wrapLog.debug("Marked this combat as bulk rolling");

    let result;

    try {
      wrapLog.debug("Calling original roll function...");
      result = await wrappedFn(...args);
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
        await GroupManager.finalizeGroupInitiative(this, groupId);
      }

      wrapLog.success("Bulk roll group processing complete");
      return result;
    } catch (err) {
      wrapLog.error("Error in group roll wrapper", err);
      throw err;
    } finally {
      GroupManager.setBulkRollInProgress(this, false);
      wrapLog.debug("Cleared this combat's bulk-roll marker");

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

    libWrapper.register(
      MODULE_ID,
      `${combatPath}.prototype._sortCombatants`,
      function (wrappedFn, a, b) {
        return compareGroupedCombatants(a, b, {
          moduleId: MODULE_ID,
          ungrouped: UNGROUPED,
          fallbackCompare: (left, right) => wrappedFn(left, right),
        });
      },
      "WRAPPER"
    );
    log.debug(`Registered ${combatPath}.prototype._sortCombatants wrapper`);

    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.__groupSortWrappersRegistered = true;

    log.success(`rollAll / rollNPC wrapped successfully on ${combatPath}`);
  } catch (err) {
    log.error("Failed to register lib-wrapper overrides", err);
  }
}
