/**
 * @file combat-tracker.js
 * @description Enhances the Combat Tracker with "Add Group" buttons and Drag-and-Drop.
 * @version V13 Only
 */

import {
  MODULE_ID,
  logger,
  generateGroupId,
  expandStore,
  isGM,
  normalizeHtml,
} from "./shared.js";
import { GroupContextMenuManager } from "./class-objects.js";

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

  ensureAddGroupButton(element);

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

  const flagGroups = foundry.utils.getProperty(combat, `flags.${MODULE_ID}.groups`) || {};
  const manualPins = foundry.utils.getProperty(combat, `flags.${MODULE_ID}.groupManualOverrides`) || {};

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

  const ContextMenuClass = foundry.applications.ux.ContextMenu.implementation ?? ContextMenu;

  new ContextMenuClass(
    element,
    ".sci-combatant-group > .group-header",
    GroupContextMenuManager.getContextOptions(),
    { jQuery: false }
  );
}

/* ------------------------------------------------------------------ */
/*  Internal DOM Helpers                                              */
/* ------------------------------------------------------------------ */

function ensureAddGroupButton(element) {
  if (element.querySelector(".sci-create-group-button")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.classList.add("sci-create-group-button");
  btn.innerHTML = `<i class="fas fa-plus"></i> Add Group`;
  btn.addEventListener("click", openCreateGroupDialog);

  const controls = element.querySelector(SELECTORS.header);
  if (controls) controls.prepend(btn);
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

function registerDropTargets(combat, element) {
  const log = logger.fn("dragDrop");
  const list = element.querySelector(SELECTORS.list);
  if (!list) return;

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
      const groupId = groupRow.dataset.groupKey;
      const combatantId = ev.dataTransfer.getData("text/plain");
      const combatant = combat.combatants.get(combatantId);

      if (!combatant?.actor) return;

      log.debug("Assigning combatant to group", { 
        combatant: combatant.name, 
        groupId 
      });

      if (isGM()) {
        await combatant.setFlag(MODULE_ID, "groupId", groupId);
      }

      const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
      if (group && Number.isFinite(group.initiative)) {
        await handleGroupInsertionSort(combat, groupId, group.initiative, combatant);
      }

      ui.combat.render();
      log.success("Combatant assigned to group");
    } catch (err) {
      log.errorNotify("Drop-to-group error", err);
    }
  });

  // Drop elsewhere -> ungroup
  list.addEventListener("drop", async (ev) => {
    if (ev.target.closest(SELECTORS.group)) return;

    ev.preventDefault();
    try {
      const combatantId = ev.dataTransfer.getData("text/plain");
      const c = combat.combatants.get(combatantId);
      const oldGroup = c?.getFlag(MODULE_ID, "groupId");

      if (c?.actor && oldGroup && oldGroup !== "ungrouped") {
        log.debug("Ungrouping combatant", { combatant: c.name, oldGroup });

        if (isGM()) {
          await c.unsetFlag(MODULE_ID, "groupId");
        }

        const remaining = combat.combatants.filter(
          (x) => x.getFlag(MODULE_ID, "groupId") === oldGroup
        );
        if (remaining.length === 0 && isGM()) {
          await combat.unsetFlag(MODULE_ID, `groups.${oldGroup}.initiative`);
        }

        ui.combat.render();
        log.success("Combatant ungrouped");
      }
    } catch (err) {
      log.error("Ungroup error", err);
    }
  });
}

async function handleGroupInsertionSort(combat, groupId, baseInit, newCombatant) {
  const existing = combat.combatants.filter(
    (c) =>
      c.getFlag(MODULE_ID, "groupId") === groupId &&
      c.id !== newCombatant.id &&
      Number.isFinite(c.initiative)
  );

  const sorted = [...existing, newCombatant].sort(
    (a, b) => (b.initiative || 0) - (a.initiative || 0)
  );

  const updates = sorted.map((c, i) => ({
    _id: c.id,
    initiative: parseFloat((baseInit + 0.01 + (sorted.length - i) * 0.01).toFixed(2)),
  }));

  if (isGM()) {
    await combat.updateEmbeddedDocuments("Combatant", updates);
  }
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

    log.groupStart("Creating new group", { name: data.name });

    let combat = game.combat;
    if (!combat) {
      combat = await game.combats.documentClass.create({ scene: canvas.scene.id });
      await combat.activate();
      log.trace("Created new combat encounter");
    }

    const groupId = generateGroupId();

    if (isGM()) {
      await combat.setFlag(MODULE_ID, `groups.${groupId}`, {
        name: data.name,
        initiative: null,
        pinned: true,
        img: data.img || "icons/svg/combat.svg",
        color: data.color || "#00ff00",
        hidden: data.hidden ?? false,
      });

      const sel = canvas.tokens.controlled;
      const newCombatants = [];
      const maxSort = Math.max(0, ...combat.combatants.map((c) => c.sort ?? 0));

      const missingTokens = sel.filter(
        (t) => !combat.combatants.some((c) => c.tokenId === t.id)
      );

      if (missingTokens.length) {
        log.trace("Adding tokens to combat", { count: missingTokens.length });
        const createData = missingTokens.map((t, i) => ({
          tokenId: t.id,
          actorId: t.actor?.id,
          sceneId: canvas.scene.id,
          sort: maxSort + (i + 1) * 100,
          hidden: data.hidden,
        }));
        const created = await combat.createEmbeddedDocuments("Combatant", createData);
        newCombatants.push(...created);
      }

      const existingMembers = sel
        .map((t) => combat.combatants.find((c) => c.tokenId === t.id))
        .filter(Boolean);

      newCombatants.push(...existingMembers);

      if (newCombatants.length) {
        const memberUpdates = newCombatants.map((c) => ({
          _id: c.id,
          [`flags.${MODULE_ID}.groupId`]: groupId,
        }));
        await combat.updateEmbeddedDocuments("Combatant", memberUpdates);
      }

      const expandedSet = expandStore.load(combat.id);
      expandedSet.add(groupId);
      expandStore.save(combat.id, expandedSet);

      log.groupEnd("success");
      ui.notifications.info(
        `Created group "${data.name}" with ${newCombatants.length} members.`
      );
    }
  } catch (err) {
    log.groupEnd("failed");
    log.errorNotify("Error creating group", err);
  }
}

async function promptGroupData() {
  const content = `
    <div class="form-group">
      <label>Name:</label>
      <input id="g-name" type="text" value="New Group" autofocus>
    </div>
    <div class="form-group" style="display:flex; gap: 0.5em; align-items:center; margin-top: 5px;">
      <label style="flex:0 0 auto;">Icon:</label>
      <input id="g-img" type="text" style="flex:1" placeholder="icons/svg/skull.svg">
      <button type="button" id="g-img-picker" title="Browse" style="flex:0 0 auto; width:30px;">
        <i class="fas fa-file-import"></i>
      </button>
    </div>
    <div class="form-group" style="margin-top: 5px;">
      <label>Color:</label>
      <input id="g-color" type="color" value="#ffffff" style="width:100%; height:30px; border:none;">
    </div>
    <div class="form-group" style="margin-top: 10px;">
      <label style="display:flex; align-items:center; gap:5px;">
        <input id="g-hidden" type="checkbox"> 
        Start Hidden from Players
      </label>
    </div>
  `;

  return foundry.applications.api.DialogV2.wait({
    window: { title: "Create New Group" },
    content,
    buttons: [
      {
        action: "ok",
        label: "Create",
        icon: "fas fa-check",
        default: true,
        callback: (event, button, dialog) => {
          const form = dialog.element;
          return {
            name: form.querySelector("#g-name").value.trim() || "New Group",
            img: form.querySelector("#g-img").value.trim() || "",
            color: form.querySelector("#g-color").value.trim() || "#000000",
            hidden: form.querySelector("#g-hidden").checked || false,
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
          current: "icons/",
          callback: (path) => { imgInput.value = path; },
        }).render(true);
      });
    },
  });
}