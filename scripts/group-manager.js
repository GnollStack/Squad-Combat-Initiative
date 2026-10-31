/**
 * @file group-manager.js
 * @description Core business logic for group management: CRUD, auto-grouping,
 *              initiative calculation and finalization, captains, and visibility.
 * @version Foundry V14+
 */

import { MODULE_ID, logger, isGM, CONSTANTS, MORALE_TRIGGER, generateGroupId, expandStore, visibilitySyncInProgress, sanitizeColor, sanitizeImagePath, unnamedGroup } from "./shared.js";
import { VISIBILITY_SYNC_MODE } from "./settings.js";
import { registerCommandOwner, assertMutationAuthority, isMutationAuthority } from "./mutation-authority.js";
import { updateCombatState, updateMembers, setCombatFlag } from "./combat-state.js";
import { normalizeGroupConfig, assertSeparateGroups, UNGROUPED } from "./group-contracts.js";
import { MoraleManager } from "./morale.js";
import { rollGroupAndApplyInitiative as rollGroupAndApplyInitiativeImpl, finalizeGroupInitiative as finalizeGroupInitiativeImpl, setGroupInitiative as setGroupInitiativeImpl, resetGroupInitiative as resetGroupInitiativeImpl, reconcileGroupInitiatives as reconcileGroupInitiativesImpl, skipGroupTurn as skipGroupTurnImpl, setBulkRollInProgress as setBulkRollInProgressImpl, isBulkRollInProgress as isBulkRollInProgressImpl, _enqueueInitiativeOperation as enqueueInitiativeOperationImpl, _getInitiativeRoll as getInitiativeRollImpl, _applyGroupOrder as applyGroupOrderImpl, _shapeOrderEntry as shapeOrderEntryImpl, _sortOrderList as sortOrderListImpl, _buildNormalizedGroupUpdates as buildNormalizedGroupUpdatesImpl, _reconcileGroupInitiativeNow as reconcileGroupInitiativeNowImpl, _recalculateGroupIfReady as recalculateGroupIfReadyImpl } from "./group-initiative.js";
import { autoGroupCombatants as autoGroupCombatantsImpl, _getAutoGroupBucket as getAutoGroupBucketImpl, _getUniqueGroupName as getUniqueGroupNameImpl } from "./auto-group.js";
import { getPresets as getPresetsImpl, savePreset as savePresetImpl, updatePreset as updatePresetImpl, deletePreset as deletePresetImpl } from "./group-presets.js";
export { UNGROUPED, INITIATIVE_UPDATE_OPTION } from "./group-contracts.js";

/* ------------------------------------------------------------------ */
/*  GroupManager                                                      */
/* ------------------------------------------------------------------ */

/**
 * Static class for managing group logic, initiative calculations, and batch updates.
 */
export class GroupManager {
  /**
   * Deprecated compatibility field. Initiative work is serialized per combat
   * by _initiativeQueues instead of being dropped behind a global mutex.
   */
  static _mutex = false;

  /**
   * Flag to indicate bulk roll is in progress (rollAll/rollNPC).
   * When true, individual updateCombatant hooks should skip finalization.
   * @type {boolean}
   */
  static _bulkRollInProgress = false;

  /** @type {Set<string>} */
  static _bulkRollCombats = new Set();

  /** @type {Map<string, Promise<unknown>>} */
  static _initiativeQueues = new Map();

  /** @type {Map<string, Promise<unknown>>} */
  static _pendingGroupFinalizations = new Map();

  /* ------------------------------------------------------------------ */
  /*  Delegating facade: implementations live in group-initiative.js,     */
  /*  auto-group.js and group-presets.js and run with this class as this */
  /* ------------------------------------------------------------------ */

  static setBulkRollInProgress(combat, active) {
    return setBulkRollInProgressImpl.call(this, combat, active);
  }

  static isBulkRollInProgress(combat) {
    return isBulkRollInProgressImpl.call(this, combat);
  }

  static _enqueueInitiativeOperation(combat, operation) {
    return enqueueInitiativeOperationImpl.call(this, combat, operation);
  }

  /**
   * Rolls initiative for all members of a group that haven't rolled yet.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} options
   * @param {"normal"|"advantage"|"disadvantage"} [options.mode="normal"]
   * @returns {Promise<unknown>}
   */
  static async rollGroupAndApplyInitiative(combat, groupId, { mode = "normal" } = {}) {
    return rollGroupAndApplyInitiativeImpl.call(this, combat, groupId, { mode });
  }

  /**
   * Checks if a group is fully rolled and applies averages/sorting.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} [options]
   * @param {boolean} [options.bypassMutex=false] - Deprecated compatibility argument; queued reconciliation always runs.
   * @returns {Promise<boolean>}
   */
  static async finalizeGroupInitiative(combat, groupId, _options = {}) {
    return finalizeGroupInitiativeImpl.call(this, combat, groupId, _options);
  }

  /**
   * Prepare an initiative roll using dnd5e's actor-aware roll builder when available.
   * @private
   */
  static _getInitiativeRoll(combatant, mode = "normal") {
    return getInitiativeRollImpl.call(this, combatant, mode);
  }

  /**
   * Calculate and persist a group aggregate without changing member rolls.
   * @private
   */
  static async _applyGroupOrder(combat, groupId, list, { sendSummary = false } = {}) {
    return applyGroupOrderImpl.call(this, combat, groupId, list, { sendSummary });
  }

  static _shapeOrderEntry(combatant) {
    return shapeOrderEntryImpl.call(this, combatant);
  }

  static _sortOrderList(list) {
    return sortOrderListImpl.call(this, list);
  }

  static _buildNormalizedGroupUpdates(combat, updatedGroupId = null, updatedBase = null, updatedOrder = null) {
    return buildNormalizedGroupUpdatesImpl.call(this, combat, updatedGroupId, updatedBase, updatedOrder);
  }

  /**
   * Automatically creates groups for combatants by actor or token disposition.
   * @param {Combat} combat
   * @param {Object} [options]
   * @param {Combatant[]} [options.combatants] - Subset to group; defaults to all combatants.
   * @param {"actor"|"disposition"} [options.groupBy="actor"]
   * @param {boolean} [options.includeGrouped=false] - Reassign combatants already in custom groups.
   * @param {boolean} [options.includeSingletons=false] - Create groups with only one member.
   * @returns {Promise<{groupsCreated: number, groupsDeleted: number, combatantsAssigned: number, skipped: number, groupIds: string[]}>}
   */
  static async autoGroupCombatants(combat, {
    combatants = null,
    groupBy = "actor",
    includeGrouped = false,
    includeSingletons = false,
  } = {}) {
    return autoGroupCombatantsImpl.call(this, combat, { combatants, groupBy, includeGrouped, includeSingletons });
  }

  static _getAutoGroupBucket(combatant, groupBy) {
    return getAutoGroupBucketImpl.call(this, combatant, groupBy);
  }

  static _getUniqueGroupName(baseName, existingNames) {
    return getUniqueGroupNameImpl.call(this, baseName, existingNames);
  }

  /**
   * Sets a manual squad score while retaining existing member rolls.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {number} value - The new base initiative value
   * @returns {Promise<void>}
   */
  static async setGroupInitiative(combat, groupId, value) {
    return setGroupInitiativeImpl.call(this, combat, groupId, value);
  }

  /**
   * Resets all member initiatives to null and clears the group initiative flag.
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {Promise<void>}
   */
  static async resetGroupInitiative(combat, groupId) {
    return resetGroupInitiativeImpl.call(this, combat, groupId);
  }

  /**
   * Reconcile finalized initiative state after membership changes.
   * @param {Combat} combat
   * @param {Iterable<string>} groupIds
   */
  static async reconcileGroupInitiatives(combat, groupIds) {
    return reconcileGroupInitiativesImpl.call(this, combat, groupIds);
  }

  static async _reconcileGroupInitiativeNow(combat, groupId, { sendSummary = false } = {}) {
    return reconcileGroupInitiativeNowImpl.call(this, combat, groupId, { sendSummary });
  }

  /**
   * Get all saved group presets.
   * @returns {Object<string, {name: string, img: string, color: string, initiativeMode: string, discipline: string, moraleTrigger: string}>}
   */
  static getPresets() {
    return getPresetsImpl.call(this);
  }

  /**
   * Save (or overwrite by name) a group preset.
   * @param {string} name - Preset display name
   * @param {Object} [data] - Group config: {img?, color?, initiativeMode?, discipline?, moraleTrigger?}
   * @returns {Promise<string|null>} The preset id, or null when not permitted
   */
  static async savePreset(name, data = {}) {
    return savePresetImpl.call(this, name, data);
  }

  /** @returns {Promise<string>} */
  static async updatePreset(presetId, data) {
    return updatePresetImpl.call(this, presetId, data);
  }

  /** @returns {Promise<boolean>} */
  static async skipGroupTurn(combat, groupId) {
    return skipGroupTurnImpl.call(this, combat, groupId);
  }

  /**
   * Delete a saved group preset.
   * @param {string} presetId
   * @returns {Promise<boolean>} True when a preset was removed
   */
  static async deletePreset(presetId) {
    return deletePresetImpl.call(this, presetId);
  }

  /**
   * Recalculate group ordering when the group already has a finalized initiative.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} [options]
   * @param {boolean} [options.sendSummary=false]
   * @returns {Promise<boolean>}
   * @private
   */
  static async _recalculateGroupIfReady(combat, groupId, { sendSummary = false } = {}) {
    return recalculateGroupIfReadyImpl.call(this, combat, groupId, { sendSummary });
  }

  /** Remove temporary flags left by pre-14.1 interrupted roll operations. */
  static async clearLegacySkipFinalizeFlags() {
    if (!isMutationAuthority()) return 0;
    let cleared = 0;
    for (const combat of game.combats ?? []) {
      const stale = combat.getFlag(MODULE_ID, "skipFinalize") ?? {};
      if (!stale || typeof stale !== "object" || !Object.keys(stale).length) continue;
      await updateCombatState(combat, { [`flags.${MODULE_ID}.skipFinalize`]: new foundry.data.operators.ForcedDeletion() });
      cleared += 1;
    }
    return cleared;
  }

  /**
   * Organizes combatants into a Map keyed by their group ID.
   * @param {Combatant[]} combatants
   * @param {Combat} combat
   * @returns {Map<string, {name: string, members: Combatant[]}>}
   */
  static getGroups(combatants, combat) {
    const stored = combat.getFlag(MODULE_ID, "groups") ?? {};
    const map = new Map();

    for (const c of combatants) {
      const id = c.getFlag(MODULE_ID, "groupId") ?? UNGROUPED;
      if (!map.has(id)) {
        const groupData = stored[id] ?? {};
        map.set(id, { name: groupData.name ?? unnamedGroup(), members: [] });
      }
      map.get(id).members.push(c);
    }

    for (const [gid, data] of Object.entries(stored)) {
      if (!map.has(gid) && gid !== UNGROUPED) {
        map.set(gid, { name: data.name ?? unnamedGroup(), members: [] });
      }
    }

    // Only log in verbose mode - this gets called frequently
    logger.trace("Grouped combatants by ID", { fn: "getGroups", data: map });

    return map;
  }

  /**
   * Deletes a group and unassigns all its members.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} options
   * @returns {Promise<boolean>}
   */
  static async deleteGroup(combat, groupId, { confirm = true, groupName = null } = {}) {
    const log = logger.fn("deleteGroup");

    if (!combat || !groupId) {
      ui.notifications.warn(game.i18n.localize("SCI.Notifications.GroupUnresolved"));
      return false;
    }

    if (!isGM()) {
      log.warn("Non-GM attempted to delete group");
      return false;
    }

    const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const displayName = groupName ?? meta.name ?? unnamedGroup();

    log.debug(`Attempting to delete group "${displayName}"`, { groupId });

    if (confirm) {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.format("SCI.Dialog.DeleteTitle", { name: displayName }) },
        content: `<p>${game.i18n.localize("SCI.Dialog.DeleteContent")}</p>`,
      });
      if (!ok) {
        log.trace("User cancelled deletion");
        return false;
      }
    }

    try {
      const members = combat.combatants.filter(
        (c) => c.getFlag(MODULE_ID, "groupId") === groupId
      );

      await MoraleManager._local.clearMorale(combat, groupId);
      if (members.length) {
        await updateMembers(combat,
          members.map((c) => ({
            _id: c.id,
            [`flags.${MODULE_ID}.groupId`]: new foundry.data.operators.ForcedDeletion(),
            [`flags.${MODULE_ID}.rawInitiative`]: new foundry.data.operators.ForcedDeletion(),
          }))
        );
      }
      await updateCombatState(combat, { [`flags.${MODULE_ID}.groups.${groupId}`]: new foundry.data.operators.ForcedDeletion() });
      expandStore.setExpanded(combat.id, groupId, false);
      log.success(`Deleted group "${displayName}"`, { memberCount: members.length });
      return true;
    } catch (err) {
      log.errorNotify(game.i18n.format("SCI.Errors.DeleteGroup", { name: displayName }), err);
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Public API Methods                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Creates a new group on the given combat, optionally adding tokens.
   * @param {Combat} combat - The Combat document
   * @param {Object} data - Group metadata
   * @param {string} data.name - Group display name (required)
   * @param {string} [data.img] - Icon path
   * @param {string} [data.color] - Hex color
   * @param {boolean} [data.hidden] - Start hidden from players
   * @param {boolean} [data.pinned] - Pin the group (overrides default setting)
   * @param {Token[]|string[]} [tokens=[]] - Token placeables or token IDs to add
   * @returns {Promise<string|null>} The new groupId, or null on failure
   */
  static async createGroup(combat, data, tokens = []) {
    const log = logger.fn("createGroup");

    if (!isGM()) {
      log.warn("Non-GM attempted to create group");
      return null;
    }
    if (!combat) throw new Error("combat is required");
    data = normalizeGroupConfig(data, { partial: false });

    const groupId = generateGroupId();
    const startHidden = data.hidden === true;
    const groupImg = sanitizeImagePath(data.img, "icons/svg/combat.svg");
    const groupColor = sanitizeColor(data.color, "#00ff00");

    // Resolve tokens — accept Token placeables or string IDs
    const resolvedTokens = tokens.map((t) => {
      if (typeof t === "string") return combat.scene?.tokens.get(t);
      return t.document ?? t;
    }).filter(Boolean);

    if (resolvedTokens.some(t => t.parent?.id !== combat.scene?.id)) {
      throw new Error(game.i18n.localize("SCI.Errors.CrossCombatDrop"));
    }
    assertSeparateGroups(resolvedTokens.map(t => combat.combatants.find(c => c.tokenId === t.id)).filter(Boolean));

    await setCombatFlag(combat, `groups.${groupId}`, {
      name: data.name,
      initiative: null,
      pinned: data.pinned ?? game.settings.get(MODULE_ID, "defaultGroupPinned"),
      img: groupImg,
      color: groupColor,
      hidden: startHidden,
      discipline: data.discipline || "standard",
      mobConfidenceDivisor: data.mobConfidenceDivisor ?? null,
      startingSize: null,
      deletedCount: 0,
      initiativeMode: data.initiativeMode || game.settings.get(MODULE_ID, "defaultInitiativeMode"),
      captainId: null,
      moraleTrigger: data.moraleTrigger || MORALE_TRIGGER.BOTH,
    });

    const newCombatants = [];
    if (resolvedTokens.length) {
      const maxSort = Math.max(0, ...combat.combatants.map((c) => c.sort ?? 0));

      // Tokens not yet in combat → create combatants with groupId baked in
      const missingTokens = resolvedTokens.filter(
        (t) => !combat.combatants.some((c) => c.tokenId === t.id)
      );
      if (missingTokens.length) {
        const createData = missingTokens.map((t, i) => ({
          tokenId: t.id,
          actorId: t.actor?.id,
          sceneId: combat.scene.id,
          sort: maxSort + (i + 1) * CONSTANTS.SORT_INCREMENT,
          hidden: startHidden,
          [`flags.${MODULE_ID}.groupId`]: groupId,
        }));
        assertMutationAuthority();
        const created = await combat.createEmbeddedDocuments("Combatant", createData, { sciGroupInitiative: true, turnEvents: false, sciActiveCombatantId: combat.current?.combatantId });
        newCombatants.push(...created);
      }

      // Existing combatants already in combat → update their groupId
      const existingMembers = resolvedTokens
        .map((t) => combat.combatants.find((c) => c.tokenId === t.id))
        .filter(Boolean)
        .filter((c) => !newCombatants.some((nc) => nc.id === c.id));

      if (existingMembers.length) {
        await this._local.moveCombatants(combat, groupId, existingMembers.map((combatant) => combatant.id));
        if (startHidden) {
          await updateMembers(combat,
            existingMembers.map((combatant) => ({ _id: combatant.id, hidden: true }))
          );
        }
      }

      if (startHidden && game.settings.get(MODULE_ID, "visibilitySyncMode") === VISIBILITY_SYNC_MODE.BIDIRECTIONAL) {
        const tokenUpdates = resolvedTokens
          .map((t) => t.document ?? t)
          .filter((t) => t?.id)
          .map((t) => ({ _id: t.id, hidden: true }));

        if (tokenUpdates.length && combat.scene) {
          const groupedMembers = [...newCombatants, ...existingMembers];
          groupedMembers.forEach((c) => visibilitySyncInProgress.add(c.id));
          try {
            assertMutationAuthority();
            await combat.scene.updateEmbeddedDocuments("Token", tokenUpdates);
          } finally {
            groupedMembers.forEach((c) => visibilitySyncInProgress.delete(c.id));
          }
        }
      }
    }

    // Resolve captain after members are assigned
    if (data.captainId) {
      const allMembers = combat.combatants.filter(
        (c) => c.getFlag(MODULE_ID, "groupId") === groupId
      );
      if (data.captainId === "__random__") {
        if (allMembers.length > 0) {
          const pick = allMembers[Math.floor(Math.random() * allMembers.length)];
          await setCombatFlag(combat, `groups.${groupId}.captainId`, pick.id);
          log.debug(`Randomly assigned captain "${pick.name}" for group "${data.name}"`);
        }
      } else {
        // captainId may be a token ID (from create dialog) — resolve to combatant ID
        const byTokenId = allMembers.find((c) => c.tokenId === data.captainId);
        const byCombatantId = allMembers.find((c) => c.id === data.captainId);
        const captain = byTokenId || byCombatantId;
        if (captain) {
          await setCombatFlag(combat, `groups.${groupId}.captainId`, captain.id);
          log.debug(`Set captain "${captain.name}" for group "${data.name}"`);
        }
      }
    }

    // Record starting size immediately if combat is already active
    if (combat.round >= 1) {
      const memberCount = resolvedTokens.length || combat.combatants.filter(
        (c) => c.getFlag(MODULE_ID, "groupId") === groupId
      ).length;
      if (memberCount > 0) {
        await setCombatFlag(combat, `groups.${groupId}.startingSize`, memberCount);
      }
    }

    await this._local.reconcileGroupInitiatives(combat, [groupId]);

    // Update UI expand state
    const expandedSet = expandStore.load(combat.id);
    expandedSet.add(groupId);
    expandStore.save(combat.id, expandedSet);

    log.success(`Created group "${data.name}"`, { groupId, members: resolvedTokens.length });
    return groupId;
  }

  /**
   * Updates group metadata fields (name, icon, color).
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} data - Partial update: {name?, img?, color?}
   * @returns {Promise<void>}
   */
  static async editGroup(combat, groupId, data = {}) {
    const log = logger.fn("editGroup");

    if (!isGM()) {
      log.warn("Non-GM attempted to edit group");
      return;
    }
    if (!combat || !groupId) throw new Error("combat and groupId are required");

    const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
    if (!group) {
      ui.notifications.warn(game.i18n.localize("SCI.Notifications.GroupDataMissing"));
      return;
    }

    data = normalizeGroupConfig(data, { combat, groupId });
    if (data.hidden !== undefined && data.hidden !== !!group.hidden) await this._local.toggleGroupVisibility(combat, groupId);
    const updateObj = {};
    if (data.name !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.name`] = data.name;
    if (data.img !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.img`] = sanitizeImagePath(data.img, "icons/svg/combat.svg");
    if (data.color !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.color`] = sanitizeColor(data.color, group.color ?? "#ffffff");
    if (data.pinned !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.pinned`] = data.pinned;
    if (data.discipline !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.discipline`] = data.discipline;
    if (data.mobConfidenceDivisor !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.mobConfidenceDivisor`] = data.mobConfidenceDivisor;
    if (data.initiativeMode !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.initiativeMode`] = data.initiativeMode;
    if (data.captainId !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.captainId`] = data.captainId;
    if (data.moraleTrigger !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.moraleTrigger`] = data.moraleTrigger;

    const modeChanged = data.initiativeMode !== undefined && data.initiativeMode !== group.initiativeMode;
    const captainChanged = data.captainId !== undefined && data.captainId !== group.captainId;

    if (Object.keys(updateObj).length) {
      await updateCombatState(combat, updateObj);
      log.debug(`Edited group "${data.name ?? group.name}"`, { groupId });
    }

    // Auto-recalculate if initiative mode changed and group already has initiative
    if (modeChanged || captainChanged) {
      await this._recalculateGroupIfReady(combat, groupId, { sendSummary: false });
      log.debug("Recalculated group initiative after metadata change", { groupId });
    }
  }

  /**
   * Toggles the hidden state of a group and all its members.
   * Respects the visibilitySyncMode setting for canvas token updates.
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {Promise<boolean|null>} The new hidden state, or null on failure
   */
  static async toggleGroupVisibility(combat, groupId) {
    const log = logger.fn("toggleGroupVisibility");

    if (!isGM()) {
      log.warn("Non-GM attempted to toggle group visibility");
      return null;
    }

    const groupCfg = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const members = combat.combatants.filter(
      (c) => c.getFlag(MODULE_ID, "groupId") === groupId
    );
    const newHidden = !groupCfg.hidden;
    const syncMode = game.settings.get(MODULE_ID, "visibilitySyncMode");

    const syncTokens = syncMode === VISIBILITY_SYNC_MODE.BIDIRECTIONAL;
    if (syncTokens) members.forEach((c) => visibilitySyncInProgress.add(c.id));
    try {
      // Tracker state is authoritative. Commit it first so a token update
      // failure cannot leave the group's own visibility flag stale.
      await updateCombatState(combat, { [`flags.${MODULE_ID}.groups.${groupId}.hidden`]: newHidden });
      await updateMembers(combat,
        members.map((c) => ({ _id: c.id, hidden: newHidden }))
      );

      if (syncTokens) {
        const tokenUpdates = members
          .map((c) => c.token)
          .filter(Boolean)
          .map((t) => ({ _id: t.id, hidden: newHidden }));
        const scene = combat.scene;
        if (tokenUpdates.length && scene) {
          try {
            assertMutationAuthority();
            await scene.updateEmbeddedDocuments("Token", tokenUpdates);
          } catch (err) {
            log.warn("Tracker visibility changed, but one or more token updates failed", err);
          }
        }
      }
    } finally {
      if (syncTokens) members.forEach((c) => visibilitySyncInProgress.delete(c.id));
    }

    const groupName = groupCfg.name ?? unnamedGroup();
    log.trace(`${newHidden ? "Hid" : "Showed"} group "${groupName}" (syncMode: ${syncMode})`);
    return newHidden;
  }

  /**
   * Atomically move combatants and reconcile both their old and new groups.
   * A null target removes the custom group assignment.
   * @param {Combat} combat
   * @param {string|null} targetGroupId
   * @param {string[]} combatantIds
   */
  static async moveCombatants(combat, targetGroupId, combatantIds) {
    const log = logger.fn("moveCombatants");
    if (!isGM()) {
      log.warn("Non-GM attempted to move combatants");
      return false;
    }
    if (!combat || !combatantIds?.length) return false;
    if (targetGroupId) assertSeparateGroups(combatantIds.map(id => combat.combatants.get(id)).filter(Boolean));
    if (targetGroupId && !combat.getFlag(MODULE_ID, `groups.${targetGroupId}`)) {
      ui.notifications.warn(game.i18n.localize("SCI.Notifications.TargetGroupMissing"));
      return false;
    }

    return this._enqueueInitiativeOperation(combat, async () => {
      const combatants = [...new Set(combatantIds)]
        .map((id) => combat.combatants.get(id))
        .filter(Boolean);
      if (!combatants.length) return false;

      if (targetGroupId && !combat.getFlag(MODULE_ID, `groups.${targetGroupId}`)) {
        throw new Error(game.i18n.localize("SCI.Notifications.TargetGroupMissing"));
      }
      const affectedGroups = new Set(targetGroupId ? [targetGroupId] : []);
      const combatUpdate = {};
      for (const combatant of combatants) {
        const sourceGroupId = combatant.getFlag(MODULE_ID, "groupId");
        if (sourceGroupId !== targetGroupId && sourceGroupId && sourceGroupId !== UNGROUPED) {
          await MoraleManager._local.clearMorale(combat, sourceGroupId, combatant.id);
          const oldSize = combat.getFlag(MODULE_ID, `groups.${sourceGroupId}.startingSize`);
          if (Number.isFinite(oldSize)) combatUpdate[`flags.${MODULE_ID}.groups.${sourceGroupId}.startingSize`] =
            Math.max(0, (combatUpdate[`flags.${MODULE_ID}.groups.${sourceGroupId}.startingSize`] ?? oldSize) - 1);
        }
        if (sourceGroupId !== targetGroupId && targetGroupId) {
          const newSize = combat.getFlag(MODULE_ID, `groups.${targetGroupId}.startingSize`);
          if (Number.isFinite(newSize)) combatUpdate[`flags.${MODULE_ID}.groups.${targetGroupId}.startingSize`] =
            (combatUpdate[`flags.${MODULE_ID}.groups.${targetGroupId}.startingSize`] ?? newSize) + 1;
        }
        if (sourceGroupId && sourceGroupId !== UNGROUPED && sourceGroupId !== targetGroupId) {
          affectedGroups.add(sourceGroupId);
          const sourceMeta = combat.getFlag(MODULE_ID, `groups.${sourceGroupId}`) ?? {};
          if (sourceMeta.captainId === combatant.id) {
            combatUpdate[`flags.${MODULE_ID}.groups.${sourceGroupId}.captainId`] = null;
          }
        }
      }

      if (Object.keys(combatUpdate).length) await updateCombatState(combat, combatUpdate);
      await updateMembers(combat, combatants.map((combatant) => ({
        _id: combatant.id,
        ...(targetGroupId
          ? { [`flags.${MODULE_ID}.groupId`]: targetGroupId }
          : {
              [`flags.${MODULE_ID}.groupId`]: new foundry.data.operators.ForcedDeletion(),
              [`flags.${MODULE_ID}.rawInitiative`]: new foundry.data.operators.ForcedDeletion(),
            }),
      })));

      for (const groupId of affectedGroups) {
        await this._reconcileGroupInitiativeNow(combat, groupId);
      }
      log.debug("Moved combatants and reconciled initiative", {
        targetGroupId,
        combatantIds: combatants.map((combatant) => combatant.id),
        affectedGroups: [...affectedGroups],
      });
      return true;
    });
  }

  /**
   * Assigns existing combatants to a group.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {string[]} combatantIds - Array of combatant document IDs
   * @returns {Promise<void>}
   */
  static async addCombatantsToGroup(combat, groupId, combatantIds) {
    const log = logger.fn("addCombatantsToGroup");

    if (!isGM()) {
      log.warn("Non-GM attempted to add combatants to group");
      return;
    }
    if (!combat || !groupId || !combatantIds?.length) return;

    const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
    if (!group) {
      ui.notifications.warn(game.i18n.localize("SCI.Notifications.TargetGroupMissing"));
      return;
    }

    const moved = await this._local.moveCombatants(combat, groupId, combatantIds);
    if (moved) log.debug(`Added ${combatantIds.length} combatants to group "${group.name}"`, { groupId });
  }

  /**
   * Removes a combatant from its group (reverts to ungrouped).
   * Clears captain designation if the removed combatant was captain.
   * @param {Combat} combat
   * @param {string} combatantId
   * @returns {Promise<void>}
   */
  static async removeCombatantFromGroup(combat, combatantId) {
    const log = logger.fn("removeCombatantFromGroup");

    if (!isGM()) {
      log.warn("Non-GM attempted to remove combatant from group");
      return;
    }
    if (!combat || !combatantId) return;

    const combatant = combat.combatants.get(combatantId);
    if (!combatant) return;

    const moved = await this._local.moveCombatants(combat, null, [combatantId]);
    if (moved) log.debug(`Removed combatant "${combatant.name}" from group`);
  }

  /* ------------------------------------------------------------------ */
  /*  Captains                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Designates a combatant as the captain of its group.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {string} combatantId
   * @returns {Promise<void>}
   */
  static async setCaptain(combat, groupId, combatantId) {
    const log = logger.fn("setCaptain");

    if (!isGM()) {
      log.warn("Non-GM attempted to set captain");
      return;
    }
    if (!combat || !groupId || !combatantId) return;

    const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
    if (!group) return;

    const combatant = combat.combatants.get(combatantId);
    if (!combatant || combatant.getFlag(MODULE_ID, "groupId") !== groupId) {
      log.warn("Combatant does not belong to this group");
      return;
    }

    await setCombatFlag(combat, `groups.${groupId}.captainId`, combatantId);
    await this._recalculateGroupIfReady(combat, groupId, { sendSummary: false });
    log.debug(`Set captain of "${group.name}" to "${combatant.name}"`, { groupId, combatantId });
  }

  /**
   * Removes the captain designation from a group.
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {Promise<void>}
   */
  static async removeCaptain(combat, groupId) {
    const log = logger.fn("removeCaptain");

    if (!isGM()) {
      log.warn("Non-GM attempted to remove captain");
      return;
    }
    if (!combat || !groupId) return;

    await setCombatFlag(combat, `groups.${groupId}.captainId`, null);
    await this._recalculateGroupIfReady(combat, groupId, { sendSummary: false });
    log.debug(`Removed captain from group`, { groupId });
  }

}

registerCommandOwner("groups", GroupManager, {
  "skipGroupTurn": "combat",
  "updatePreset": "world",
  "rollGroupAndApplyInitiative": "combat",
  "finalizeGroupInitiative": "combat",
  "deleteGroup": "combat",
  "createGroup": "combat",
  "autoGroupCombatants": "combat",
  "editGroup": "combat",
  "setGroupInitiative": "combat",
  "resetGroupInitiative": "combat",
  "toggleGroupVisibility": "combat",
  "reconcileGroupInitiatives": "combat",
  "moveCombatants": "combat",
  "addCombatantsToGroup": "combat",
  "removeCombatantFromGroup": "combat",
  "savePreset": "world",
  "deletePreset": "world",
  "setCaptain": "combat",
  "removeCaptain": "combat"
});

// Confirmation belongs to the requesting client's UI, outside the authority queue.
const deleteGroupCommand = GroupManager.deleteGroup;
GroupManager.deleteGroup = async (combat, groupId, options = {}) => {
  if (!isGM()) return null;
  if (options.confirm !== false) {
    const name = options.groupName ?? combat?.getFlag(MODULE_ID, `groups.${groupId}.name`) ?? unnamedGroup();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.format("SCI.Dialog.DeleteTitle", { name }) },
      content: `<p>${game.i18n.localize("SCI.Dialog.DeleteContent")}</p>`,
    });
    if (!confirmed) return false;
  }
  return deleteGroupCommand(combat, groupId, { ...options, confirm: false });
};
