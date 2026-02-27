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
  calculateAverageInitiative,
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

    const avgInit = calculateAverageInitiative(list.map(r => r.init));

    // Calculate group rank to prevent initiative collisions between groups
    // Ties are broken by: total initiative (sum of raw rolls), then average DEX
    const allGroups = combat.getFlag(MODULE_ID, "groups") ?? {};
    const groupsWithInit = Object.entries(allGroups)
      .map(([gid, data]) => {
        const init = data.initiative ?? (gid === groupId ? avgInit : null);
        if (init === null) return null;

        // Gather member data for tie-breaking
        const members = combat.combatants.filter(
          (c) => c.getFlag(MODULE_ID, "groupId") === gid
        );
        const totalInit = members.reduce((sum, c) => sum + (c.initiative ?? 0), 0);
        const avgDex = members.length > 0
          ? members.reduce((sum, c) => sum + (c.actor?.system?.abilities?.dex?.mod ?? 0), 0) / members.length
          : 0;

        return { id: gid, initiative: init, totalInit, avgDex };
      })
      .filter(Boolean)
      .sort((a, b) => {
        // 1. Higher average initiative first
        if (b.initiative !== a.initiative) return b.initiative - a.initiative;
        // 2. Higher total initiative (sum of raw rolls) breaks ties
        if (b.totalInit !== a.totalInit) return b.totalInit - a.totalInit;
        // 3. Higher average DEX modifier as final tiebreaker
        if (b.avgDex !== a.avgDex) return b.avgDex - a.avgDex;
        // 4. Stable fallback by groupId
        return a.id.localeCompare(b.id);
      });

    const groupRank = groupsWithInit.findIndex(g => g.id === groupId);
    const groupOffset = groupRank > 0 ? groupRank * CONSTANTS.GROUP_RANK_OFFSET : 0;

    const currentGroupData = groupsWithInit.find(g => g.id === groupId);
    log.trace("Calculated group rank", {
      groupName,
      groupRank,
      groupOffset,
      totalGroups: groupsWithInit.length,
      totalInit: currentGroupData?.totalInit,
      avgDex: currentGroupData?.avgDex,
    });

    const updates = list.map((r, idx, arr) => ({
      _id: r.combatant.id,
      sort: baseSort + idx * CONSTANTS.SORT_INCREMENT,
      initiative: +(avgInit + groupOffset + (arr.length - idx) * CONSTANTS.STAGGER_INCREMENT).toFixed(2),
    }));

    log.debug("Calculated group order", {
      groupName,
      avgInit,
      groupOffset,
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
        const groupColor = meta.color || "#7b68ee";
        const groupImg = meta.img || "icons/svg/combat.svg";

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
            const img = r.combatant.img || r.combatant.token?.texture?.src || "";
            return `<tr>
              <td style="padding: 3px 6px;">
                ${img ? `<img src="${img}" width="24" height="24" style="border: none; vertical-align: middle; margin-right: 4px; border-radius: 50%;">` : ""}
                ${r.name}
              </td>
              <td style="padding: 3px 6px; text-align: center; font-weight: bold;">${r.init}</td>
              <td style="padding: 3px 6px; text-align: center; opacity: 0.8;">${formatMod(dexMod)}</td>
            </tr>`;
          })
          .join("");

        const content = `
          <div style="border: 2px solid ${groupColor}; border-radius: 8px; overflow: hidden; font-size: 13px;">
            <div style="padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid ${groupColor};">
              <img src="${groupImg}" width="32" height="32" style="border: none; border-radius: 50%;">
              <div style="flex: 1;">
                <strong style="font-size: 15px; display: block;">${groupName}</strong>
                <span style="font-size: 12px; opacity: 0.7;">Group Initiative: <strong style="font-size: 14px; opacity: 1;">${avgInit}</strong></span>
              </div>
            </div>
            <div style="padding: 6px 10px; display: flex; gap: 12px; flex-wrap: wrap; background: rgba(0,0,0,0.03); border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 12px;">
              <span title="Sum of all individual rolls"><i class="fas fa-sigma" style="opacity: 0.6;"></i> Total: <strong>${totalInit}</strong></span>
              <span title="Highest individual roll"><i class="fas fa-arrow-up" style="opacity: 0.6;"></i> High: <strong>${highRoll}</strong></span>
              <span title="Lowest individual roll"><i class="fas fa-arrow-down" style="opacity: 0.6;"></i> Low: <strong>${lowRoll}</strong></span>
              <span title="Average DEX modifier across group"><i class="fas fa-running" style="opacity: 0.6;"></i> Avg DEX: <strong>${formatMod(Math.round(avgDexMod * 10) / 10)}</strong></span>
              <span title="Number of combatants"><i class="fas fa-users" style="opacity: 0.6;"></i> <strong>${list.length}</strong></span>
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
    return [editGroupOption(), renameOption(), setInitiativeOption(), deleteOption()];
  }

  static async prompt(title, msg, defVal = "") {
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title },
      content: `
        <p>${msg}</p>
        <div class="form-group">
          <input type="text" id="sci-prompt-input" value="${defVal}" autofocus style="width: 100%;">
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

        const escapedName = foundry.utils.escapeHTML(group.name ?? "");
        const escapedImg = foundry.utils.escapeHTML(group.img ?? "");

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
            <input id="g-color" type="color" value="${group.color ?? "#ffffff"}" style="width:100%; height:30px; border:none;">
          </div>
        `;

        const result = await foundry.applications.api.DialogV2.wait({
          window: { title: `Edit Group: ${group.name}` },
          content,
          buttons: [
            {
              action: "ok",
              label: "Save",
              icon: "fas fa-check",
              default: true,
              callback: (event, button, dialog) => {
                const form = dialog.element;
                return {
                  name: form.querySelector("#g-name").value.trim() || group.name,
                  img: form.querySelector("#g-img").value.trim() || group.img,
                  color: form.querySelector("#g-color").value.trim() || group.color,
                };
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

        if (isGM()) {
          await combat.update({
            [`flags.${MODULE_ID}.groups.${groupId}.name`]: result.name,
            [`flags.${MODULE_ID}.groups.${groupId}.img`]: result.img,
            [`flags.${MODULE_ID}.groups.${groupId}.color`]: result.color,
          });
          log.debug(`Edited group "${result.name}"`, { groupId });
        }
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