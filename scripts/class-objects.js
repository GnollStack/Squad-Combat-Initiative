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
} from "./shared.js";

/**
 * Constant identifier for the default "ungrouped" bucket.
 * @type {string}
 */
export const UNGROUPED = "ungrouped";

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
      const dieExpr = mode === "advantage" ? "2d20kh" 
                    : mode === "disadvantage" ? "2d20kl" 
                    : "1d20";

      const rolledSummary = [];

      for (const c of toRoll) {
        const dexMod = c.actor?.system?.abilities?.dex?.mod ?? 0;
        const roll = new Roll(`${dieExpr} + ${dexMod}`);
        await roll.evaluate();

        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor: c.actor }),
          flavor: `${c.name} rolls for Initiative!`,
          rollMode: CONST.DICE_ROLL_MODES.GMROLL,
        });

        rolledSummary.push({
          combatant: c,
          name: c.name,
          init: roll.total,
          dex: dexMod,
        });

        // Verbose: log each roll individually
        log.trace(`Rolled for ${c.name}`, { total: roll.total, dex: dexMod });
      }

      // Normal: single summary of all rolls
      log.debug("Rolled initiative for group", {
        rolls: rolledSummary.map(r => `${r.name}: ${r.init} (dex +${r.dex})`),
      });

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
   */
  static async finalizeGroupInitiative(combat, groupId) {
    if (this._mutex) return;
    this._mutex = true;

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
      this._mutex = false;
    }
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

    list.sort((a, b) => b.init - a.init || b.dex - a.dex);

    const baseSort =
      (Math.min(...combat.turns.map((t) => t.sort ?? 0)) || 0) +
      CONSTANTS.SORT_BASE_OFFSET;

    const avgInit = Math.ceil(
      list.reduce((sum, r) => sum + r.init, 0) / list.length
    );

    const updates = list.map((r, idx, arr) => ({
      _id: r.combatant.id,
      sort: baseSort + idx * CONSTANTS.SORT_INCREMENT,
      initiative: +(avgInit + (arr.length - idx) * CONSTANTS.STAGGER_INCREMENT).toFixed(2),
    }));

    log.debug("Calculated group order", {
      groupName,
      avgInit,
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
        } catch {}
      }
      throw err;
    }

    if (sendSummary) {
      try {
        const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);
        const summaryList = list
          .map((r) => `<li><strong>${r.name}</strong>: ${r.init}</li>`)
          .join("");

        await ChatMessage.create({
          content: `<h3>${groupName} initiative rolled</h3>
                   <p><strong>Group initiative:</strong> ${avgInit}</p>
                   <ul>${summaryList}</ul>`,
          whisper: gmIds,
          blind: true,
        });
      } catch (err) {
        log.warn("Failed to create chat summary", { error: err.message });
      }
    }

    log.success(`Applied group order for "${groupName}"`);
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
    return [renameOption(), setInitiativeOption(), deleteOption()];
  }

  static async prompt(title, msg, defVal = "") {
    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title },
      content: `<p>${msg}</p>`,
      input: { type: "text", value: defVal },
      ok: {
        callback: (event, button, dialog) => {
          const input = dialog.element.querySelector("input");
          return input?.value?.trim() ?? "";
        },
      },
    });
    return result || null;
  }
}

/* ------------------------------------------------------------------ */
/*  Context Menu Option Factories                                     */
/* ------------------------------------------------------------------ */

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
        if (!Number.isFinite(base)) return;

        const members = combat.combatants.filter(
          (c) => c.getFlag(MODULE_ID, "groupId") === groupId
        );
        if (!members.length) return;

        const oldInitList = members.map((c) => c.initiative ?? 0);
        const oldAvg = oldInitList.reduce((a, b) => a + b, 0) / members.length || 0;

        const updates = members.map((c) => ({
          _id: c.id,
          initiative: base + ((c.initiative ?? 0) - oldAvg),
        }));

        if (isGM()) {
          await Promise.all([
            combat.updateEmbeddedDocuments("Combatant", updates),
            combat.update({ [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: base }),
          ]);
          log.debug(`Set group initiative to ${base}`, { groupId, groupName });
        }
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