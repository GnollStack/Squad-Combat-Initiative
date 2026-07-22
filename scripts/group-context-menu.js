/**
 * @file group-context-menu.js
 * @description Context menu options and dialogs for custom group headers in the combat tracker.
 * @version Foundry V14+
 */

import {
  MODULE_ID,
  logger,
  isGM,
  canManageGroups,
  MORALE_TRIGGER,
  sanitizeColor,
  sanitizeImagePath,
  buildInitiativeModeOptions,
  buildMoraleTriggerOptions,
  buildDisciplineOptions,
  unnamedGroup,
  TEMPLATES,
  renderModuleTemplate,
} from "./shared.js";
import { GroupManager } from "./group-manager.js";

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
    const content = await renderModuleTemplate(TEMPLATES.TEXT_PROMPT, {
      message: msg,
      default: defVal,
    });
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title },
      content,
      buttons: [
        {
          action: "ok",
          label: "SCI.Confirm",
          icon: "fas fa-check",
          default: true,
          callback: (event, button, dialog) => {
            const input = dialog.element.querySelector("#sci-prompt-input");
            return input?.value?.trim() ?? "";
          },
        },
        { action: "cancel", label: "SCI.Cancel", icon: "fas fa-times" },
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
    name: "SCI.ContextMenu.EditGroup",
    icon: '<i class="fas fa-cog"></i>',
    condition: (li) => canManageGroups() && !!li?.closest(".sci-combatant-group"),
    callback: async (li) => {
      const log = logger.fn("editGroup");
      try {
        const groupId = li.closest(".sci-combatant-group")?.dataset?.groupKey;
        const combat = game.combat;
        const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
        if (!group) return ui.notifications.warn(game.i18n.localize("SCI.Notifications.GroupDataMissing"));

        const moraleEnabled = game.settings.get(MODULE_ID, "moraleEnabled");
        const currentDiscipline = group.discipline ?? "standard";
        const currentDivisorValue = Number(group.mobConfidenceDivisor ?? game.settings.get(MODULE_ID, "moraleMobConfidenceDivisor"));
        const currentDivisor = Number.isFinite(currentDivisorValue)
          ? Math.min(Math.max(Math.trunc(currentDivisorValue), 1), 10)
          : 3;
        const currentMode = group.initiativeMode ?? game.settings.get(MODULE_ID, "defaultInitiativeMode");
        const currentCaptainId = group.captainId ?? null;
        const currentMoraleTrigger = group.moraleTrigger ?? MORALE_TRIGGER.BOTH;

        const members = combat.combatants.filter(
          (c) => c.getFlag(MODULE_ID, "groupId") === groupId
        );

        const captainOptions = members.length > 0
          ? [
              { value: "", label: game.i18n.localize("SCI.Dialog.CaptainNone"), selected: !currentCaptainId },
              { value: "__random__", label: game.i18n.localize("SCI.Dialog.CaptainRandom"), selected: false },
              ...members.map((c) => ({ value: c.id, label: c.name, selected: c.id === currentCaptainId })),
            ]
          : [];

        const content = await renderModuleTemplate(TEMPLATES.GROUP_FORM, {
          name: group.name ?? "",
          img: sanitizeImagePath(group.img, ""),
          color: sanitizeColor(group.color, "#ffffff"),
          initModeOptions: buildInitiativeModeOptions(currentMode),
          showCaptain: members.length > 0,
          captainOptions,
          showHidden: false,
          moraleEnabled,
          moraleTriggerOptions: buildMoraleTriggerOptions(currentMoraleTrigger),
          disciplineOptions: buildDisciplineOptions(currentDiscipline),
          showMobDivisor: true,
          mobDivisor: currentDivisor,
        });

        const result = await foundry.applications.api.DialogV2.wait({
          window: { title: game.i18n.format("SCI.Dialog.EditTitle", { name: group.name ?? unnamedGroup() }) },
          content,
          buttons: [
            {
              action: "ok",
              label: "SCI.Save",
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
            { action: "cancel", label: "SCI.Cancel", icon: "fas fa-times" },
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
        log.errorNotify(game.i18n.localize("SCI.Errors.EditGroup"), err);
      }
    },
  };
}

function renameOption() {
  return {
    name: "SCI.ContextMenu.RenameGroup",
    icon: '<i class="fas fa-edit"></i>',
    condition: (li) => canManageGroups() && !!li?.closest(".sci-combatant-group"),
    callback: async (li) => {
      const log = logger.fn("renameGroup");
      try {
        const groupId = li.closest(".sci-combatant-group")?.dataset?.groupKey;
        const combat = game.combat;
        const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);

        if (!group) return ui.notifications.warn(game.i18n.localize("SCI.Notifications.GroupDataMissing"));

        const newName = await GroupContextMenuManager.prompt(
          game.i18n.localize("SCI.Dialog.RenameTitle"),
          game.i18n.localize("SCI.Dialog.RenamePrompt"),
          group.name
        );
        if (!newName || newName === group.name) return;

        if (isGM()) {
          await combat.setFlag(MODULE_ID, `groups.${groupId}.name`, newName);
          log.debug(`Renamed group to "${newName}"`, { groupId });
        }
      } catch (err) {
        log.errorNotify(game.i18n.localize("SCI.Errors.RenameGroup"), err);
      }
    },
  };
}

function setInitiativeOption() {
  return {
    name: "SCI.ContextMenu.SetInitiative",
    icon: '<i class="fas fa-dice"></i>',
    condition: (li) => canManageGroups() && !!li?.closest(".sci-combatant-group"),
    callback: async (li) => {
      const log = logger.fn("setGroupInitiative");
      try {
        const groupId = li.closest(".sci-combatant-group")?.dataset?.groupKey;
        const combat = game.combat;
        const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
        const groupName = group?.name ?? unnamedGroup();

        const val = await GroupContextMenuManager.prompt(
          game.i18n.localize("SCI.Dialog.SetInitiativeTitle"),
          game.i18n.format("SCI.Dialog.SetInitiativePrompt", { name: groupName }),
          "10"
        );

        if (val == null) return;
        const base = Number(val);
        if (!Number.isFinite(base)) {
          ui.notifications.warn(game.i18n.localize("SCI.Notifications.InvalidInitiative"));
          return;
        }

        await GroupManager.setGroupInitiative(combat, groupId, base);
      } catch (err) {
        log.errorNotify(game.i18n.localize("SCI.Errors.SetInitiative"), err);
      }
    },
  };
}

function deleteOption() {
  return {
    name: "SCI.ContextMenu.DeleteGroup",
    icon: '<i class="fas fa-trash"></i>',
    condition: (li) => canManageGroups() && !!li?.closest(".sci-combatant-group"),
    callback: async (li) => {
      const groupId = li.closest(".sci-combatant-group")?.dataset?.groupKey;
      await GroupManager.deleteGroup(game.combat, groupId, { confirm: true });
    },
  };
}
