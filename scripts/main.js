/**
 * @file main.js
 * @description Entry point for the Squad Combat Initiative module.
 * @version Foundry V14+
 */

import {
  MODULE_ID,
  logger,
  isGM,
  canManageGroups,
  generateGroupId,
  calculateAverageInitiative,
  calculateGroupInitiative,
  expandStore,
  CONSTANTS,
  INITIATIVE_MODE,
  MORALE_TRIGGER,
  visibilitySyncInProgress,
  renderBatcher,
  normalizeHtml,
  preloadTemplates,
} from "./shared.js";
import { registerSettings, migrateLegacySettings, VISIBILITY_SYNC_MODE, DEBUG_LEVELS, HIGHLIGHT_VISIBILITY } from "./settings.js";
import {
  onDeleteCombat,
  onCreateCombatant,
  onUpdateCombat,
  onDeleteCombatant,
  combatTrackerRendering,
  promptAssignment,
} from "./combat-tracker.js";
import { groupHeaderRendering, clearAllTokenHighlights } from "./group-header-rendering.js";
import { GroupManager, INITIATIVE_UPDATE_OPTION, UNGROUPED } from "./group-manager.js";
import { overrideRollMethods } from "./rolling-overrides.js";
import { MoraleManager, DISCIPLINE } from "./morale.js";
import { isMutationAuthority, registerMutationAuthority } from "./mutation-authority.js";
import { CombatEvents, handleActorCasualties, cleanupDeletedCombat } from "./combat-events.js";
import { refreshCombatOrder } from "./combat-state.js";
import { migrateWorldData } from "./migrations.js";
import { registerDiagnostics, registerDiagnosticsSocket } from "./diagnostics.js";

/* ------------------------------------------------------------------ */
/*  Initialization Hooks                                              */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  logger.info("Initializing...");
  registerSettings();
  registerMutationAuthority();
  registerDiagnosticsSocket();
});

Hooks.once("ready", async () => {
  try {
    await migrateLegacySettings();
  } catch (err) {
    logger.warn("Legacy logging migration failed; continuing module startup", { data: err.message });
  }
  try {
    const cleared = await GroupManager.clearLegacySkipFinalizeFlags();
    if (cleared) logger.info(`Cleared legacy initiative guards from ${cleared} combat(s)`);
  } catch (err) {
    logger.warn("Legacy initiative guard cleanup failed; continuing module startup", { data: err.message });
  }
  groupHeaderRendering();
  overrideRollMethods();
  for (const combat of game.combats ?? []) { combat.prepareData(); refreshCombatOrder(combat); }
  try { await migrateWorldData(); }
  catch (error) { logger.error("SCI startup reconciliation failed", error); ui.notifications.error(error.message); }
  preloadTemplates().catch((err) => logger.error("Failed to preload templates", err));
  expandStore.sweep();

  /* --- Public API Registration --- */
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      // Group Management
      createGroup: GroupManager.createGroup.bind(GroupManager),
      autoGroupCombatants: GroupManager.autoGroupCombatants.bind(GroupManager),
      deleteGroup: GroupManager.deleteGroup.bind(GroupManager),
      editGroup: GroupManager.editGroup.bind(GroupManager),
      getGroups: GroupManager.getGroups.bind(GroupManager),
      addCombatantsToGroup: GroupManager.addCombatantsToGroup.bind(GroupManager),
      removeCombatantFromGroup: GroupManager.removeCombatantFromGroup.bind(GroupManager),

      // Group Presets
      getGroupPresets: GroupManager.getPresets.bind(GroupManager),
      saveGroupPreset: GroupManager.savePreset.bind(GroupManager),
      updateGroupPreset: GroupManager.updatePreset.bind(GroupManager),
      deleteGroupPreset: GroupManager.deletePreset.bind(GroupManager),

      // Initiative
      rollGroupInitiative: GroupManager.rollGroupAndApplyInitiative.bind(GroupManager),
      skipGroupTurn: GroupManager.skipGroupTurn.bind(GroupManager),
      setGroupInitiative: GroupManager.setGroupInitiative.bind(GroupManager),
      resetGroupInitiative: GroupManager.resetGroupInitiative.bind(GroupManager),
      finalizeGroupInitiative: GroupManager.finalizeGroupInitiative.bind(GroupManager),

      // Captain
      setCaptain: GroupManager.setCaptain.bind(GroupManager),
      removeCaptain: GroupManager.removeCaptain.bind(GroupManager),

      // Visibility
      toggleGroupVisibility: GroupManager.toggleGroupVisibility.bind(GroupManager),

      // Utilities
      generateGroupId,
      isGM,
      canManageGroups,
      calculateAverageInitiative,
      calculateGroupInitiative,
      clearAllTokenHighlights,

      // Morale
      rollMorale: MoraleManager.rollMorale.bind(MoraleManager),
      rollMoraleSingle: MoraleManager.rollMoraleSingle.bind(MoraleManager),
      rallyMorale: MoraleManager.rallyMorale.bind(MoraleManager),
      clearMorale: MoraleManager.clearMorale.bind(MoraleManager),
      clearMoraleEffect: MoraleManager.clearMoraleEffect.bind(MoraleManager),
      checkAutoMorale: MoraleManager.checkAutoMorale.bind(MoraleManager),
      getLivingMembers: MoraleManager.getLivingMembers.bind(MoraleManager),
      getDeadMembers: MoraleManager.getDeadMembers.bind(MoraleManager),
      getCasualtyCount: MoraleManager.getCasualtyCount.bind(MoraleManager),
      DISCIPLINE,

      // Constants
      MODULE_ID,
      UNGROUPED,
      CONSTANTS,
      INITIATIVE_MODE,
      MORALE_TRIGGER,
      VISIBILITY_SYNC_MODE,
      HIGHLIGHT_VISIBILITY,
      DEBUG_LEVELS,

      // UI State
      expandStore,

      // Diagnostics
      diagnostics: null,
    };

    registerDiagnostics(mod.api);

    Hooks.callAll(`${MODULE_ID}.apiReady`, mod.api);
    logger.info("Public API registered");
  }

  logger.success("Module ready");
});

/* ------------------------------------------------------------------ */
/*  Combat Logic Hooks                                                */
/* ------------------------------------------------------------------ */

Hooks.on("deleteCombat", onDeleteCombat);
Hooks.on("deleteCombat", cleanupDeletedCombat);
Hooks.on("deleteCombat", clearAllTokenHighlights);
Hooks.on("deleteCombat", (combat) => MoraleManager.clearPromptedGroups(combat)); // Also clears captain death tracking
Hooks.on("canvasReady", clearAllTokenHighlights);
Hooks.on("createCombatant", onCreateCombatant);
Hooks.on("preCreateCombatantGroup", () => {
  ui.notifications.warn(game.i18n.localize("SCI.Errors.NativeGroupingDisabled"));
  return false;
});
Hooks.on("preUpdateCombatant", (member, changes, options) => {
  if (options[INITIATIVE_UPDATE_OPTION]) return;
  if (changes.group) {
    ui.notifications.warn(game.i18n.localize("SCI.Errors.NativeGroupingDisabled"));
    return false;
  }
  const flat = foundry.utils.flattenObject(changes);
  const oldGroup = member.getFlag(MODULE_ID, "groupId");
  const path = `flags.${MODULE_ID}.groupId`;
  const removes = `flags.${MODULE_ID}.-=groupId` in flat;
  const hasChange = path in flat || removes;
  const target = hasChange ? (removes ? null : flat[path]) : oldGroup;
  const nativeGroup = "group" in changes ? changes.group : member.group;
  if ((hasChange || "group" in changes) && target && target !== UNGROUPED && nativeGroup) {
    ui.notifications.warn(game.i18n.localize("SCI.Errors.NativeGroupConflict"));
    return false;
  }
  if (hasChange) (options.sciPreviousGroups ??= {})[member.id] = oldGroup ?? null;
});
Hooks.on("deleteCombatant", onDeleteCombatant);
for (const event of ["createCombatantGroup", "updateCombatantGroup", "deleteCombatantGroup"]) {
  Hooks.on(event, group => { if (isMutationAuthority()) return CombatEvents.nativeOrder(group.parent); });
}
Hooks.on("updateCombat", onUpdateCombat);

/**
 * Adds "Set as Captain" / "Remove as Captain" to combatant context menus.
 */
Hooks.on("getCombatTrackerContextOptions", (_app, options) => {
  if (canManageGroups()) options.push({
    name: "SCI.Card.Assign", icon: '<i class="fas fa-users"></i>',
    condition: li => !!li?.dataset?.combatantId,
    callback: li => promptAssignment(_app.viewed, [li.dataset.combatantId]),
  });
  options.push(
    {
      name: "SCI.ContextMenu.SetCaptain",
      icon: '<i class="fas fa-crown" style="color: gold;"></i>',
      condition: (li) => {
        if (!canManageGroups()) return false;
        const combatantId = li.dataset.combatantId;
        const combat = _app.viewed;
        if (!combat) return false;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        if (!groupId || groupId === "ungrouped") return false;
        const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
        return meta.captainId !== combatantId;
      },
      callback: async (li) => {
        const combatantId = li.dataset.combatantId;
        const combat = _app.viewed;
        if (!combat) return;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        if (groupId) await GroupManager.setCaptain(combat, groupId, combatantId);
      },
    },
    {
      name: "SCI.ContextMenu.RemoveCaptain",
      icon: '<i class="fas fa-crown" style="opacity: 0.4;"></i>',
      condition: (li) => {
        if (!canManageGroups()) return false;
        const combatantId = li.dataset.combatantId;
        const combat = _app.viewed;
        if (!combat) return false;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        if (!groupId || groupId === "ungrouped") return false;
        const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
        return meta.captainId === combatantId;
      },
      callback: async (li) => {
        const combatantId = li.dataset.combatantId;
        const combat = _app.viewed;
        if (!combat) return;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        if (groupId) await GroupManager.removeCaptain(combat, groupId);
      },
    },
    {
      name: "SCI.ContextMenu.RallyMorale",
      icon: '<i class="fas fa-hand-fist"></i>',
      condition: (li) => {
        if (!canManageGroups()) return false;
        try { if (!game.settings.get(MODULE_ID, "moraleEnabled")) return false; } catch { return false; }
        const combatantId = li.dataset.combatantId;
        const combat = _app.viewed;
        if (!combat) return false;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        return groupId && groupId !== "ungrouped" && combatant.getFlag(MODULE_ID, "moraleStatus") === "failed";
      },
      callback: async (li) => {
        const combatantId = li.dataset.combatantId;
        const combat = _app.viewed;
        if (!combat) return;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        if (groupId && groupId !== "ungrouped") {
          await MoraleManager.rallyMorale(combat, groupId, combatantId);
          ui.combat.render();
        }
      },
    },
    {
      name: "SCI.ContextMenu.ClearMorale",
      icon: '<i class="fas fa-broom"></i>',
      condition: (li) => {
        if (!canManageGroups()) return false;
        try { if (!game.settings.get(MODULE_ID, "moraleEnabled")) return false; } catch { return false; }
        const combatantId = li.dataset.combatantId;
        const combat = _app.viewed;
        if (!combat) return false;
        const combatant = combat.combatants.get(combatantId);
        return !!combatant?.getFlag(MODULE_ID, "moraleStatus");
      },
      callback: async (li) => {
        const combatantId = li.dataset.combatantId;
        const combat = _app.viewed;
        if (!combat) return;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        if (groupId && groupId !== "ungrouped") {
          await MoraleManager.clearMorale(combat, groupId, combatantId);
          ui.combat.render();
        }
      },
    }
  );
});

/**
 * Monitors individual initiative updates.
 */
Hooks.on("updateCombatant", async (combatant, changes, options = {}) => {
  const log = logger.fn("updateCombatant");

  if (!isMutationAuthority()) return;
  // Guard: Only care if initiative changed
  if (!("initiative" in changes)) return;

  log.trace("Initiative change detected", {
    combatant: combatant.name,
    newInit: changes.initiative,
    internal: options?.[INITIATIVE_UPDATE_OPTION] === true,
    bulkRoll: GroupManager.isBulkRollInProgress(combatant.parent),
  });

  // Guard: module-owned writes are already part of a serialized operation.
  if (options?.[INITIATIVE_UPDATE_OPTION] === true) {
    log.trace("Skipping - internal initiative update");
    return;
  }
  if (GroupManager.isBulkRollInProgress(combatant.parent)) {
    log.trace("Skipping - bulk roll in progress");
    return;
  }

  const groupId = combatant.getFlag(MODULE_ID, "groupId");
  if (!groupId || groupId === "ungrouped") {
    log.trace("Skipping - no group or ungrouped", { groupId });
    return;
  }

  const combat = combatant.parent;
  if (!combat) return;

  log.debug("Manual initiative change, finalizing group", {
    combatant: combatant.name,
    groupId
  });

  await GroupManager.finalizeGroupInitiative(combat, groupId);
});

/* ------------------------------------------------------------------ */
/*  Visibility Sync Hooks                                             */
/* ------------------------------------------------------------------ */

Hooks.on("updateCombatant", async (member, changes, options = {}) => {
  if (!("hidden" in changes) || !isMutationAuthority() || options.sciVisibilitySync || options[INITIATIVE_UPDATE_OPTION]) return;
  await CombatEvents.visibility(member.parent, member, changes.hidden, "combatant");
});

Hooks.on("updateToken", async (token, changes, options = {}) => {
  if (!("hidden" in changes) || !isMutationAuthority() || options.sciVisibilitySync) return;
  for (const combat of game.combats ?? []) {
    for (const member of combat.combatants) {
      if (member.token?.uuid === token.uuid && member.hidden !== changes.hidden) await CombatEvents.visibility(combat, member, changes.hidden, "token");
    }
  }
});

/* ------------------------------------------------------------------ */
/*  Morale System Hooks                                               */
/* ------------------------------------------------------------------ */

Hooks.on("updateCombat", async (combat, changes, options = {}) => {
  if (!isMutationAuthority() || options[INITIATIVE_UPDATE_OPTION]) return;
  if ("turn" in changes || "round" in changes) await CombatEvents.startTurn(combat);
});

Hooks.on("updateActor", handleActorCasualties);
Hooks.on("userConnected", () => { if (isMutationAuthority()) void migrateWorldData().catch(error => logger.error("GM handover reconciliation failed", error)); });
Hooks.on("updateCombatant", async (member, changes, options = {}) => {
  if (!isMutationAuthority() || options[INITIATIVE_UPDATE_OPTION]) return;
  if ("defeated" in changes) {
    const groupId = member.getFlag(MODULE_ID, "groupId");
    if (groupId && groupId !== UNGROUPED) await CombatEvents.casualty(member.parent, groupId);
  }
  if (options.sciPreviousGroups && member.id in options.sciPreviousGroups) {
    await CombatEvents.membershipChanged(member.parent, member, options.sciPreviousGroups[member.id]);
  }
});

/**
 * Listens for clicks on [Roll Morale] buttons in auto-prompt chat messages.
 */
Hooks.on("renderChatMessageHTML", (_message, html) => {
  const element = html instanceof HTMLElement ? html : html?.[0];
  if (!element) return;

  const btn = element.querySelector(".sci-morale-roll-btn");
  if (!btn) return;

  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const combatId = btn.dataset.combatId;
    const groupId = btn.dataset.groupId;
    if (!combatId || !groupId) return;

    const combat = game.combats.get(combatId);
    if (!combat) {
      ui.notifications.warn(game.i18n.localize("SCI.Notifications.CombatMissing"));
      return;
    }

    await MoraleManager.rollMorale(combat, groupId);
  });
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
