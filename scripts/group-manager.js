/**
 * @file group-manager.js
 * @description Core business logic for group management: CRUD, auto-grouping,
 *              initiative calculation and finalization, captains, and visibility.
 * @version Foundry V14+
 */

import {
  MODULE_ID,
  logger,
  isGM,
  CONSTANTS,
  INITIATIVE_MODE,
  MORALE_TRIGGER,
  calculateGroupInitiative,
  generateGroupId,
  expandStore,
  visibilitySyncInProgress,
  sanitizeColor,
  sanitizeImagePath,
  formatModifier,
  localizeEnumValue,
  unnamedGroup,
  TEMPLATES,
  renderModuleTemplate,
} from "./shared.js";
import { VISIBILITY_SYNC_MODE } from "./settings.js";
import { getRawInitiative } from "./initiative-ordering.js";

/**
 * Constant identifier for the default "ungrouped" bucket.
 * @type {string}
 */
export const UNGROUPED = "ungrouped";

/** Custom Document update option used to identify module-owned initiative writes. */
export const INITIATIVE_UPDATE_OPTION = "sciGroupInitiative";

const AUTO_GROUP_COLORS = Object.freeze([
  "#7b68ee",
  "#4caf50",
  "#ff9800",
  "#03a9f4",
  "#e91e63",
  "#8bc34a",
  "#f44336",
  "#9c27b0",
]);

const DISPOSITION_LABEL_KEYS = Object.freeze({
  [CONST.TOKEN_DISPOSITIONS.SECRET]: "SCI.Disposition.Secret",
  [CONST.TOKEN_DISPOSITIONS.HOSTILE]: "SCI.Disposition.Hostile",
  [CONST.TOKEN_DISPOSITIONS.NEUTRAL]: "SCI.Disposition.Neutral",
  [CONST.TOKEN_DISPOSITIONS.FRIENDLY]: "SCI.Disposition.Friendly",
});

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

  static setBulkRollInProgress(combat, active) {
    if (!combat?.id) return;
    if (active) this._bulkRollCombats.add(combat.id);
    else this._bulkRollCombats.delete(combat.id);
    this._bulkRollInProgress = this._bulkRollCombats.size > 0;
  }

  static isBulkRollInProgress(combat) {
    return !!combat?.id && this._bulkRollCombats.has(combat.id);
  }

  static _enqueueInitiativeOperation(combat, operation) {
    if (!combat?.id) return Promise.resolve().then(operation);
    const key = combat.id;
    const previous = this._initiativeQueues.get(key) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    const tracked = queued.finally(() => {
      if (this._initiativeQueues.get(key) === tracked) this._initiativeQueues.delete(key);
    });
    this._initiativeQueues.set(key, tracked);
    return tracked;
  }

  /** Remove temporary flags left by pre-14.1 interrupted roll operations. */
  static async clearLegacySkipFinalizeFlags() {
    if (!isGM()) return 0;
    let cleared = 0;
    for (const combat of game.combats ?? []) {
      const stale = combat.getFlag(MODULE_ID, "skipFinalize") ?? {};
      if (!stale || typeof stale !== "object" || !Object.keys(stale).length) continue;
      await combat.update({ [`flags.${MODULE_ID}.-=skipFinalize`]: null });
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
   * Rolls initiative for all members of a group that haven't rolled yet.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} options
   * @param {"normal"|"advantage"|"disadvantage"} [options.mode="normal"]
   */
  static async rollGroupAndApplyInitiative(combat, groupId, { mode = "normal" } = {}) {
    const log = logger.fn("rollGroupAndApplyInitiative");

    if (!isGM()) {
      log.warn("Non-GM attempted to roll group initiative");
      return;
    }

    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const groupName = groupMeta.name ?? unnamedGroup();

    const members = combat.combatants.filter(
      (c) => c.getFlag(MODULE_ID, "groupId") === groupId
    );
    const toRoll = members.filter((c) => c.initiative == null);

    if (!toRoll.length) {
      if (!Number.isFinite(groupMeta.initiative) && members.every((c) => Number.isFinite(getRawInitiative(c)))) {
        return this.finalizeGroupInitiative(combat, groupId);
      }
      return ui.notifications.info(game.i18n.format("SCI.Notifications.AlreadyRolled", { name: groupName }));
    }

    log.groupStart(`Rolling initiative for "${groupName}"`, {
      groupId,
      mode,
      memberCount: toRoll.length,
    });

    try {
      const rolledSummary = [];

      for (const c of toRoll) {
        const roll = this._getInitiativeRoll(c, mode);
        if (!roll) {
          log.warn(`Could not prepare initiative roll for ${c.name}`);
          continue;
        }
        await roll.evaluate();

        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor: c.actor, token: c.token, alias: c.name }),
          flavor: game.i18n.format("SCI.Chat.InitiativeFlavor", { name: c.name }),
          flags: { "core.initiativeRoll": true },
        }, { rollMode: CONST.DICE_ROLL_MODES.GMROLL });

        const dexValue = c.actor?.system?.abilities?.dex?.value ?? 10;
        rolledSummary.push({
          combatant: c,
          name: c.name,
          init: roll.total,
          dex: dexValue,
        });

        // Verbose: log each roll individually
        log.trace(`Rolled for ${c.name}`, { total: roll.total, dex: dexValue });
      }

      // Normal: single summary of all rolls
      log.debug("Rolled initiative for group", {
        rolls: rolledSummary.map(r => `${r.name}: ${r.init} (DEX ${r.dex})`),
      });

      if (!rolledSummary.length) {
        log.groupEnd("no rolls prepared");
        return;
      }

      await this._enqueueInitiativeOperation(combat, async () => {
        await combat.updateEmbeddedDocuments(
          "Combatant",
          rolledSummary.map((r) => ({ _id: r.combatant.id, initiative: r.init })),
          { [INITIATIVE_UPDATE_OPTION]: true }
        );

        // Combat5e performs initiative-period recovery after native tracker rolls.
        // Preserve that lifecycle for the module's actor-aware advantage rolls.
        if (typeof combat._recoverUses === "function") {
          for (const entry of rolledSummary) {
            await combat._recoverUses({ initiative: entry.combatant });
          }
        }

        const rolledById = new Map(rolledSummary.map((entry) => [entry.combatant.id, entry]));
        const completeSummary = members.map((combatant) => rolledById.get(combatant.id) ?? ({
          combatant,
          name: combatant.name,
          init: getRawInitiative(combatant),
          dex: combatant.actor?.system?.abilities?.dex?.value ?? 10,
        }));

        await this._applyGroupOrder(combat, groupId, completeSummary, { sendSummary: true });
      });

      log.groupEnd("success");
    } catch (err) {
      log.groupEnd("failed");
      log.errorNotify(game.i18n.format("SCI.Errors.RollGroup", { name: groupName }), err);
    }
  }

  /**
   * Checks if a group is fully rolled and applies averages/sorting.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} [options]
   * @param {boolean} [options.bypassMutex=false] - Skip mutex check (for batch operations)
   */
  static async finalizeGroupInitiative(combat, groupId) {
    if (!combat?.id || !groupId) return false;
    const key = `${combat.id}:${groupId}`;
    const pending = this._pendingGroupFinalizations.get(key);
    if (pending) return pending;

    const operation = this._enqueueInitiativeOperation(combat, async () => {
      const log = logger.fn("finalizeGroupInitiative");
      const members = combat.combatants.filter(
        (c) => c.getFlag(MODULE_ID, "groupId") === groupId
      );

      if (!members.length) {
        log.trace("No members found for group", { groupId });
        return false;
      }

      if (!members.every((c) => Number.isFinite(getRawInitiative(c)))) {
        log.trace("Not all members have initiative yet", {
          groupId,
          pending: members.filter(c => !Number.isFinite(getRawInitiative(c))).length,
        });
        return false;
      }

      log.debug("Finalizing group initiative", {
        groupId,
        memberCount: members.length,
      });

      const shaped = members.map((c) => ({
        combatant: c,
        name: c.name,
        init: getRawInitiative(c),
        dex: c.actor?.system?.abilities?.dex?.value ?? 10,
      }));

      await this._applyGroupOrder(combat, groupId, shaped, { sendSummary: true });
      log.success("Group initiative finalized", { groupId });
      return true;
    }).catch((err) => {
      logger.error("Error finalizing group initiative", err, { fn: "finalizeGroupInitiative", data: { groupId } });
      return false;
    });

    this._pendingGroupFinalizations.set(key, operation);
    return operation.finally(() => {
      if (this._pendingGroupFinalizations.get(key) === operation) {
        this._pendingGroupFinalizations.delete(key);
      }
    });
  }

  /**
   * Prepare an initiative roll using dnd5e's actor-aware roll builder when available.
   * @private
   */
  static _getInitiativeRoll(combatant, mode = "normal") {
    const advantage = mode === "advantage";
    const disadvantage = mode === "disadvantage";
    const rollOptions = {};
    if (advantage) rollOptions.advantage = true;
    if (disadvantage) rollOptions.disadvantage = true;

    if (combatant.actor && typeof combatant.actor.getInitiativeRoll === "function") {
      return combatant.actor.getInitiativeRoll(rollOptions);
    }

    if (!advantage && !disadvantage && typeof combatant.getInitiativeRoll === "function") {
      return combatant.getInitiativeRoll();
    }

    const dieExpr = advantage ? "2d20kh"
      : disadvantage ? "2d20kl"
        : "1d20";
    const dexMod = combatant.actor?.system?.abilities?.dex?.mod ?? 0;
    const formula = dexMod >= 0 ? `${dieExpr} + ${dexMod}` : `${dieExpr} - ${Math.abs(dexMod)}`;
    return new Roll(formula);
  }

  /**
   * Calculate and persist a group aggregate without changing member rolls.
   * @private
   */
  static async _applyGroupOrder(
    combat,
    groupId,
    list,
    { sendSummary = false } = {}
  ) {
    if (!isGM()) return;

    const log = logger.fn("_applyGroupOrder");
    const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const groupName = meta.name ?? unnamedGroup();

    this._sortOrderList(list);

    const mode = Object.values(INITIATIVE_MODE).includes(meta.initiativeMode)
      ? meta.initiativeMode
      : INITIATIVE_MODE.AVERAGE;
    let captainInit = null;
    if (mode === INITIATIVE_MODE.CAPTAIN && meta.captainId) {
      const captainEntry = list.find(r => r.combatant.id === meta.captainId);
      captainInit = captainEntry?.init ?? null;
    }
    const avgInit = calculateGroupInitiative(list.map(r => r.init), mode, captainInit);

    const memberDexMods = list.map(r => r.combatant.actor?.system?.abilities?.dex?.mod ?? 0);
    const avgDexMod = memberDexMods.length > 0
      ? (memberDexMods.reduce((a, b) => a + b, 0) / memberDexMods.length)
      : 0;

    log.debug("Calculated group order", {
      groupName,
      avgInit,
      memberOrder: list.map(r => `${r.name}: ${r.init}`),
    });

    try {
      await combat.updateEmbeddedDocuments("Combatant", list.map((entry) => ({
        _id: entry.combatant.id,
        [`flags.${MODULE_ID}.rawInitiative`]: entry.init,
      })), { [INITIATIVE_UPDATE_OPTION]: true });
      await combat.update({
        [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: avgInit,
        [`flags.${MODULE_ID}.groups.${groupId}.initiativeTiebreaker`]: avgDexMod,
      });
    } catch (err) {
      log.error(`Error applying group order for "${groupName}"`, err);
      throw err;
    }

    if (sendSummary) {
      try {
        const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

        // Compute summary stats
        const totalInit = list.reduce((sum, r) => sum + r.init, 0);
        const highRoll = Math.max(...list.map(r => r.init));
        const lowRoll = Math.min(...list.map(r => r.init));
        const content = await renderModuleTemplate(TEMPLATES.CHAT_INITIATIVE_SUMMARY, {
          groupColor: sanitizeColor(meta.color, "#7b68ee"),
          groupImg: sanitizeImagePath(meta.img, "icons/svg/combat.svg"),
          groupName,
          groupInit: avgInit,
          totalInit,
          highRoll,
          lowRoll,
          avgDexMod: formatModifier(Math.round(avgDexMod * 10) / 10),
          memberCount: list.length,
          modeLabel: localizeEnumValue("SCI.InitiativeModeName", mode),
          captainName: mode === INITIATIVE_MODE.CAPTAIN && meta.captainId
            ? (list.find(r => r.combatant.id === meta.captainId)?.name ?? game.i18n.localize("SCI.Unknown"))
            : null,
          rows: list.map((r) => ({
            img: sanitizeImagePath(r.combatant.img || r.combatant.token?.texture?.src || "", ""),
            name: r.name,
            init: r.init,
            dexMod: formatModifier(r.combatant.actor?.system?.abilities?.dex?.mod ?? 0),
          })),
        });

        await ChatMessage.create({
          content,
          whisper: gmIds,
          blind: true,
        });
      } catch (err) {
        log.warn("Failed to create chat summary", { error: err.message });
      }
    }

    log.success(`Applied group order for "${groupName}"`);
  }

  static _shapeOrderEntry(combatant) {
    return {
      combatant,
      name: combatant.name,
      init: getRawInitiative(combatant),
      dex: combatant.actor?.system?.abilities?.dex?.value ?? 10,
    };
  }

  static _sortOrderList(list) {
    list.sort((a, b) =>
      (b.init ?? -Infinity) - (a.init ?? -Infinity)
      || (b.dex ?? 0) - (a.dex ?? 0)
      || String(a.combatant?.id ?? "").localeCompare(String(b.combatant?.id ?? ""))
    );
    return list;
  }

  static _buildNormalizedGroupUpdates(combat, updatedGroupId = null, updatedBase = null, updatedOrder = null) {
    const allGroups = combat.getFlag(MODULE_ID, "groups") ?? {};
    const entries = [];

    for (const [gid, data] of Object.entries(allGroups)) {
      const members = combat.combatants.filter((c) => c.getFlag(MODULE_ID, "groupId") === gid);
      if (!members.length) continue;

      const base = gid === updatedGroupId ? updatedBase : data.initiative;
      if (!Number.isFinite(base)) continue;

      const order = gid === updatedGroupId && updatedOrder
        ? updatedOrder.map((entry) => ({ ...entry }))
        : members.map((combatant) => this._shapeOrderEntry(combatant));
      if (!order.length || order.some((entry) => !Number.isFinite(entry.init))) continue;

      this._sortOrderList(order);
      const avgDex = members.reduce((sum, c) => sum + (c.actor?.system?.abilities?.dex?.mod ?? 0), 0) / members.length;
      entries.push({ id: gid, initiative: base, avgDex, order });
    }

    entries.sort((a, b) => {
      if (b.initiative !== a.initiative) return b.initiative - a.initiative;
      if (b.avgDex !== a.avgDex) return b.avgDex - a.avgDex;
      return a.id.localeCompare(b.id);
    });

    // Retained for diagnostics/API compatibility. Ordering is now supplied by
    // the Combat comparator wrapper, so normalization never writes documents.
    return { updates: [], entries };
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

      if (members.length) {
        await combat.updateEmbeddedDocuments(
          "Combatant",
          members.map((c) => ({
            _id: c.id,
            [`flags.${MODULE_ID}.-=groupId`]: null,
            [`flags.${MODULE_ID}.-=rawInitiative`]: null,
          }))
        );
      }
      await combat.update({ [`flags.${MODULE_ID}.groups.-=${groupId}`]: null });
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
    if (!data?.name) throw new Error("data.name is required");

    const groupId = generateGroupId();
    const startHidden = data.hidden === true;
    const groupImg = sanitizeImagePath(data.img, "icons/svg/combat.svg");
    const groupColor = sanitizeColor(data.color, "#00ff00");

    await combat.setFlag(MODULE_ID, `groups.${groupId}`, {
      name: data.name,
      initiative: null,
      pinned: data.pinned ?? game.settings.get(MODULE_ID, "defaultGroupPinned"),
      img: groupImg,
      color: groupColor,
      hidden: startHidden,
      discipline: data.discipline || "standard",
      startingSize: null,
      deletedCount: 0,
      initiativeMode: data.initiativeMode || game.settings.get(MODULE_ID, "defaultInitiativeMode"),
      captainId: (data.captainId && data.captainId !== "__random__") ? data.captainId : null,
      moraleTrigger: data.moraleTrigger || MORALE_TRIGGER.BOTH,
    });

    // Resolve tokens — accept Token placeables or string IDs
    const resolvedTokens = tokens.map((t) => {
      if (typeof t === "string") return canvas.tokens.get(t);
      return t;
    }).filter(Boolean);

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
          sceneId: canvas.scene.id,
          sort: maxSort + (i + 1) * CONSTANTS.SORT_INCREMENT,
          hidden: startHidden,
          [`flags.${MODULE_ID}.groupId`]: groupId,
        }));
        const created = await combat.createEmbeddedDocuments("Combatant", createData);
        newCombatants.push(...created);
      }

      // Existing combatants already in combat → update their groupId
      const existingMembers = resolvedTokens
        .map((t) => combat.combatants.find((c) => c.tokenId === t.id))
        .filter(Boolean)
        .filter((c) => !newCombatants.some((nc) => nc.id === c.id));

      if (existingMembers.length) {
        await this.moveCombatants(combat, groupId, existingMembers.map((combatant) => combatant.id));
        if (startHidden) {
          await combat.updateEmbeddedDocuments("Combatant",
            existingMembers.map((combatant) => ({ _id: combatant.id, hidden: true }))
          );
        }
      }

      if (startHidden && game.settings.get(MODULE_ID, "visibilitySyncMode") === VISIBILITY_SYNC_MODE.BIDIRECTIONAL) {
        const tokenUpdates = resolvedTokens
          .map((t) => t.document ?? t)
          .filter((t) => t?.id)
          .map((t) => ({ _id: t.id, hidden: true }));

        if (tokenUpdates.length && canvas.scene) {
          const groupedMembers = [...newCombatants, ...existingMembers];
          groupedMembers.forEach((c) => visibilitySyncInProgress.add(c.id));
          try {
            await canvas.scene.updateEmbeddedDocuments("Token", tokenUpdates);
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
          await combat.setFlag(MODULE_ID, `groups.${groupId}.captainId`, pick.id);
          log.debug(`Randomly assigned captain "${pick.name}" for group "${data.name}"`);
        }
      } else {
        // captainId may be a token ID (from create dialog) — resolve to combatant ID
        const byTokenId = allMembers.find((c) => c.tokenId === data.captainId);
        const byCombatantId = allMembers.find((c) => c.id === data.captainId);
        const captain = byTokenId || byCombatantId;
        if (captain) {
          await combat.setFlag(MODULE_ID, `groups.${groupId}.captainId`, captain.id);
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
        await combat.setFlag(MODULE_ID, `groups.${groupId}.startingSize`, memberCount);
      }
    }

    await this.reconcileGroupInitiatives(combat, [groupId]);

    // Update UI expand state
    const expandedSet = expandStore.load(combat.id);
    expandedSet.add(groupId);
    expandStore.save(combat.id, expandedSet);

    log.success(`Created group "${data.name}"`, { groupId, members: resolvedTokens.length });
    return groupId;
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
    const log = logger.fn("autoGroupCombatants");

    if (!isGM()) {
      log.warn("Non-GM attempted to auto-group combatants");
      return { groupsCreated: 0, groupsDeleted: 0, combatantsAssigned: 0, skipped: 0, groupIds: [] };
    }
    if (!combat) throw new Error("combat is required");

    const source = Array.from(combatants ?? combat.combatants).filter((c) => c?.actor);
    const candidates = includeGrouped
      ? source
      : source.filter((c) => {
          const groupId = c.getFlag(MODULE_ID, "groupId");
          return !groupId || groupId === UNGROUPED;
        });

    const buckets = new Map();
    for (const combatant of candidates) {
      const bucket = this._getAutoGroupBucket(combatant, groupBy);
      if (!bucket) continue;
      if (!buckets.has(bucket.key)) {
        buckets.set(bucket.key, { ...bucket, members: [] });
      }
      buckets.get(bucket.key).members.push(combatant);
    }

    const groups = Array.from(buckets.values())
      .filter((bucket) => includeSingletons || bucket.members.length > 1)
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    if (!groups.length) {
      return {
        groupsCreated: 0,
        groupsDeleted: 0,
        combatantsAssigned: 0,
        skipped: source.length - candidates.length,
        groupIds: [],
      };
    }

    const existingNames = new Set(
      Object.values(combat.getFlag(MODULE_ID, "groups") ?? {})
        .map((group) => group?.name)
        .filter(Boolean)
    );
    const expandedSet = expandStore.load(combat.id);
    const groupIds = [];
    const updateData = {};
    const combatantUpdates = [];
    const captainClearGroupIds = new Set();
    const oldGroupIds = new Set();
    const reassignedCombatantIds = new Set();

    groups.forEach((bucket, index) => {
      const groupId = generateGroupId();
      const groupName = this._getUniqueGroupName(bucket.name, existingNames);
      const hidden = bucket.members.every((c) => c.hidden);

      groupIds.push(groupId);
      expandedSet.add(groupId);

      updateData[`flags.${MODULE_ID}.groups.${groupId}`] = {
        name: groupName,
        initiative: null,
        pinned: game.settings.get(MODULE_ID, "defaultGroupPinned"),
        img: bucket.img || "icons/svg/combat.svg",
        color: AUTO_GROUP_COLORS[index % AUTO_GROUP_COLORS.length],
        hidden,
        discipline: "standard",
        startingSize: combat.round >= 1 ? bucket.members.length : null,
        deletedCount: 0,
        initiativeMode: game.settings.get(MODULE_ID, "defaultInitiativeMode"),
        captainId: null,
        moraleTrigger: MORALE_TRIGGER.BOTH,
      };

      for (const combatant of bucket.members) {
        const oldGroupId = combatant.getFlag(MODULE_ID, "groupId");
        if (includeGrouped && oldGroupId && oldGroupId !== UNGROUPED) {
          oldGroupIds.add(oldGroupId);
          const oldMeta = combat.getFlag(MODULE_ID, `groups.${oldGroupId}`) ?? {};
          if (oldMeta.captainId === combatant.id) {
            captainClearGroupIds.add(oldGroupId);
          }
        }
        reassignedCombatantIds.add(combatant.id);
        combatantUpdates.push({
          _id: combatant.id,
          [`flags.${MODULE_ID}.groupId`]: groupId,
        });
      }
    });

    const deletedOldGroupIds = new Set();
    if (includeGrouped) {
      for (const oldGroupId of oldGroupIds) {
        const remaining = combat.combatants.filter((combatant) => {
          if (reassignedCombatantIds.has(combatant.id)) return false;
          return combatant.getFlag(MODULE_ID, "groupId") === oldGroupId;
        });
        if (!remaining.length) {
          updateData[`flags.${MODULE_ID}.groups.-=${oldGroupId}`] = null;
          deletedOldGroupIds.add(oldGroupId);
        }
      }

      for (const oldGroupId of captainClearGroupIds) {
        if (!deletedOldGroupIds.has(oldGroupId)) {
          updateData[`flags.${MODULE_ID}.groups.${oldGroupId}.captainId`] = null;
        }
      }
    }

    await combat.update(updateData);
    await combat.updateEmbeddedDocuments("Combatant", combatantUpdates);
    await this.reconcileGroupInitiatives(combat, [
      ...groupIds,
      ...[...oldGroupIds].filter((groupId) => !deletedOldGroupIds.has(groupId)),
    ]);
    expandStore.save(combat.id, expandedSet);

    const result = {
      groupsCreated: groupIds.length,
      groupsDeleted: deletedOldGroupIds.size,
      combatantsAssigned: combatantUpdates.length,
      skipped: source.length - candidates.length,
      groupIds,
    };
    log.debug("Auto-grouped combatants", result);
    return result;
  }

  static _getAutoGroupBucket(combatant, groupBy) {
    if (groupBy === "disposition") {
      const disposition = combatant.token?.disposition ?? CONST.TOKEN_DISPOSITIONS.NEUTRAL;
      const labelKey = DISPOSITION_LABEL_KEYS[disposition];
      return {
        key: `disposition:${disposition}`,
        name: labelKey
          ? game.i18n.localize(labelKey)
          : game.i18n.format("SCI.Disposition.Other", { disposition }),
        img: "icons/svg/mystery-man.svg",
      };
    }

    const actor = combatant.token?.baseActor ?? combatant.actor;
    const actorId = actor?.id ?? combatant.actorId ?? combatant.name;
    const actorName = actor?.name ?? combatant.actor?.name ?? combatant.name ?? game.i18n.localize("SCI.UnknownActor");
    return {
      key: `actor:${actorId}`,
      name: actorName,
      img: combatant.img || actor?.img || combatant.actor?.img || "icons/svg/mystery-man.svg",
    };
  }

  static _getUniqueGroupName(baseName, existingNames) {
    const name = baseName || game.i18n.localize("SCI.AutoGroupFallbackName");
    if (!existingNames.has(name)) {
      existingNames.add(name);
      return name;
    }

    let i = 2;
    let candidate = `${name} ${i}`;
    while (existingNames.has(candidate)) {
      i += 1;
      candidate = `${name} ${i}`;
    }
    existingNames.add(candidate);
    return candidate;
  }

  /**
   * Updates group metadata fields (name, icon, color).
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} data - Partial update: {name?, img?, color?}
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

    const updateObj = {};
    if (data.name !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.name`] = data.name;
    if (data.img !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.img`] = sanitizeImagePath(data.img, "icons/svg/combat.svg");
    if (data.color !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.color`] = sanitizeColor(data.color, group.color ?? "#ffffff");
    if (data.discipline !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.discipline`] = data.discipline;
    if (data.mobConfidenceDivisor !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.mobConfidenceDivisor`] = data.mobConfidenceDivisor;
    if (data.initiativeMode !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.initiativeMode`] = data.initiativeMode;
    if (data.captainId !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.captainId`] = data.captainId;
    if (data.moraleTrigger !== undefined) updateObj[`flags.${MODULE_ID}.groups.${groupId}.moraleTrigger`] = data.moraleTrigger;

    const modeChanged = data.initiativeMode !== undefined && data.initiativeMode !== group.initiativeMode;
    const captainChanged = data.captainId !== undefined && data.captainId !== group.captainId;

    if (Object.keys(updateObj).length) {
      await combat.update(updateObj);
      log.debug(`Edited group "${data.name ?? group.name}"`, { groupId });
    }

    // Auto-recalculate if initiative mode changed and group already has initiative
    if ((modeChanged || captainChanged) && group.initiative != null) {
      await this._recalculateGroupIfReady(combat, groupId, { sendSummary: false });
      log.debug("Recalculated group initiative after metadata change", { groupId });
    }
  }

  /**
   * Sets a group's initiative to a specific value, preserving relative member offsets.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {number} value - The new base initiative value
   */
  static async setGroupInitiative(combat, groupId, value) {
    const log = logger.fn("setGroupInitiative");

    if (!isGM()) {
      log.warn("Non-GM attempted to set group initiative");
      return;
    }
    if (!Number.isFinite(value)) {
      ui.notifications.warn(game.i18n.localize("SCI.Notifications.InvalidInitiative"));
      return;
    }

    const members = combat.combatants.filter(
      (c) => c.getFlag(MODULE_ID, "groupId") === groupId
    );
    if (!members.length) return;

    const avgDexMod = members.reduce(
      (sum, combatant) => sum + (combatant.actor?.system?.abilities?.dex?.mod ?? 0),
      0
    ) / members.length;

    await this._enqueueInitiativeOperation(combat, async () => {
      await combat.updateEmbeddedDocuments("Combatant", members.map((combatant) => {
        const raw = getRawInitiative(combatant) ?? value;
        return {
          _id: combatant.id,
          ...(!Number.isFinite(combatant.initiative) ? { initiative: raw } : {}),
          [`flags.${MODULE_ID}.rawInitiative`]: raw,
        };
      }), { [INITIATIVE_UPDATE_OPTION]: true });
      await combat.update({
        [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: value,
        [`flags.${MODULE_ID}.groups.${groupId}.initiativeTiebreaker`]: avgDexMod,
      });
    });

    const groupName = combat.getFlag(MODULE_ID, `groups.${groupId}`)?.name ?? unnamedGroup();
    log.debug(`Set group initiative to ${value}`, { groupId, groupName });
  }

  /**
   * Resets all member initiatives to null and clears the group initiative flag.
   * @param {Combat} combat
   * @param {string} groupId
   */
  static async resetGroupInitiative(combat, groupId) {
    const log = logger.fn("resetGroupInitiative");

    if (!isGM()) {
      log.warn("Non-GM attempted to reset group initiative");
      return;
    }

    const members = combat.combatants.filter(
      (c) => c.getFlag(MODULE_ID, "groupId") === groupId
    );

    const updates = members.map((c) => ({
      _id: c.id,
      initiative: null,
      [`flags.${MODULE_ID}.-=rawInitiative`]: null,
    }));

    await this._enqueueInitiativeOperation(combat, async () => {
      await combat.updateEmbeddedDocuments(
        "Combatant",
        updates,
        { [INITIATIVE_UPDATE_OPTION]: true }
      );
      await combat.update({
        [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: null,
        [`flags.${MODULE_ID}.groups.${groupId}.initiativeTiebreaker`]: null,
      });
    });

    const groupName = combat.getFlag(MODULE_ID, `groups.${groupId}`)?.name ?? unnamedGroup();
    log.debug(`Reset initiative for "${groupName}"`, { groupId });
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
      await combat.update({ [`flags.${MODULE_ID}.groups.${groupId}.hidden`]: newHidden });
      await combat.updateEmbeddedDocuments("Combatant",
        members.map((c) => ({ _id: c.id, hidden: newHidden }))
      );

      if (syncTokens) {
        const tokenUpdates = members
          .map((c) => c.token)
          .filter(Boolean)
          .map((t) => ({ _id: t.id, hidden: newHidden }));
        const scene = combat.scene ?? canvas.scene;
        if (tokenUpdates.length && scene) {
          try {
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
   * Reconcile finalized initiative state after membership changes.
   * @param {Combat} combat
   * @param {Iterable<string>} groupIds
   */
  static async reconcileGroupInitiatives(combat, groupIds) {
    const ids = [...new Set(Array.from(groupIds ?? []).filter((id) => id && id !== UNGROUPED))];
    if (!combat || !ids.length) return;
    return this._enqueueInitiativeOperation(combat, async () => {
      for (const groupId of ids) await this._reconcileGroupInitiativeNow(combat, groupId);
    });
  }

  static async _reconcileGroupInitiativeNow(combat, groupId) {
    const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`);
    if (!meta) return false;

    const members = combat.combatants.filter(
      (combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId
    );
    if (!members.length) {
      await combat.update({
        [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: null,
        [`flags.${MODULE_ID}.groups.${groupId}.initiativeTiebreaker`]: null,
        [`flags.${MODULE_ID}.groups.${groupId}.captainId`]: null,
      });
      return false;
    }

    if (!members.every((combatant) => Number.isFinite(getRawInitiative(combatant)))) {
      await combat.update({
        [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: null,
        [`flags.${MODULE_ID}.groups.${groupId}.initiativeTiebreaker`]: null,
      });
      return false;
    }

    const shaped = members.map((combatant) => this._shapeOrderEntry(combatant));
    await this._applyGroupOrder(combat, groupId, shaped, { sendSummary: false });
    return true;
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
    if (targetGroupId && !combat.getFlag(MODULE_ID, `groups.${targetGroupId}`)) {
      ui.notifications.warn(game.i18n.localize("SCI.Notifications.TargetGroupMissing"));
      return false;
    }

    return this._enqueueInitiativeOperation(combat, async () => {
      const combatants = [...new Set(combatantIds)]
        .map((id) => combat.combatants.get(id))
        .filter(Boolean);
      if (!combatants.length) return false;

      const affectedGroups = new Set(targetGroupId ? [targetGroupId] : []);
      const combatUpdate = {};
      for (const combatant of combatants) {
        const sourceGroupId = combatant.getFlag(MODULE_ID, "groupId");
        if (sourceGroupId && sourceGroupId !== UNGROUPED && sourceGroupId !== targetGroupId) {
          affectedGroups.add(sourceGroupId);
          const sourceMeta = combat.getFlag(MODULE_ID, `groups.${sourceGroupId}`) ?? {};
          if (sourceMeta.captainId === combatant.id) {
            combatUpdate[`flags.${MODULE_ID}.groups.${sourceGroupId}.captainId`] = null;
          }
        }
      }

      if (Object.keys(combatUpdate).length) await combat.update(combatUpdate);
      await combat.updateEmbeddedDocuments("Combatant", combatants.map((combatant) => ({
        _id: combatant.id,
        ...(targetGroupId
          ? { [`flags.${MODULE_ID}.groupId`]: targetGroupId }
          : {
              [`flags.${MODULE_ID}.-=groupId`]: null,
              [`flags.${MODULE_ID}.-=rawInitiative`]: null,
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

    const moved = await this.moveCombatants(combat, groupId, combatantIds);
    if (moved) log.debug(`Added ${combatantIds.length} combatants to group "${group.name}"`, { groupId });
  }

  /**
   * Removes a combatant from its group (reverts to ungrouped).
   * Clears captain designation if the removed combatant was captain.
   * @param {Combat} combat
   * @param {string} combatantId
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

    const moved = await this.moveCombatants(combat, null, [combatantId]);
    if (moved) log.debug(`Removed combatant "${combatant.name}" from group`);
  }

  /* ------------------------------------------------------------------ */
  /*  Group Presets                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Get all saved group presets.
   * @returns {Object<string, {name: string, img: string, color: string, initiativeMode: string, discipline: string, moraleTrigger: string}>}
   */
  static getPresets() {
    try {
      const presets = game.settings.get(MODULE_ID, "groupPresets");
      return foundry.utils.deepClone(presets) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Save (or overwrite by name) a group preset.
   * @param {string} name - Preset display name
   * @param {Object} [data] - Group config: {img?, color?, initiativeMode?, discipline?, moraleTrigger?}
   * @returns {Promise<string|null>} The preset id, or null when not permitted
   */
  static async savePreset(name, data = {}) {
    const log = logger.fn("savePreset");

    if (!isGM()) {
      log.warn("Non-GM attempted to save group preset");
      return null;
    }
    const presetName = String(name ?? "").trim();
    if (!presetName) throw new Error("preset name is required");

    const presets = this.getPresets();
    const existingId = Object.keys(presets).find((id) => presets[id]?.name === presetName);
    const presetId = existingId ?? `preset-${foundry.utils.randomID()}`;

    presets[presetId] = {
      name: presetName,
      img: sanitizeImagePath(data.img, "icons/svg/combat.svg"),
      color: sanitizeColor(data.color, "#7b68ee"),
      initiativeMode: Object.values(INITIATIVE_MODE).includes(data.initiativeMode)
        ? data.initiativeMode
        : game.settings.get(MODULE_ID, "defaultInitiativeMode"),
      discipline: ["standard", "expendable", "elite", "fearless"].includes(data.discipline)
        ? data.discipline
        : "standard",
      moraleTrigger: Object.values(MORALE_TRIGGER).includes(data.moraleTrigger)
        ? data.moraleTrigger
        : MORALE_TRIGGER.BOTH,
    };

    await game.settings.set(MODULE_ID, "groupPresets", presets);
    log.debug(`Saved group preset "${presetName}"`, { presetId, overwrote: !!existingId });
    return presetId;
  }

  /**
   * Delete a saved group preset.
   * @param {string} presetId
   * @returns {Promise<boolean>} True when a preset was removed
   */
  static async deletePreset(presetId) {
    const log = logger.fn("deletePreset");

    if (!isGM()) {
      log.warn("Non-GM attempted to delete group preset");
      return false;
    }

    const presets = this.getPresets();
    if (!presetId || !(presetId in presets)) return false;

    delete presets[presetId];
    await game.settings.set(MODULE_ID, "groupPresets", presets);
    log.debug("Deleted group preset", { presetId });
    return true;
  }

  /**
   * Designates a combatant as the captain of its group.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {string} combatantId
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

    await combat.setFlag(MODULE_ID, `groups.${groupId}.captainId`, combatantId);
    await this._recalculateGroupIfReady(combat, groupId, { sendSummary: false });
    log.debug(`Set captain of "${group.name}" to "${combatant.name}"`, { groupId, combatantId });
  }

  /**
   * Removes the captain designation from a group.
   * @param {Combat} combat
   * @param {string} groupId
   */
  static async removeCaptain(combat, groupId) {
    const log = logger.fn("removeCaptain");

    if (!isGM()) {
      log.warn("Non-GM attempted to remove captain");
      return;
    }
    if (!combat || !groupId) return;

    await combat.setFlag(MODULE_ID, `groups.${groupId}.captainId`, null);
    await this._recalculateGroupIfReady(combat, groupId, { sendSummary: false });
    log.debug(`Removed captain from group`, { groupId });
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
    const meta = combat?.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    if (meta.initiative == null) return false;
    await this._enqueueInitiativeOperation(combat, async () => {
      const members = combat.combatants.filter(
        (c) => c.getFlag(MODULE_ID, "groupId") === groupId
      );
      if (!members.length || !members.every((c) => Number.isFinite(getRawInitiative(c)))) return;
      const shaped = members.map((combatant) => this._shapeOrderEntry(combatant));
      await this._applyGroupOrder(combat, groupId, shaped, { sendSummary });
    });
    return true;
  }
}
