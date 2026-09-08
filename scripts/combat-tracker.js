/**
 * @file combat-tracker.js
 * @description Enhances the Combat Tracker with "Add Group" buttons and Drag-and-Drop.
 * @version Foundry V14+
 */

import {
  MODULE_ID,
  logger,
  expandStore,
  isGM,
  normalizeHtml,
  buildInitiativeModeOptions,
  buildMoraleTriggerOptions,
  buildDisciplineOptions,
  MORALE_TRIGGER,
  TEMPLATES,
  renderModuleTemplate,
} from "./shared.js";
import { CombatEvents } from "./combat-events.js";
import { isMutationAuthority } from "./mutation-authority.js";
import { GroupManager } from "./group-manager.js";
import { openPresetManager } from "./preset-manager.js";
import { GroupContextMenuManager } from "./group-context-menu.js";
import { getPluralRules } from "./rolling-overrides.js";

/** Tracks elements that already have a ContextMenu attached (one per element, per render). */
const _contextMenuElements = new WeakSet();
/** Tracks tracker lists that already have delegated drag/drop handlers attached. */
const _dropTargetElements = new WeakSet();
/** Serializes deleted-casualty increments per combat/group. */
const _deletedCountQueues = new Map();

const SELECTORS = {
  list: ".combat-tracker",
  group: ".sci-combatant-group",
  header: "[data-application-part='header']",
};

/* ------------------------------------------------------------------ */
/*  Public Hooks                                                      */
/* ------------------------------------------------------------------ */

/**
 * Main render hook handler.
 * @param {Application} _app
 * @param {HTMLElement} html
 */
export function combatTrackerRendering(_app, html) {
  if (!isGM()) return;

  const element = normalizeHtml(html);
  const combat = _app.viewed;

  ensureTrackerButtons(element, _app);

  if (!combat) return;

  enableTokenDrag(combat, element);
  registerDropTargets(combat, element);
}

/**
 * Cleanup hook - called when a combat is deleted.
 * @param {Combat} combat
 */
export function onDeleteCombat(combat) {
  expandStore.remove(combat.id);
  logger.trace("Cleaned up combat data", { fn: "onDeleteCombat", data: { combatId: combat.id } });
}

/**
 * Creation hook - ensures new combatants have a default group flag.
 * @param {Combatant} combatant
 */
export async function onCreateCombatant(combatant, options = {}) {
  if (!isMutationAuthority() || options.sciGroupInitiative) return;
  await CombatEvents.createdMember(combatant.parent, combatant);
}

/**
 * Update hook - handles auto-collapse logic on turn changes.
 * @param {Combat} combat
 * @param {Object} update
 */
export async function onUpdateCombat(combat, update) {
  if (!("turn" in update || "round" in update) || !game.settings.get(MODULE_ID, "autoCollapseGroups")) return;
  const activeGroup = combat.combatant?.getFlag(MODULE_ID, "groupId");
  const manualPins = combat.getFlag(MODULE_ID, "groupManualOverrides") ?? {};
  const expanded = expandStore.load(combat.id);
  for (const [id, group] of Object.entries(combat.getFlag(MODULE_ID, "groups") ?? {})) {
    if (manualPins[id]) continue;
    if (group.pinned || id === activeGroup) expanded.add(id); else expanded.delete(id);
  }
  expandStore.save(combat.id, expanded);
  if (ui.combat?.viewed?.id === combat.id) ui.combat.render();
}

/**
 * Attaches context menu to group headers.
 * @param {HTMLElement} element
 */
export function attachContextMenu(element) {
  if (!isGM() && game.user.role < CONST.USER_ROLES.ASSISTANT) return;
  if (!element) return;
  if (_contextMenuElements.has(element)) return;

  const ContextMenuClass = foundry.applications.ux.ContextMenu.implementation ?? ContextMenu;

  new ContextMenuClass(
    element,
    ".sci-combatant-group > .group-header",
    GroupContextMenuManager.getContextOptions(),
    { jQuery: false }
  );
  _contextMenuElements.add(element);
}

/* ------------------------------------------------------------------ */
/*  Internal DOM Helpers                                              */
/* ------------------------------------------------------------------ */

function ensureTrackerButtons(element, app) {
  if (element.querySelector(".sci-tracker-toolbar")) return;
  const toolbar = document.createElement("div");
  toolbar.className = "sci-tracker-toolbar";
  for (const [className, key, callback] of [
    ["sci-create-group-button", "SCI.Tracker.AddGroup", openCreateGroupDialog],
    ["sci-auto-group-button", "SCI.Tracker.AutoGroup", openAutoGroupDialog],
    ["sci-presets-button", "SCI.Card.Presets", openPresetManager],
  ]) {
    const button = document.createElement("button");
    button.type = "button"; button.className = className;
    button.textContent = game.i18n.localize(key);
    button.addEventListener("click", () => { void callback(app.viewed).catch(error => ui.notifications.error(error.message)); });
    toolbar.append(button);
  }
  (element.querySelector(SELECTORS.header) ?? element).prepend(toolbar);
}

function enableTokenDrag(combat, element) {
  const combatants = element.querySelectorAll("li[data-combatant-id]");

  combatants.forEach((li) => {
    const id = li.dataset.combatantId;
    if (!id || !combat.combatants.get(id)?.actor) return;

    li.draggable = true;
    li.removeEventListener("dragstart", handleDragStart);
    li.addEventListener("dragstart", handleDragStart);
  });
}

const DRAG_TYPE = "application/x-sci-combatant";
function handleDragStart(event) {
  const row = event.currentTarget;
  const payload = JSON.stringify({ type: "SCI.Combatant", combatId: row.closest(".combat-tracker")?.dataset.sciCombatId, combatantId: row.dataset.combatantId });
  event.dataTransfer?.setData(DRAG_TYPE, payload);
  event.dataTransfer?.setData("text/plain", payload);
}

export function parseCombatantDrop(text, combat) {
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(game.i18n.localize("SCI.Errors.CrossCombatDrop")); }
  if (payload.type !== "SCI.Combatant" || payload.combatId !== combat.id || !combat.combatants.get(payload.combatantId)) {
    throw new Error(game.i18n.localize("SCI.Errors.CrossCombatDrop"));
  }
  return payload.combatantId;
}

function registerDropTargets(combat, element) {
  const list = element.querySelector(SELECTORS.list);
  if (!list || _dropTargetElements.has(list)) return;
  list.dataset.sciCombatId = combat.id;
  _dropTargetElements.add(list);
  list.addEventListener("dragover", event => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes(DRAG_TYPE)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move";
  });
  list.addEventListener("drop", async event => {
    const text = event.dataTransfer?.getData(DRAG_TYPE);
    if (!text) return;
    event.preventDefault(); event.stopPropagation();
    try {
      if (game.combats.get(combat.id) !== combat || list.dataset.sciCombatId !== combat.id) throw new Error(game.i18n.localize("SCI.Errors.StaleDocument"));
      const id = parseCombatantDrop(text, combat);
      const row = event.target.closest(SELECTORS.group);
      await GroupManager.moveCombatants(combat, row?.dataset.groupKey ?? null, [id]);
      ui.combat.render();
    } catch (error) { ui.notifications.error(error.message); }
  });
}

export async function promptAssignment(combat, ids) {
  const content = await renderModuleTemplate(TEMPLATES.ASSIGNMENT, {
    groups: Object.entries(combat.getFlag(MODULE_ID, "groups") ?? {}).map(([id, group]) => ({ id, name: group.name })),
  });
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("SCI.Card.Assign") }, content,
    buttons: [
      { action: "assign", label: "SCI.Card.Assign", default: true, callback: (_event, _button, dialog) => dialog.element.querySelector("[name=group]").value },
      { action: "cancel", label: "SCI.Cancel", callback: () => null },
    ],
  });
  if (result === null || result === false || result === undefined) return;
  await GroupManager.moveCombatants(combat, result || null, ids);
}

/* ------------------------------------------------------------------ */
/*  Dialog Logic                                                      */
/* ------------------------------------------------------------------ */

async function openCreateGroupDialog(originCombat = game.combat) {
  const log = logger.fn("openCreateGroupDialog");

  try {
    let combat = originCombat;
    const scene = canvas.scene;
    const selected = [...canvas.tokens.controlled];
    const data = await promptGroupData(selected);
    if (!data?.name) {
      log.trace("User cancelled group creation");
      return;
    }

    if (combat && game.combats.get(combat.id) !== combat) throw new Error(game.i18n.localize("SCI.Errors.StaleDocument"));
    if (!combat) {
      if (!scene || canvas.scene?.id !== scene.id) {
        ui.notifications.warn(game.i18n.localize("SCI.Notifications.NoActiveScene"));
        return;
      }
      combat = await game.combats.documentClass.create({ scene: canvas.scene.id });
      await combat.activate();
      log.trace("Created new combat encounter");
    }

    const { savePreset, ...groupData } = data;
    const sel = selected;
    const groupId = await GroupManager.createGroup(combat, groupData, sel);
    if (groupId) {
      ui.notifications.info(game.i18n.format("SCI.Notifications.GroupCreated", { name: data.name, count: sel.length }));

      if (savePreset) {
        await GroupManager.savePreset(data.name, groupData);
        ui.notifications.info(game.i18n.format("SCI.Notifications.PresetSaved", { name: data.name }));
      }
    }
  } catch (err) {
    log.errorNotify(game.i18n.localize("SCI.Errors.CreateGroup"), err);
  }
}

async function openAutoGroupDialog(originCombat = game.combat) {
  const log = logger.fn("openAutoGroupDialog");

  try {
    const combat = originCombat;
    if (!combat) {
      ui.notifications.warn(game.i18n.localize("SCI.Notifications.NoActiveCombat"));
      return;
    }

    const selectedCombatants = getSelectedCombatants(combat);
    const data = await promptAutoGroupData(selectedCombatants.length, combat.combatants.size);
    if (!data) {
      log.trace("User cancelled auto-grouping");
      return;
    }

    const combatants = data.scope === "selected"
      ? selectedCombatants
      : Array.from(combat.combatants);

    if (!combatants.length) {
      ui.notifications.warn(game.i18n.localize(data.scope === "selected"
        ? "SCI.Notifications.NoSelectedInCombat"
        : "SCI.Notifications.NoCombatants"));
      return;
    }

    const result = await GroupManager.autoGroupCombatants(combat, {
      combatants,
      groupBy: data.groupBy,
      includeGrouped: data.includeGrouped,
      includeSingletons: data.includeSingletons,
    });

    if (!result.groupsCreated) {
      ui.notifications.info(game.i18n.localize("SCI.Notifications.NoAutoGroups"));
      return;
    }

    const plural = getPluralRules();
    ui.notifications.info(game.i18n.format("SCI.Notifications.AutoGroupResult", {
      groupCount: result.groupsCreated,
      groupLabel: game.i18n.localize(`SCI.Plural.Group.${plural.select(result.groupsCreated)}`),
      combatantCount: result.combatantsAssigned,
      combatantLabel: game.i18n.localize(`SCI.Plural.Combatant.${plural.select(result.combatantsAssigned)}`),
    }));
    ui.combat.render();
  } catch (err) {
    log.errorNotify(game.i18n.localize("SCI.Errors.AutoGroup"), err);
  }
}

function getSelectedCombatants(combat) {
  const selectedTokenIds = new Set(canvas.tokens.controlled.map((token) => token.id));
  if (!selectedTokenIds.size) return [];
  return combat.combatants.filter((combatant) => selectedTokenIds.has(combatant.tokenId));
}

async function promptAutoGroupData(selectedCount, combatantCount) {
  const content = await renderModuleTemplate(TEMPLATES.AUTO_GROUP, {
    selectedScope: selectedCount > 0,
    scopeSelectedLabel: game.i18n.format("SCI.Dialog.ScopeSelected", { count: selectedCount }),
    scopeAllLabel: game.i18n.format("SCI.Dialog.ScopeAll", { count: combatantCount }),
  });

  return foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("SCI.Dialog.AutoGroupTitle") },
    content,
    buttons: [
      {
        action: "ok",
        label: "SCI.Tracker.AutoGroup",
        icon: "fas fa-layer-group",
        default: true,
        callback: (event, button, dialog) => {
          const form = dialog.element;
          return {
            scope: form.querySelector("#sci-auto-scope").value,
            groupBy: form.querySelector("#sci-auto-group-by").value,
            includeGrouped: !form.querySelector("#sci-auto-skip-grouped").checked,
            includeSingletons: form.querySelector("#sci-auto-singletons").checked,
          };
        },
      },
      { action: "cancel", label: "SCI.Cancel", icon: "fas fa-times" },
    ],
  });
}

async function promptGroupData(selectedTokens) {
  const moraleEnabled = game.settings.get(MODULE_ID, "moraleEnabled");
  const defaultMode = game.settings.get(MODULE_ID, "defaultInitiativeMode");

  // Build captain options from selected tokens
  const captainOptions = [
    { value: "", label: game.i18n.localize("SCI.Dialog.CaptainNone"), selected: true },
    { value: "__random__", label: game.i18n.localize("SCI.Dialog.CaptainRandom"), selected: false },
    ...selectedTokens.map((t) => ({ value: t.id, label: t.name, selected: false })),
  ];

  const presets = GroupManager.getPresets();
  const presetOptions = Object.entries(presets)
    .map(([value, preset]) => ({ value, label: preset.name }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));

  const content = await renderModuleTemplate(TEMPLATES.GROUP_FORM, {
    name: game.i18n.localize("SCI.NewGroup"),
    img: "",
    color: "#ffffff",
    initModeOptions: buildInitiativeModeOptions(defaultMode),
    showCaptain: true,
    captainOptions,
    showHidden: true,
    moraleEnabled,
    moraleTriggerOptions: buildMoraleTriggerOptions(MORALE_TRIGGER.BOTH),
    disciplineOptions: buildDisciplineOptions("standard"),
    showMobDivisor: false,
    showPresets: presetOptions.length > 0,
    presetOptions,
    showSavePreset: true,
  });

  return foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("SCI.Dialog.CreateTitle") },
    content,
    buttons: [
      {
        action: "ok",
        label: "SCI.Create",
        icon: "fas fa-check",
        default: true,
        callback: (event, button, dialog) => {
          const form = dialog.element;
          const result = {
            name: form.querySelector("#g-name").value.trim() || game.i18n.localize("SCI.NewGroup"),
            img: form.querySelector("#g-img").value.trim() || "",
            color: form.querySelector("#g-color").value.trim() || "#000000",
            hidden: form.querySelector("#g-hidden").checked || false,
            initiativeMode: form.querySelector("#g-init-mode").value,
            captainId: form.querySelector("#g-captain").value || null,
            savePreset: form.querySelector("#g-save-preset")?.checked || false,
          };
          const moraleTriggerEl = form.querySelector("#g-morale-trigger");
          if (moraleTriggerEl) result.moraleTrigger = moraleTriggerEl.value;
          const disciplineEl = form.querySelector("#g-discipline");
          if (disciplineEl) result.discipline = disciplineEl.value;
          return result;
        },
      },
      { action: "cancel", label: "SCI.Cancel", icon: "fas fa-times" },
    ],
    render: (event, dialog) => {
      const pickerBtn = dialog.element.querySelector("#g-img-picker");
      const imgInput = dialog.element.querySelector("#g-img");
      pickerBtn.addEventListener("click", () => {
        new foundry.applications.apps.FilePicker.implementation({
          type: "image",
          current: "icons/",
          callback: (path) => { imgInput.value = path; },
        }).render({ force: true });
      });

      // Applying a preset fills the form fields; the GM can still adjust them.
      const presetSelect = dialog.element.querySelector("#g-preset");
      presetSelect?.addEventListener("change", () => {
        const preset = presets[presetSelect.value];
        if (!preset) return;
        const form = dialog.element;
        form.querySelector("#g-name").value = preset.name;
        form.querySelector("#g-img").value = preset.img ?? "";
        form.querySelector("#g-color").value = preset.color ?? "#ffffff";
        form.querySelector("#g-init-mode").value = preset.initiativeMode;
        const moraleTriggerEl = form.querySelector("#g-morale-trigger");
        if (moraleTriggerEl && preset.moraleTrigger) moraleTriggerEl.value = preset.moraleTrigger;
        const disciplineEl = form.querySelector("#g-discipline");
        if (disciplineEl && preset.discipline) disciplineEl.value = preset.discipline;
      });
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Morale: Deleted Combatant Tracking                                */
/* ------------------------------------------------------------------ */

/**
 * Tracks deleted combatants for morale casualty calculations.
 * Increments the group's deletedCount flag when a grouped member is removed.
 * @param {Combatant} combatant
 */
export async function onDeleteCombatant(combatant) {
  if (!isMutationAuthority() || !combatant.parent || !game.combats?.get(combatant.parent.id)) return;
  return CombatEvents.deletedMember(combatant.parent, combatant);
}
