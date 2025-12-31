/**
 * @file rolling-overrides.js
 * @description Intercepts core Combat initiative rolls to apply Group Initiative logic.
 * @version V13 Only
 * @requires lib-wrapper
 */

import { MODULE_ID, logger } from "./shared.js";
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

  const wrapperCallback = async function (wrappedFn, ...args) {
    const wrapLog = logger.fn("rollWrapper");
    
    await wrappedFn(...args);

    if (this._groupInitiativeProcessed) return;
    this._groupInitiativeProcessed = true;

    wrapLog.trace("Processing group initiatives after bulk roll");

    try {
      const groups = GroupManager.getGroups(this.turns, this);
      const groupIds = [...groups.keys()].filter(id => id !== UNGROUPED);

      if (groupIds.length > 0) {
        wrapLog.debug("Finalizing groups after bulk roll", { groupCount: groupIds.length });
      }

      for (const groupId of groupIds) {
        await GroupManager.finalizeGroupInitiative(this, groupId);
      }
      
      if (groupIds.length > 0) {
        wrapLog.success("Bulk roll group processing complete");
      }
    } catch (err) {
      wrapLog.error("Error in group roll wrapper", err);
    } finally {
      setTimeout(() => {
        delete this._groupInitiativeProcessed;
      }, 0);
    }
  };

  try {
    libWrapper.register(MODULE_ID, "Combat.prototype.rollAll", wrapperCallback, "WRAPPER");
    libWrapper.register(MODULE_ID, "Combat.prototype.rollNPC", wrapperCallback, "WRAPPER");

    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.__groupSortWrappersRegistered = true;

    log.success("rollAll / rollNPC wrapped successfully");
  } catch (err) {
    log.error("Failed to register lib-wrapper overrides", err);
  }
}