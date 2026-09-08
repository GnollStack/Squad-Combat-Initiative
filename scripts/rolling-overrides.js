/**
 * @file rolling-overrides.js
 * @description Intercepts core Combat initiative rolls to apply Group Initiative logic.
 * @version Foundry V14+
 * @requires lib-wrapper
 */

import { MODULE_ID, logger, CONSTANTS } from "./shared.js";
import { GroupManager, UNGROUPED } from "./group-manager.js";
import { compareGroupedCombatants } from "./initiative-ordering.js";
import { registerCombatStateWrappers } from "./combat-state.js";
import { isMutationAuthority } from "./mutation-authority.js";
import { disableNativeGrouping } from "./native-group-policy.js";

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
    const before = new Map(Array.from(this.combatants ?? []).map(c => [c.id, c.initiative]));
    const nested = GroupManager.isBulkRollInProgress(this);
    if (!nested) GroupManager.setBulkRollInProgress(this, true);
    try {
      const result = await wrappedFn(...args);
      if (!nested && isMutationAuthority()) {
        const affected = new Set(Array.from(this.combatants ?? [])
          .filter(c => before.get(c.id) !== c.initiative)
          .map(c => c.getFlag(MODULE_ID, "groupId")).filter(id => id && id !== UNGROUPED));
        for (const groupId of affected) {
          try { await GroupManager.finalizeGroupInitiative(this, groupId); }
          catch (error) { logger.error("Native roll completed but SCI reconciliation failed", error); ui.notifications.error(error.message); }
        }
      }
      return result;
    } finally {
      if (!nested) GroupManager.setBulkRollInProgress(this, false);
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
        // WRAPPER must invoke the next comparator even when squad ordering wins.
        const nativeOrder = wrappedFn(a, b);
        return compareGroupedCombatants(a, b, {
          moduleId: MODULE_ID,
          ungrouped: UNGROUPED,
          fallbackCompare: () => nativeOrder,
        });
      },
      "WRAPPER"
    );
    log.debug(`Registered ${combatPath}.prototype._sortCombatants wrapper`);

    registerCombatStateWrappers(combatPath);
    disableNativeGrouping();
    if (combatPath !== "Combat") {
      libWrapper.register(MODULE_ID, `${combatPath}.prototype.createGroups`, function (wrappedFn, ...args) {
        wrappedFn(...args);
        return new Map();
      }, "WRAPPER");
    }
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.__groupSortWrappersRegistered = true;
    wrapped = true;

    log.success(`rollAll / rollNPC wrapped successfully on ${combatPath}`);
  } catch (err) {
    log.error("Failed to register lib-wrapper overrides", err);
  }
}
