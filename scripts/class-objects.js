/**
 * @file class-objects.js
 * @description Core business logic for Group Management and Context Menu interactions.
 * @version V13 Only
 */

import {
  MODULE_ID,
  logger,
  isGM,
  canManageGroups,
  CONSTANTS,
  INITIATIVE_MODE,
  MORALE_TRIGGER,
  calculateAverageInitiative,
  calculateGroupInitiative,
  generateGroupId,
  expandStore,
  visibilitySyncInProgress,
  escapeHtml,
  escapeAttribute,
  sanitizeColor,
  sanitizeImagePath,
} from "./shared.js";
import { VISIBILITY_SYNC_MODE } from "./settings.js";

/**
 * Constant identifier for the default "ungrouped" bucket.
 * @type {string}
 */
export const UNGROUPED = "ungrouped";

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

const DISPOSITION_LABELS = Object.freeze({
  [CONST.TOKEN_DISPOSITIONS.SECRET]: "Secret Tokens",
  [CONST.TOKEN_DISPOSITIONS.HOSTILE]: "Hostile Tokens",
  [CONST.TOKEN_DISPOSITIONS.NEUTRAL]: "Neutral Tokens",
  [CONST.TOKEN_DISPOSITIONS.FRIENDLY]: "Friendly Tokens",
});

/* ------------------------------------------------------------------ */
/*  GroupManager                                                      */
/* ------------------------------------------------------------------ */

/**
 * Static class for managing group logic, initiative calculations, and batch updates.
 */
export class GroupManager {
  /**
   * Mutex lock to prevent recursive executions.
   * @type {boolean}
   */
  static _mutex = false;

  /**
   * Flag to indicate bulk roll is in progress (rollAll/rollNPC).
   * When true, individual updateCombatant hooks should skip finalization.
   * @type {boolean}
   */
  static _bulkRollInProgress = false;

  /**
   * Organizes combatants into a Map keyed by their group ID.
   * @param {Combatant[]} combatants
   * @param {Combat} combat
   * @returns {Map<string, {name: string, members: Combatant[]}>}
   */
  static getGroups(combatants, combat) {
    const stored = foundry.utils.getProperty(combat, `flags.${MODULE_ID}.groups`) ?? {};
    const map = new Map();

    for (const c of combatants) {
      const id = c.getFlag(MODULE_ID, "groupId") ?? UNGROUPED;
      if (!map.has(id)) {
        const groupData = stored[id] ?? {};
        map.set(id, { name: groupData.name ?? "Unnamed Group", members: [] });
      }
      map.get(id).members.push(c);
    }

    for (const [gid, data] of Object.entries(stored)) {
      if (!map.has(gid) && gid !== UNGROUPED) {
        map.set(gid, { name: data.name ?? "Unnamed Group", members: [] });
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
    const groupName = groupMeta.name ?? "Unnamed Group";

    const members = combat.combatants.filter(
      (c) => c.getFlag(MODULE_ID, "groupId") === groupId
    );
    const toRoll = members.filter((c) => c.initiative == null);

    if (!toRoll.length) {
      return ui.notifications.info(`Group "${groupName}" already has initiative.`);
    }

    log.groupStart(`Rolling initiative for "${groupName}"`, {
      groupId,
      mode,
      memberCount: toRoll.length,
    });

    await combat.setFlag(MODULE_ID, `skipFinalize.${groupId}`, true);

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
          flavor: `${c.name} rolls for Initiative!`,
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
        await combat.unsetFlag(MODULE_ID, `skipFinalize.${groupId}`);
        log.groupEnd("no rolls prepared");
        return;
      }

      await combat.updateEmbeddedDocuments(
        "Combatant",
        rolledSummary.map((r) => ({ _id: r.combatant.id, initiative: r.init }))
      );

      await this._applyGroupOrder(combat, groupId, rolledSummary, {
        sendSummary: true,
        clearSkipFlag: true,
      });

      log.groupEnd("success");
    } catch (err) {
      log.groupEnd("failed");
      log.errorNotify(`Error rolling group initiative for "${groupName}"`, err);

      try {
        await combat.unsetFlag(MODULE_ID, `skipFinalize.${groupId}`);
      } catch (cleanupErr) {
        log.warn("Failed to cleanup skip flag", cleanupErr);
      }
    }
  }

  /**
   * Checks if a group is fully rolled and applies averages/sorting.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} [options]
   * @param {boolean} [options.bypassMutex=false] - Skip mutex check (for batch operations)
   */
  static async finalizeGroupInitiative(combat, groupId, { bypassMutex = false } = {}) {
    if (!bypassMutex && this._mutex) return;
    if (!bypassMutex) this._mutex = true;

    const log = logger.fn("finalizeGroupInitiative");

    try {
      const members = combat.combatants.filter(
        (c) => c.getFlag(MODULE_ID, "groupId") === groupId
      );

      if (!members.length) {
        log.trace("No members found for group", { groupId });
        return;
      }

      if (!members.every((c) => Number.isFinite(c.initiative))) {
        log.trace("Not all members have initiative yet", {
          groupId,
          pending: members.filter(c => !Number.isFinite(c.initiative)).length,
        });
        return;
      }

      log.debug("Finalizing group initiative", {
        groupId,
        memberCount: members.length,
      });

      const shaped = members.map((c) => ({
        combatant: c,
        name: c.name,
        init: c.initiative,
        dex: c.actor?.system?.abilities?.dex?.value ?? 10,
      }));

      await this._applyGroupOrder(combat, groupId, shaped, { sendSummary: true });
      log.success("Group initiative finalized", { groupId });
    } catch (err) {
      log.error("Error finalizing group initiative", err, { groupId });
    } finally {
      if (!bypassMutex) this._mutex = false;
    }
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
   * Core sorting logic - calculates group average and assigns fractional offsets.
   * @private
   */
  static async _applyGroupOrder(
    combat,
    groupId,
    list,
    { sendSummary = false, clearSkipFlag = false } = {}
  ) {
    if (!isGM()) return;

    const log = logger.fn("_applyGroupOrder");
    const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const groupName = meta.name ?? "Unnamed Group";

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

    const { updates, entries } = this._buildNormalizedGroupUpdates(combat, groupId, avgInit, list);
    const groupRank = entries.findIndex(g => g.id === groupId);
    const groupOffset = groupRank > 0 ? -(groupRank * CONSTANTS.GROUP_RANK_OFFSET) : 0;
    const currentGroupData = entries.find(g => g.id === groupId);
    log.trace("Calculated group rank", {
      groupName,
      groupRank,
      groupOffset,
      totalGroups: entries.length,
      avgDex: currentGroupData?.avgDex,
    });

    log.debug("Calculated group order", {
      groupName,
      avgInit,
      groupOffset,
      normalizedGroups: entries.map((entry) => entry.id),
      memberOrder: list.map(r => `${r.name}: ${r.init}`),
    });

    try {
      await Promise.all([
        combat.updateEmbeddedDocuments("Combatant", updates),
        combat.setFlag(MODULE_ID, `groups.${groupId}.initiative`, avgInit),
      ]);

      if (clearSkipFlag) {
        await combat.unsetFlag(MODULE_ID, `skipFinalize.${groupId}`);
      }
    } catch (err) {
      log.error(`Error applying group order for "${groupName}"`, err);
      if (clearSkipFlag) {
        try {
          await combat.unsetFlag(MODULE_ID, `skipFinalize.${groupId}`);
        } catch (e) { log.warn("Failed to cleanup skip flag", e); }
      }
      throw err;
    }

    if (sendSummary) {
      try {
        const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);
        const safeGroupColor = sanitizeColor(meta.color, "#7b68ee");
        const safeGroupImg = escapeAttribute(sanitizeImagePath(meta.img, "icons/svg/combat.svg"));
        const safeGroupName = escapeHtml(groupName);

        // Compute summary stats
        const totalInit = list.reduce((sum, r) => sum + r.init, 0);
        const highRoll = Math.max(...list.map(r => r.init));
        const lowRoll = Math.min(...list.map(r => r.init));
        const memberDexMods = list.map(r => r.combatant.actor?.system?.abilities?.dex?.mod ?? 0);
        const avgDexMod = memberDexMods.length > 0
          ? (memberDexMods.reduce((a, b) => a + b, 0) / memberDexMods.length)
          : 0;
        const formatMod = (v) => v >= 0 ? `+${v}` : `${v}`;

        // Build member rows (already sorted by initiative desc)
        const memberRows = list
          .map((r) => {
            const dexMod = r.combatant.actor?.system?.abilities?.dex?.mod ?? 0;
            const safeImg = escapeAttribute(sanitizeImagePath(r.combatant.img || r.combatant.token?.texture?.src || "", ""));
            const safeName = escapeHtml(r.name);
            return `<tr>
              <td style="padding: 3px 6px;">
                ${safeImg ? `<img src="${safeImg}" width="24" height="24" style="border: none; vertical-align: middle; margin-right: 4px; border-radius: 50%;">` : ""}
                ${safeName}
              </td>
              <td style="padding: 3px 6px; text-align: center; font-weight: bold;">${r.init}</td>
              <td style="padding: 3px 6px; text-align: center; opacity: 0.8;">${formatMod(dexMod)}</td>
            </tr>`;
          })
          .join("");

        const content = `
          <div style="border: 2px solid ${safeGroupColor}; border-radius: 8px; overflow: hidden; font-size: 13px;">
            <div style="padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid ${safeGroupColor};">
              <img src="${safeGroupImg}" width="32" height="32" style="border: none; border-radius: 50%;">
              <div style="flex: 1;">
                <strong style="font-size: 15px; display: block;">${safeGroupName}</strong>
                <span style="font-size: 12px; opacity: 0.7;">Group Initiative: <strong style="font-size: 14px; opacity: 1;">${avgInit}</strong></span>
              </div>
            </div>
            <div style="padding: 6px 10px; display: flex; gap: 12px; flex-wrap: wrap; background: rgba(0,0,0,0.03); border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 12px;">
              <span title="Sum of all individual rolls"><i class="fas fa-sigma" style="opacity: 0.6;"></i> Total: <strong>${totalInit}</strong></span>
              <span title="Highest individual roll"><i class="fas fa-arrow-up" style="opacity: 0.6;"></i> High: <strong>${highRoll}</strong></span>
              <span title="Lowest individual roll"><i class="fas fa-arrow-down" style="opacity: 0.6;"></i> Low: <strong>${lowRoll}</strong></span>
              <span title="Average DEX modifier across group"><i class="fas fa-running" style="opacity: 0.6;"></i> Avg DEX: <strong>${formatMod(Math.round(avgDexMod * 10) / 10)}</strong></span>
              <span title="Number of combatants"><i class="fas fa-users" style="opacity: 0.6;"></i> <strong>${list.length}</strong></span>
              <span title="Initiative Mode"><i class="fas fa-calculator" style="opacity: 0.6;"></i> Mode: <strong>${mode[0].toUpperCase() + mode.slice(1)}</strong></span>${mode === INITIATIVE_MODE.CAPTAIN && meta.captainId ? `
              <span title="Captain"><i class="fas fa-crown" style="opacity: 0.6; color: gold;"></i> ${escapeHtml(list.find(r => r.combatant.id === meta.captainId)?.name ?? "Unknown")}</span>` : ""}
            </div>
            <table style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr style="border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 11px; text-transform: uppercase; opacity: 0.6;">
                  <th style="padding: 4px 6px; text-align: left;">Combatant</th>
                  <th style="padding: 4px 6px; text-align: center;">Init</th>
                  <th style="padding: 4px 6px; text-align: center;">DEX</th>
                </tr>
              </thead>
              <tbody>${memberRows}</tbody>
            </table>
          </div>`;

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
      init: combatant.initiative,
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

    const updates = [];
    for (const [rank, entry] of entries.entries()) {
      const groupOffset = rank > 0 ? -(rank * CONSTANTS.GROUP_RANK_OFFSET) : 0;
      updates.push(...entry.order.map((r, idx, arr) => ({
        _id: r.combatant.id,
        initiative: +(entry.initiative + groupOffset + (arr.length - idx) * CONSTANTS.STAGGER_INCREMENT).toFixed(2),
      })));
    }

    return { updates, entries };
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
      ui.notifications.warn("Could not determine group.");
      return false;
    }

    if (!isGM()) {
      log.warn("Non-GM attempted to delete group");
      return false;
    }

    const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const displayName = groupName ?? meta.name ?? "Unnamed Group";

    log.debug(`Attempting to delete group "${displayName}"`, { groupId });

    if (confirm) {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: `Delete Group "${displayName}"` },
        content: `<p>Delete this group and unassign its members?</p>`,
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

      const operations = [
        combat.update({ [`flags.${MODULE_ID}.groups.-=${groupId}`]: null }),
      ];

      if (members.length) {
        operations.push(
          combat.updateEmbeddedDocuments(
            "Combatant",
            members.map((c) => ({ _id: c.id, [`flags.${MODULE_ID}.-=groupId`]: null }))
          )
        );
      }

      await Promise.all(operations);
      log.success(`Deleted group "${displayName}"`, { memberCount: members.length });
      return true;
    } catch (err) {
      log.errorNotify(`Error deleting group "${displayName}"`, err);
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
        await combat.updateEmbeddedDocuments("Combatant",
          existingMembers.map((c) => ({
            _id: c.id,
            ...(startHidden ? { hidden: true } : {}),
            [`flags.${MODULE_ID}.groupId`]: groupId,
          }))
        );
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
      return {
        key: `disposition:${disposition}`,
        name: DISPOSITION_LABELS[disposition] ?? `Disposition ${disposition}`,
        img: "icons/svg/mystery-man.svg",
      };
    }

    const actor = combatant.token?.baseActor ?? combatant.actor;
    const actorId = actor?.id ?? combatant.actorId ?? combatant.name;
    const actorName = actor?.name ?? combatant.actor?.name ?? combatant.name ?? "Unknown Actor";
    return {
      key: `actor:${actorId}`,
      name: actorName,
      img: combatant.img || actor?.img || combatant.actor?.img || "icons/svg/mystery-man.svg",
    };
  }

  static _getUniqueGroupName(baseName, existingNames) {
    const name = baseName || "Auto Group";
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
      ui.notifications.warn("Could not find group data.");
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
      ui.notifications.warn("Please enter a valid number for initiative.");
      return;
    }

    const members = combat.combatants.filter(
      (c) => c.getFlag(MODULE_ID, "groupId") === groupId
    );
    if (!members.length) return;

    const order = members.map((combatant) => ({
      ...this._shapeOrderEntry(combatant),
      init: Number.isFinite(combatant.initiative) ? combatant.initiative : value,
    }));
    const { updates } = this._buildNormalizedGroupUpdates(combat, groupId, value, order);

    await Promise.all([
      combat.updateEmbeddedDocuments("Combatant", updates),
      combat.update({ [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: value }),
    ]);

    const groupName = combat.getFlag(MODULE_ID, `groups.${groupId}`)?.name ?? "Unnamed Group";
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

    const updates = members.map((c) => ({ _id: c.id, initiative: null }));

    await Promise.all([
      combat.updateEmbeddedDocuments("Combatant", updates),
      combat.update({ [`flags.${MODULE_ID}.groups.${groupId}.-=initiative`]: null }),
    ]);

    const { updates: normalizedUpdates } = this._buildNormalizedGroupUpdates(combat);
    if (normalizedUpdates.length) {
      await combat.updateEmbeddedDocuments("Combatant", normalizedUpdates);
    }

    const groupName = combat.getFlag(MODULE_ID, `groups.${groupId}`)?.name ?? "Unnamed Group";
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

    const updates = [
      combat.update({ [`flags.${MODULE_ID}.groups.${groupId}.hidden`]: newHidden }),
      combat.updateEmbeddedDocuments("Combatant",
        members.map((c) => ({ _id: c.id, hidden: newHidden }))
      ),
    ];

    if (syncMode === VISIBILITY_SYNC_MODE.BIDIRECTIONAL) {
      const tokenUpdates = members
        .map((c) => c.token)
        .filter(Boolean)
        .map((t) => ({ _id: t.id, hidden: newHidden }));

      if (tokenUpdates.length) {
        members.forEach((c) => visibilitySyncInProgress.add(c.id));
        try {
          updates.push(canvas.scene.updateEmbeddedDocuments("Token", tokenUpdates));
          await Promise.all(updates);
        } finally {
          members.forEach((c) => visibilitySyncInProgress.delete(c.id));
        }
      } else {
        await Promise.all(updates);
      }
    } else {
      await Promise.all(updates);
    }

    const groupName = groupCfg.name ?? "Unnamed Group";
    log.trace(`${newHidden ? "Hid" : "Showed"} group "${groupName}" (syncMode: ${syncMode})`);
    return newHidden;
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
      ui.notifications.warn("Target group does not exist.");
      return;
    }

    const updates = combatantIds.map((id) => ({
      _id: id,
      [`flags.${MODULE_ID}.groupId`]: groupId,
    }));

    await combat.updateEmbeddedDocuments("Combatant", updates);
    log.debug(`Added ${combatantIds.length} combatants to group "${group.name}"`, { groupId });
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

    const groupId = combatant.getFlag(MODULE_ID, "groupId");

    await combatant.unsetFlag(MODULE_ID, "groupId");
    log.debug(`Removed combatant "${combatant.name}" from group`);

    // Clear captain if this combatant was the captain
    if (groupId && groupId !== "ungrouped") {
      const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
      if (meta.captainId === combatantId) {
        await this.removeCaptain(combat, groupId);
        log.debug(`Cleared captain for group "${meta.name}" (combatant removed)`);
      }
    }
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

    const members = combat.combatants.filter(
      (c) => c.getFlag(MODULE_ID, "groupId") === groupId
    );
    if (!members.length || !members.every((c) => Number.isFinite(c.initiative))) {
      return false;
    }

    const shaped = members.map((c) => ({
      combatant: c,
      name: c.name,
      init: c.initiative,
      dex: c.actor?.system?.abilities?.dex?.value ?? 10,
    }));
    await this._applyGroupOrder(combat, groupId, shaped, { sendSummary });
    return true;
  }
}

/* ------------------------------------------------------------------ */
/*  Context Menu Manager                                              */
/* ------------------------------------------------------------------ */

/**
 * Manages Context Menu options for group headers.
 */
export class GroupContextMenuManager {
  static getContextOptions() {
    if (!canManageGroups()) return [];
    return [editGroupOption(), renameOption(), setInitiativeOption(), deleteOption()];
  }

  static async prompt(title, msg, defVal = "") {
    const safeMessage = escapeHtml(msg);
    const safeDefault = escapeAttribute(defVal);
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title },
      content: `
        <p>${safeMessage}</p>
        <div class="form-group">
          <input type="text" id="sci-prompt-input" value="${safeDefault}" autofocus style="width: 100%;">
        </div>
      `,
      buttons: [
        {
          action: "ok",
          label: "Confirm",
          icon: "fas fa-check",
          default: true,
          callback: (event, button, dialog) => {
            const input = dialog.element.querySelector("#sci-prompt-input");
            return input?.value?.trim() ?? "";
          },
        },
        { action: "cancel", label: "Cancel", icon: "fas fa-times" },
      ],
    });
    return result || null;
  }
}

/* ------------------------------------------------------------------ */
/*  Context Menu Option Factories                                     */
/* ------------------------------------------------------------------ */

function editGroupOption() {
  return {
    name: "Edit Group",
    icon: '<i class="fas fa-cog"></i>',
    condition: (li) => canManageGroups() && !!li?.closest(".sci-combatant-group"),
    callback: async (li) => {
      const log = logger.fn("editGroup");
      try {
        const groupId = li.closest(".sci-combatant-group")?.dataset?.groupKey;
        const combat = game.combat;
        const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
        if (!group) return ui.notifications.warn("Could not find group data.");

        const escapedName = escapeAttribute(group.name ?? "");
        const escapedImg = escapeAttribute(sanitizeImagePath(group.img, ""));
        const escapedColor = sanitizeColor(group.color, "#ffffff");

        const moraleEnabled = game.settings.get(MODULE_ID, "moraleEnabled");
        const currentDiscipline = group.discipline ?? "standard";
        const currentDivisorValue = Number(group.mobConfidenceDivisor ?? game.settings.get(MODULE_ID, "moraleMobConfidenceDivisor"));
        const currentDivisor = Number.isFinite(currentDivisorValue)
          ? Math.min(Math.max(Math.trunc(currentDivisorValue), 1), 10)
          : 3;
        const currentMode = group.initiativeMode ?? game.settings.get(MODULE_ID, "defaultInitiativeMode");
        const currentCaptainId = group.captainId ?? null;

        const members = combat.combatants.filter(
          (c) => c.getFlag(MODULE_ID, "groupId") === groupId
        );

        const initModeOptions = [
          { value: INITIATIVE_MODE.AVERAGE, label: "Average (Mean of all rolls)" },
          { value: INITIATIVE_MODE.HIGHEST, label: "Highest (Best roll)" },
          { value: INITIATIVE_MODE.LOWEST, label: "Lowest (Worst roll)" },
          { value: INITIATIVE_MODE.MEDIAN, label: "Median (Middle value)" },
          { value: INITIATIVE_MODE.CAPTAIN, label: "Captain (Leader's roll)" },
        ].map(o => `<option value="${escapeAttribute(o.value)}" ${o.value === currentMode ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");

        const captainOptions = members.length > 0
          ? `<option value="">None</option><option value="__random__">Random</option>` + members.map(c =>
              `<option value="${escapeAttribute(c.id)}" ${c.id === currentCaptainId ? "selected" : ""}>${escapeHtml(c.name)}</option>`
            ).join("")
          : "";

        const currentMoraleTrigger = group.moraleTrigger ?? MORALE_TRIGGER.BOTH;

        const moraleFields = moraleEnabled ? `
          <div class="form-group" style="margin-top: 10px;">
            <label>Morale Trigger:</label>
            <select id="g-morale-trigger" style="width: 100%;">
              <option value="${MORALE_TRIGGER.MANUAL}" ${currentMoraleTrigger === MORALE_TRIGGER.MANUAL ? "selected" : ""}>Manual Only</option>
              <option value="${MORALE_TRIGGER.THRESHOLD}" ${currentMoraleTrigger === MORALE_TRIGGER.THRESHOLD ? "selected" : ""}>Casualty Threshold</option>
              <option value="${MORALE_TRIGGER.CAPTAIN_DEATH}" ${currentMoraleTrigger === MORALE_TRIGGER.CAPTAIN_DEATH ? "selected" : ""}>Captain Death</option>
              <option value="${MORALE_TRIGGER.BOTH}" ${currentMoraleTrigger === MORALE_TRIGGER.BOTH ? "selected" : ""}>Threshold + Captain Death</option>
            </select>
          </div>
          <div class="form-group" style="margin-top: 5px;">
            <label>Discipline Level:</label>
            <select id="g-discipline" style="width: 100%;">
              <option value="standard" ${currentDiscipline === "standard" ? "selected" : ""}>Standard (Normal Roll)</option>
              <option value="expendable" ${currentDiscipline === "expendable" ? "selected" : ""}>Expendable (Disadvantage)</option>
              <option value="elite" ${currentDiscipline === "elite" ? "selected" : ""}>Elite (Advantage)</option>
              <option value="fearless" ${currentDiscipline === "fearless" ? "selected" : ""}>Fearless (Immune)</option>
            </select>
          </div>
          <div class="form-group" style="margin-top: 5px;">
            <label>Mob Confidence Divisor:</label>
            <input id="g-mob-divisor" type="number" min="1" max="10" step="1" value="${currentDivisor}" style="width: 100%;">
            <p class="hint" style="font-size: 11px; opacity: 0.7; margin: 2px 0 0;">+1 morale bonus per this many living members</p>
          </div>
        ` : "";

        const content = `
          <div class="form-group">
            <label>Name:</label>
            <input id="g-name" type="text" value="${escapedName}" autofocus>
          </div>
          <div class="form-group" style="display:flex; gap: 0.5em; align-items:center; margin-top: 5px;">
            <label style="flex:0 0 auto;">Icon:</label>
            <input id="g-img" type="text" style="flex:1" value="${escapedImg}" placeholder="icons/svg/skull.svg">
            <button type="button" id="g-img-picker" title="Browse" style="flex:0 0 auto; width:30px;">
              <i class="fas fa-file-import"></i>
            </button>
          </div>
          <div class="form-group" style="margin-top: 5px;">
            <label>Color:</label>
            <input id="g-color" type="color" value="${escapedColor}" style="width:100%; height:30px; border:none;">
          </div>
          <div class="form-group" style="margin-top: 10px;">
            <label>Initiative Mode:</label>
            <select id="g-init-mode" style="width: 100%;">
              ${initModeOptions}
            </select>
          </div>
          ${members.length > 0 ? `
          <div class="form-group" style="margin-top: 5px;">
            <label>Captain:</label>
            <select id="g-captain" style="width: 100%;">
              ${captainOptions}
            </select>
          </div>` : ""}
          ${moraleFields}
        `;

        const result = await foundry.applications.api.DialogV2.wait({
          window: { title: `Edit Group: ${group.name ?? "Unnamed Group"}` },
          content,
          buttons: [
            {
              action: "ok",
              label: "Save",
              icon: "fas fa-check",
              default: true,
              callback: (event, button, dialog) => {
                const form = dialog.element;
                const result = {
                  name: form.querySelector("#g-name").value.trim() || group.name,
                  img: form.querySelector("#g-img").value.trim() || group.img,
                  color: form.querySelector("#g-color").value.trim() || group.color,
                };
                const initModeEl = form.querySelector("#g-init-mode");
                if (initModeEl) result.initiativeMode = initModeEl.value;
                const captainEl = form.querySelector("#g-captain");
                if (captainEl) {
                  if (captainEl.value === "__random__") {
                    const memberOptions = Array.from(captainEl.options).filter(o => o.value && o.value !== "__random__");
                    if (memberOptions.length > 0) {
                      const pick = memberOptions[Math.floor(Math.random() * memberOptions.length)];
                      result.captainId = pick.value;
                    } else {
                      result.captainId = null;
                    }
                  } else {
                    result.captainId = captainEl.value || null;
                  }
                }
                const moraleTriggerEl = form.querySelector("#g-morale-trigger");
                if (moraleTriggerEl) result.moraleTrigger = moraleTriggerEl.value;
                const disciplineEl = form.querySelector("#g-discipline");
                if (disciplineEl) result.discipline = disciplineEl.value;
                const divisorEl = form.querySelector("#g-mob-divisor");
                if (divisorEl) result.mobConfidenceDivisor = parseInt(divisorEl.value) || 3;
                return result;
              },
            },
            { action: "cancel", label: "Cancel", icon: "fas fa-times" },
          ],
          render: (event, dialog) => {
            const pickerBtn = dialog.element.querySelector("#g-img-picker");
            const imgInput = dialog.element.querySelector("#g-img");
            pickerBtn.addEventListener("click", () => {
              new FilePicker({
                type: "image",
                current: imgInput.value || "icons/",
                callback: (path) => { imgInput.value = path; },
              }).render(true);
            });
          },
        });

        if (!result) return;
        await GroupManager.editGroup(combat, groupId, result);
      } catch (err) {
        log.errorNotify("Error editing group", err);
      }
    },
  };
}

function renameOption() {
  return {
    name: "Rename Group",
    icon: '<i class="fas fa-edit"></i>',
    condition: (li) => canManageGroups() && !!li?.closest(".sci-combatant-group"),
    callback: async (li) => {
      const log = logger.fn("renameGroup");
      try {
        const groupId = li.closest(".sci-combatant-group")?.dataset?.groupKey;
        const combat = game.combat;
        const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);

        if (!group) return ui.notifications.warn("Could not find group data.");

        const newName = await GroupContextMenuManager.prompt(
          "Rename Group",
          "Enter a new name:",
          group.name
        );
        if (!newName || newName === group.name) return;

        if (isGM()) {
          await combat.setFlag(MODULE_ID, `groups.${groupId}.name`, newName);
          log.debug(`Renamed group to "${newName}"`, { groupId });
        }
      } catch (err) {
        log.errorNotify("Error renaming group", err);
      }
    },
  };
}

function setInitiativeOption() {
  return {
    name: "Set Group Initiative",
    icon: '<i class="fas fa-dice"></i>',
    condition: (li) => canManageGroups() && !!li?.closest(".sci-combatant-group"),
    callback: async (li) => {
      const log = logger.fn("setGroupInitiative");
      try {
        const groupId = li.closest(".sci-combatant-group")?.dataset?.groupKey;
        const combat = game.combat;
        const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
        const groupName = group?.name ?? "Unnamed Group";

        const val = await GroupContextMenuManager.prompt(
          "Set Initiative",
          `Enter a new initiative for "${groupName}":`,
          "10"
        );

        const base = Number(val);
        if (!Number.isFinite(base)) {
          ui.notifications.warn("Please enter a valid number for initiative.");
          return;
        }

        await GroupManager.setGroupInitiative(combat, groupId, base);
      } catch (err) {
        log.errorNotify("Error setting group initiative", err);
      }
    },
  };
}

function deleteOption() {
  return {
    name: "Delete Group",
    icon: '<i class="fas fa-trash"></i>',
    condition: (li) => canManageGroups() && !!li?.closest(".sci-combatant-group"),
    callback: async (li) => {
      const groupId = li.closest(".sci-combatant-group")?.dataset?.groupKey;
      await GroupManager.deleteGroup(game.combat, groupId, { confirm: true });
    },
  };
}
