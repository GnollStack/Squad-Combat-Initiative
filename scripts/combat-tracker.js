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
import { GroupManager } from "./group-manager.js";
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
  const combat = game.combat;

  ensureTrackerButtons(element);

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
export async function onCreateCombatant(combatant) {
  if (isGM() && !combatant.getFlag(MODULE_ID, "groupId")) {
    try {
      await combatant.setFlag(MODULE_ID, "groupId", "ungrouped");
      logger.trace("Set default group for combatant", {
        fn: "onCreateCombatant",
        data: combatant.name
      });
    } catch (err) {
      logger.error("Error setting default group", err, { fn: "onCreateCombatant" });
    }
  }
}

/**
 * Update hook - handles auto-collapse logic on turn changes.
 * @param {Combat} combat
 * @param {Object} update
 */
export async function onUpdateCombat(combat, update) {
  if (!("turn" in update) || !game.settings.get(MODULE_ID, "autoCollapseGroups")) {
    return;
  }

  const log = logger.fn("onUpdateCombat");
  const activeGroup = combat.combatant?.getFlag(MODULE_ID, "groupId");

  log.trace("Turn change detected", {
    round: combat.round,
    turn: combat.turn,
    activeGroup
  });

  const flagGroups = combat.getFlag(MODULE_ID, "groups") || {};
  const manualPins = combat.getFlag(MODULE_ID, "groupManualOverrides") || {};

  const expandedSet = expandStore.load(combat.id);

  for (const [gid, cfg] of Object.entries(flagGroups)) {
    if (manualPins[gid]) continue;
    const shouldExpand = cfg.pinned || gid === activeGroup;
    if (shouldExpand) expandedSet.add(gid);
    else expandedSet.delete(gid);
  }

  expandStore.save(combat.id, expandedSet);
  ui.combat.render();

  Hooks.once("renderCombatTracker", (_app, html) => {
    requestAnimationFrame(() => {
      const element = normalizeHtml(html);
      const groups = element.querySelectorAll("li.sci-combatant-group[data-group-key]");

      for (const li of groups) {
        const gid = li.dataset.groupKey;
        li.classList.toggle("collapsed", !expandedSet.has(gid));
      }
    });
  });
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

function ensureTrackerButtons(element) {
  ensureAddGroupButton(element);
  ensureAutoGroupButton(element);
}

function ensureAddGroupButton(element) {
  if (element.querySelector(".sci-create-group-button")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.classList.add("sci-create-group-button");
  btn.innerHTML = `<i class="fas fa-plus"></i> ${game.i18n.localize("SCI.Tracker.AddGroup")}`;
  btn.addEventListener("click", openCreateGroupDialog);

  const controls = element.querySelector(SELECTORS.header);
  if (controls) controls.prepend(btn);
  else element.prepend(btn);
}

function ensureAutoGroupButton(element) {
  if (element.querySelector(".sci-auto-group-button")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.classList.add("sci-auto-group-button");
  btn.innerHTML = `<i class="fas fa-layer-group"></i> ${game.i18n.localize("SCI.Tracker.AutoGroup")}`;
  btn.addEventListener("click", openAutoGroupDialog);

  const controls = element.querySelector(SELECTORS.header);
  const addButton = element.querySelector(".sci-create-group-button");
  if (addButton) addButton.after(btn);
  else if (controls) controls.prepend(btn);
  else element.prepend(btn);
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

function handleDragStart(ev) {
  const id = ev.currentTarget.dataset.combatantId;
  ev.dataTransfer?.setData("text/plain", id);
}

function registerDropTargets(_combat, element) {
  const log = logger.fn("dragDrop");
  const list = element.querySelector(SELECTORS.list);
  if (!list) return;
  if (_dropTargetElements.has(list)) return;
  _dropTargetElements.add(list);

  list.addEventListener("dragover", (ev) => {
    if (ev.target.closest(SELECTORS.group)) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
    }
  });

  // Drop on group -> assign
  list.addEventListener("drop", async (ev) => {
    const groupRow = ev.target.closest(SELECTORS.group);
    if (!groupRow) return;

    ev.preventDefault();
    ev.stopPropagation();

    try {
      const combat = game.combat;
      if (!combat) return;
      const groupId = groupRow.dataset.groupKey;
      const combatantId = ev.dataTransfer.getData("text/plain");
      const combatant = combat.combatants.get(combatantId);

      if (!combatant?.actor) return;

      log.debug("Assigning combatant to group", {
        combatant: combatant.name,
        groupId
      });

      if (isGM()) {
        await GroupManager.moveCombatants(combat, groupId, [combatantId]);
      }

      ui.combat.render();
      log.success("Combatant assigned to group");
    } catch (err) {
      log.errorNotify(game.i18n.localize("SCI.Errors.DragDropGroup"), err);
    }
  });

  // Drop elsewhere -> ungroup
  list.addEventListener("drop", async (ev) => {
    if (ev.target.closest(SELECTORS.group)) return;

    ev.preventDefault();
    try {
      const combat = game.combat;
      if (!combat) return;
      const combatantId = ev.dataTransfer.getData("text/plain");
      if (!combatantId) return;
      const c = combat.combatants.get(combatantId);
      const oldGroup = c?.getFlag(MODULE_ID, "groupId");

      if (c?.actor && oldGroup && oldGroup !== "ungrouped") {
        log.debug("Ungrouping combatant", { combatant: c.name, oldGroup });

        if (isGM()) {
          await GroupManager.moveCombatants(combat, null, [combatantId]);
        }

        ui.combat.render();
        log.success("Combatant ungrouped");
      }
    } catch (err) {
      log.error(game.i18n.localize("SCI.Errors.UngroupCombatant"), err);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Dialog Logic                                                      */
/* ------------------------------------------------------------------ */

async function openCreateGroupDialog() {
  const log = logger.fn("openCreateGroupDialog");

  try {
    const data = await promptGroupData();
    if (!data?.name) {
      log.trace("User cancelled group creation");
      return;
    }

    let combat = game.combat;
    if (!combat) {
      if (!canvas.scene) {
        ui.notifications.warn(game.i18n.localize("SCI.Notifications.NoActiveScene"));
        return;
      }
      combat = await game.combats.documentClass.create({ scene: canvas.scene.id });
      await combat.activate();
      log.trace("Created new combat encounter");
    }

    const { savePreset, ...groupData } = data;
    const sel = canvas.tokens.controlled;
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

async function openAutoGroupDialog() {
  const log = logger.fn("openAutoGroupDialog");

  try {
    const combat = game.combat;
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

async function promptGroupData() {
  const moraleEnabled = game.settings.get(MODULE_ID, "moraleEnabled");
  const defaultMode = game.settings.get(MODULE_ID, "defaultInitiativeMode");

  // Build captain options from selected tokens
  const selectedTokens = canvas.tokens.controlled;
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
        new FilePicker({
          type: "image",
          current: "icons/",
          callback: (path) => { imgInput.value = path; },
        }).render(true);
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
  if (!isGM()) return;

  const combat = combatant.parent;
  if (!combat) return;

  const groupId = combatant.getFlag(MODULE_ID, "groupId");
  if (!groupId || groupId === "ungrouped") return;

  const log = logger.fn("onDeleteCombatant");

  // Clear captain if deleted combatant was the captain
  try {
    const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    if (meta.captainId === combatant.id) {
      await GroupManager.removeCaptain(combat, groupId);
      log.debug(`Cleared captain for group "${meta.name}" (combatant deleted)`);
    }
  } catch (err) {
    log.error("Error clearing captain on delete", err);
  }

  // Casualty history is data, not automation state. Keep it accurate even
  // while morale prompts/effects are disabled.
  const queueKey = `${combat.id}:${groupId}`;
  const previous = _deletedCountQueues.get(queueKey) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(async () => {
    const current = combat.getFlag(MODULE_ID, `groups.${groupId}.deletedCount`) ?? 0;
    await combat.setFlag(MODULE_ID, `groups.${groupId}.deletedCount`, current + 1);
    log.trace(`Incremented deletedCount for group "${groupId}" to ${current + 1}`);
  });
  _deletedCountQueues.set(queueKey, queued);
  try {
    await queued;
  } catch (err) {
    log.error("Error tracking deleted combatant", err);
  } finally {
    if (_deletedCountQueues.get(queueKey) === queued) _deletedCountQueues.delete(queueKey);
  }
}
