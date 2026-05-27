/**
 * @file main.js
 * @description Entry point for the Squad Combat Initiative module.
 * @version V13 Only
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
} from "./shared.js";
import { registerSettings, VISIBILITY_SYNC_MODE, DEBUG_LEVELS, HIGHLIGHT_VISIBILITY } from "./settings.js";
import {
  onDeleteCombat,
  onCreateCombatant,
  onUpdateCombat,
  onDeleteCombatant,
  combatTrackerRendering,
} from "./combat-tracker.js";
import { groupHeaderRendering, clearAllTokenHighlights } from "./group-header-rendering.js";
import { GroupManager, UNGROUPED } from "./class-objects.js";
import { overrideRollMethods } from "./rolling-overrides.js";
import { MoraleManager, DISCIPLINE } from "./morale.js";
import { registerDiagnostics } from "./diagnostics.js";

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

      // Initiative
      rollGroupInitiative: GroupManager.rollGroupAndApplyInitiative.bind(GroupManager),
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
Hooks.on("deleteCombat", clearAllTokenHighlights);
Hooks.on("deleteCombat", () => MoraleManager.clearPromptedGroups()); // Also clears captain death tracking
Hooks.on("canvasReady", clearAllTokenHighlights);
Hooks.on("createCombatant", onCreateCombatant);
Hooks.on("deleteCombatant", onDeleteCombatant);
Hooks.on("updateCombat", onUpdateCombat);

/**
 * Adds "Set as Captain" / "Remove as Captain" to combatant context menus.
 */
Hooks.on("getCombatTrackerContextOptions", (_app, options) => {
  options.push(
    {
      name: "Set as Captain",
      icon: '<i class="fas fa-crown" style="color: gold;"></i>',
      condition: (li) => {
        if (!canManageGroups()) return false;
        const combatantId = li.dataset.combatantId;
        const combat = game.combat;
        if (!combat) return false;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        if (!groupId || groupId === "ungrouped") return false;
        const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
        return meta.captainId !== combatantId;
      },
      callback: async (li) => {
        const combatantId = li.dataset.combatantId;
        const combat = game.combat;
        if (!combat) return;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        if (groupId) await GroupManager.setCaptain(combat, groupId, combatantId);
      },
    },
    {
      name: "Remove as Captain",
      icon: '<i class="fas fa-crown" style="opacity: 0.4;"></i>',
      condition: (li) => {
        if (!canManageGroups()) return false;
        const combatantId = li.dataset.combatantId;
        const combat = game.combat;
        if (!combat) return false;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        if (!groupId || groupId === "ungrouped") return false;
        const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
        return meta.captainId === combatantId;
      },
      callback: async (li) => {
        const combatantId = li.dataset.combatantId;
        const combat = game.combat;
        if (!combat) return;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        if (groupId) await GroupManager.removeCaptain(combat, groupId);
      },
    },
    {
      name: "Rally Morale",
      icon: '<i class="fas fa-hand-fist"></i>',
      condition: (li) => {
        if (!canManageGroups()) return false;
        try { if (!game.settings.get(MODULE_ID, "moraleEnabled")) return false; } catch { return false; }
        const combatantId = li.dataset.combatantId;
        const combat = game.combat;
        if (!combat) return false;
        const combatant = combat.combatants.get(combatantId);
        const groupId = combatant?.getFlag(MODULE_ID, "groupId");
        return groupId && groupId !== "ungrouped" && combatant.getFlag(MODULE_ID, "moraleStatus") === "failed";
      },
      callback: async (li) => {
        const combatantId = li.dataset.combatantId;
        const combat = game.combat;
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
      name: "Clear Morale",
      icon: '<i class="fas fa-broom"></i>',
      condition: (li) => {
        if (!canManageGroups()) return false;
        try { if (!game.settings.get(MODULE_ID, "moraleEnabled")) return false; } catch { return false; }
        const combatantId = li.dataset.combatantId;
        const combat = game.combat;
        if (!combat) return false;
        const combatant = combat.combatants.get(combatantId);
        return !!combatant?.getFlag(MODULE_ID, "moraleStatus");
      },
      callback: async (li) => {
        const combatantId = li.dataset.combatantId;
        const combat = game.combat;
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
Hooks.on("updateCombatant", async (combatant, changes) => {
  const log = logger.fn("updateCombatant");

  // Guard: Only care if initiative changed
  if (!("initiative" in changes)) return;

  log.trace("Initiative change detected", {
    combatant: combatant.name,
    newInit: changes.initiative,
    mutex: GroupManager._mutex,
    bulkRoll: GroupManager._bulkRollInProgress,
  });

  // Guard: Mutex or bulk roll in progress
  if (GroupManager._mutex) {
    log.trace("Skipping - mutex held");
    return;
  }
  if (GroupManager._bulkRollInProgress) {
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
/*  Morale System Hooks                                               */
/* ------------------------------------------------------------------ */

/**
 * Records starting sizes for all groups when combat starts (round 0 → 1).
 */
Hooks.on("updateCombat", async (combat, changes) => {
  if (!isGM()) return;
  try {
    if (!game.settings.get(MODULE_ID, "moraleEnabled")) return;
  } catch { return; }

  // Detect combat starting: round changes to 1
  if (changes.round === 1) {
    await MoraleManager.recordStartingSizes(combat);
  }
});

/**
 * Per-turn automatic morale check.
 * When a combatant's turn starts, auto-rolls morale if conditions are met.
 */
Hooks.on("updateCombat", async (combat, changes) => {
  if (!isGM()) return;
  const log = logger.fn("updateCombat:autoMorale");

  // Fire on turn change OR round change (round change also advances the turn)
  if (!("turn" in changes) && !("round" in changes)) return;

  try {
    if (!game.settings.get(MODULE_ID, "moraleEnabled")) return;
  } catch { return; }

  const combatant = combat.combatant;
  if (!combatant) {
    log.trace("No active combatant");
    return;
  }

  log.debug(`Turn changed to "${combatant.name}" (turn=${combat.turn}, round=${combat.round})`);
  await MoraleManager.checkAutoMorale(combat, combatant);
});

/**
 * Monitors actor HP changes for morale auto-prompt triggers and captain death.
 */
Hooks.on("updateActor", async (actor, changes) => {
  if (!isGM()) return;
  try {
    if (!game.settings.get(MODULE_ID, "moraleEnabled")) return;
  } catch { return; }

  const newHp = changes?.system?.attributes?.hp?.value;
  if (newHp === undefined) return;

  const combat = game.combat;
  if (!combat) return;

  const log = logger.fn("updateActor:morale");

  // Find combatant(s) for this actor in the current combat
  const combatants = combat.combatants.filter((c) => c.actorId === actor.id);

  for (const combatant of combatants) {
    const groupId = combatant.getFlag(MODULE_ID, "groupId");
    if (!groupId || groupId === "ungrouped") continue;

    const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const trigger = meta.moraleTrigger ?? MORALE_TRIGGER.BOTH;

    // Skip all auto-morale if set to manual only
    if (trigger === MORALE_TRIGGER.MANUAL) continue;

    // Captain death morale trigger
    const captainDeathEnabled = trigger === MORALE_TRIGGER.CAPTAIN_DEATH || trigger === MORALE_TRIGGER.BOTH;
    if (captainDeathEnabled && newHp <= 0) {
      if (meta.captainId === combatant.id && !MoraleManager.hasCaptainDeathTriggered(groupId)) {
        log.debug(`Captain "${combatant.name}" has fallen in group "${meta.name}" — triggering morale check`);
        await MoraleManager.handleCaptainDeath(combat, groupId, combatant.name);
        continue; // Skip normal threshold check since captain death already rolled morale
      }
    }

    // Casualty threshold auto-prompt
    const thresholdEnabled = trigger === MORALE_TRIGGER.THRESHOLD || trigger === MORALE_TRIGGER.BOTH;
    if (thresholdEnabled && MoraleManager.shouldAutoPrompt(combat, groupId)) {
      log.debug(`Auto-prompt triggered for group "${groupId}" due to HP change on ${actor.name}`);
      await MoraleManager.sendAutoPrompt(combat, groupId);
    }
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
      ui.notifications.warn("Combat no longer exists.");
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
