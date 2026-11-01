/** Synchronous SCI cards preserve individual Foundry tracker rows. */
import { MODULE_ID, TEMPLATES, logger, expandStore, canManageGroups, normalizeHtml, escapeHtml, sanitizeColor, sanitizeImagePath, localizeEnumValue } from "./shared.js";
import { GroupManager } from "./group-manager.js";
import { MoraleManager } from "./morale.js";
import { hasNativeGroup, normalizeGroupConfig } from "./group-contracts.js";
import { GroupContextMenuManager } from "./group-context-menu.js";
import { attachContextMenu, promptAssignment } from "./combat-tracker.js";
import { SQUAD_CARD_DETAIL, PLAYER_MORALE_VISIBILITY } from "./settings.js";

let installed = false;
let warnedMissingTemplate = false;
const menuDocuments = new WeakSet();
const pending = new Set();
const trackedTokens = new Set();
const iconPickers = new Map();
const nameEdits = new WeakMap();
const t = key => game.i18n.localize(key);
const selector = id => `li[data-combatant-id="${CSS.escape(id)}"]`;
const keyFor = (combat, id) => `${combat.id}:${id}`;

/** One delegated dismissal handler per document, shared by sidebar and popout. */
function bindMenuDismissal(doc) {
  if (menuDocuments.has(doc)) return;
  menuDocuments.add(doc);
  const dismissOutside = event => {
    const inside = event.target.closest?.(".sci-squad-card .sci-more");
    for (const menu of doc.querySelectorAll(".sci-squad-card .sci-more[open]")) {
      if (menu !== inside) menu.open = false;
    }
  };
  // Capture sees outside clicks even when Foundry controls stop propagation.
  // The listeners only query current DOM; removed cards are never retained.
  doc.addEventListener("click", dismissOutside, true);
  doc.addEventListener("focusin", dismissOutside, true);
}

export function getSquadCardModel(combat, groupId, manager = canManageGroups()) {
  const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
  if (!group) return null;
  const allMembers = Array.from(combat.turns ?? combat.combatants).filter(c => c.getFlag(MODULE_ID, "groupId") === groupId && !hasNativeGroup(c));
  const members = manager ? allMembers : allMembers.filter(c => !c.hidden && c.visible !== false);
  if (!manager && (group.hidden || !members.length)) return null;
  const living = members.filter(c => !(c.isDefeated ?? c.defeated) && !(Number.isFinite(c.actor?.system?.attributes?.hp?.value) && c.actor.system.attributes.hp.value <= 0));
  return {
    groupId, group, manager, members, captain: members.find(c => c.id === group.captainId),
    living: living.length, broken: living.filter(c => c.getFlag(MODULE_ID, "moraleStatus") === "failed").length,
    holding: living.filter(c => c.getFlag(MODULE_ID, "moraleStatus") === "passed").length,
    active: members.some(c => c.id === combat.combatant?.id), unrolled: members.some(c => !Number.isFinite(c.initiative)),
    initiative: Number.isFinite(group.initiative) ? group.initiative : null,
  };
}

/**
 * Register the tracker wrappers once through libWrapper. libWrapper is a declared requirement; without it SCI
 * renders no cards. Both wrappers use WRAPPER mode and always call the native method first: under SCI's
 * createGroups wrapper the native renderer receives no groups, so chaining it each render costs nothing and
 * keeps other modules' wrappers in the chain.
 */
export function groupHeaderRendering() {
  if (installed) return;
  if (!game.modules.get("lib-wrapper")?.active) {
    logger.warn("libWrapper is not active; squad cards are not rendered");
    return;
  }
  if (typeof CONFIG.ui?.combat?.prototype?.renderGroups !== "function") {
    logger.warn("The configured combat tracker has no renderGroups method; squad cards are not rendered");
    return;
  }
  libWrapper.register(MODULE_ID, "CONFIG.ui.combat.prototype.renderGroups", function (wrapped, html) {
    wrapped(html);
    renderSquadCards(this, normalizeHtml(html));
  }, "WRAPPER");
  libWrapper.register(MODULE_ID, "CONFIG.ui.combat.prototype.hoverCombatant", function (wrapped, combatant, hover) {
    wrapped(combatant, hover);
    for (const root of [this.element, this.popout?.element].filter(Boolean)) {
      if (!hover) root.querySelectorAll(".sci-hover-expanded").forEach(row => row.classList.remove("sci-hover-expanded"));
      else root.querySelector(selector(combatant.id))?.closest(".sci-combatant-group.collapsed")?.classList.add("sci-hover-expanded");
    }
  }, "WRAPPER");
  // Diagnostics marker only; the behavior lives in the libWrapper registrations above.
  CONFIG.ui.combat.prototype.__sciCardsPatched = true;
  installed = true;
}

export function renderSquadCards(app, element) {
  if (app._isRenderingGroups) return;
  app._isRenderingGroups = true;
  const editor = nameEdits.get(app);
  const selection = editor && [editor.input.selectionStart, editor.input.selectionEnd];
  if (editor) editor.input.sciRendering = true;
  try {
    const combat = app.viewed;
    const list = element?.querySelector("[data-application-part='tracker'] ol, .combat-tracker");
    if (!list || !combat) return;
    bindMenuDismissal(list.ownerDocument);
    list.dataset.sciCombatId = combat.id;
    // The native renderer has already run through the libWrapper chain. A tracker may survive a
    // policy reload or another renderer may leave native wrappers behind. Preserve its original
    // rows while removing those headers.
    list.querySelectorAll("li.combatant-group").forEach(row => {
      row.querySelectorAll("li[data-combatant-id]").forEach(child => row.before(child));
      row.remove();
    });
    clearAllTokenHighlights();
    list.querySelectorAll(".sci-member-decoration").forEach(node => node.remove());
    list.querySelectorAll(".sci-captain, .sci-captain-dead").forEach(node => node.classList.remove("sci-captain", "sci-captain-dead"));
    list.querySelectorAll("li.sci-combatant-group[data-group-key]").forEach(row => {
      row.querySelectorAll(".group-children > li[data-combatant-id]").forEach(child => row.before(child));
      row.remove();
    });
    list.querySelectorAll(".sci-ungrouped-drop").forEach(node => node.remove());
    const expanded = expandStore.load(combat.id);
    const manager = canManageGroups();
    const morale = game.settings.get(MODULE_ID, "moraleEnabled") === true;
    const showMorale = morale && (manager || game.settings.get(MODULE_ID, "playerMoraleVisibility") === PLAYER_MORALE_VISIBILITY.VISIBLE_MEMBERS);
    const preference = manager ? game.settings.get(MODULE_ID, "gmSquadCardDetail") : SQUAD_CARD_DETAIL.FULL;
    const detail = Object.values(SQUAD_CARD_DETAIL).includes(preference) ? preference : SQUAD_CARD_DETAIL.FULL;
    for (const groupId of Object.keys(combat.getFlag(MODULE_ID, "groups") ?? {})) {
      const model = getSquadCardModel(combat, groupId, manager);
      if (!model) {
        for (const member of combat.combatants) {
          if (member.getFlag(MODULE_ID, "groupId") === groupId && !hasNativeGroup(member)) list.querySelector(selector(member.id))?.remove();
        }
        continue;
      }
      const row = makeCard(combat, model, expanded.has(groupId), morale, showMorale, detail);
      if (!row) {
        if (!warnedMissingTemplate) logger.warn("The squad card template is not loaded; member rows stay ungrouped until it is");
        warnedMissingTemplate = true;
        continue;
      }
      const children = model.members.map(c => list.querySelector(selector(c.id))).filter(Boolean);
      if (children.length) children[0].before(row); else list.append(row);
      row.querySelector(".group-children").replaceChildren(...children);
      if (!children.length) row.querySelector(".group-children").innerHTML = `<li class="no-members">${escapeHtml(t("SCI.Tracker.NoMembers"))}</li>`;
      for (const member of model.members) decorateMember(row, member, model, showMorale);
      bindCard(row, combat, model, app);
      if (manager && editor?.combatId === combat.id && editor.groupId === groupId) {
        row.querySelector('[data-sci-action="rename"]').replaceWith(editor.input);
      }
    }
    if (manager) {
      const drop = document.createElement("li");
      drop.className = "sci-ungrouped-drop";
      drop.dataset.sciCombatId = combat.id;
      drop.textContent = t("SCI.Card.UngroupedDrop");
      list.append(drop);
      attachContextMenu(element);
    }
  } catch (error) { logger.error("Could not render squad cards", error); }
  finally {
    if (editor) {
      const { input } = editor;
      if (input.isConnected) { input.focus(); input.setSelectionRange(...selection); }
      else if (nameEdits.get(app) === editor) nameEdits.delete(app);
      delete input.sciRendering;
    }
    app._isRenderingGroups = false;
  }
}

/** The compiled card template, registered as a Handlebars partial by preloadTemplates(); null until loaded. */
function cardTemplate() {
  const template = globalThis.Handlebars?.partials?.[TEMPLATES.SQUAD_CARD];
  return typeof template === "function" ? template : null;
}

/** Button descriptor for the template. Inapplicable actions stay focusable so keyboard users can discover the reason. */
function button(action, label, icon, reason = null, extra = "") {
  return { action, classes: `combat-button ${extra}`.trim(), icon, label: t(label), title: t(reason || label), reason: reason ? t(reason) : null };
}

/** Build one card row. Returns null when the template has not been loaded yet. */
function makeCard(combat, model, expanded, morale, showMorale, detail) {
  const template = cardTemplate();
  if (!template) return null;
  const { group, groupId, manager, captain } = model;
  const row = document.createElement("li");
  row.className = `sci-combatant-group sci-squad-card${expanded ? "" : " collapsed"}${model.active ? " sci-active-group" : ""}${group.hidden ? " sci-hidden" : ""}`;
  row.dataset.groupKey = groupId;
  row.dataset.sciCombatId = combat.id;
  row.style.setProperty("--group-color", sanitizeColor(group.color, "#7b68ee"));
  const empty = !model.members.length;
  const emptyReason = empty ? "SCI.Card.Unavailable.Empty" : null;
  const full = detail === SQUAD_CARD_DETAIL.FULL;
  const showCaptain = full && (captain || manager && group.initiativeMode === "captain");
  const showHidden = group.hidden && manager;
  const showMoraleSummary = full && showMorale;
  const primary = [
    button("roll", "SCI.Card.Roll", "fa-dice-d20", emptyReason || (!model.unrolled ? "SCI.Card.Unavailable.AllRolled" : null), "group-roll"),
    button("skip", "SCI.Card.Skip", "fa-forward-step", !model.active ? "SCI.Card.Unavailable.Inactive" : null, "group-skip-turn"),
  ];
  if (morale) primary.push(
    button("morale", "SCI.Card.Morale", "fa-flag", !model.living ? "SCI.Card.Unavailable.NoLiving" : null, "group-morale"),
    button("rally", "SCI.Card.Rally", "fa-shield", !model.broken ? "SCI.Card.Unavailable.NoBroken" : null, "group-morale-rally"),
  );
  const secondary = [
    button("pin", group.pinned ? "SCI.Card.Unpin" : "SCI.Card.Pin", "fa-thumbtack", null, `group-pin${group.pinned ? " pinned" : ""}`),
    button("select", "SCI.Card.Select", "fa-object-group", emptyReason, "group-select-tokens"),
    button("visibility", group.hidden ? "SCI.Card.Show" : "SCI.Card.Hide", group.hidden ? "fa-eye-slash" : "fa-eye", null, "group-toggle-visibility"),
    button("edit", "SCI.Card.Edit", "fa-pen", null, "group-edit"),
  ];
  const more = [button("assign", "SCI.Card.AssignSelected", "fa-users"), button("reset", "SCI.Card.Reset", "fa-rotate-left", emptyReason, "group-reset")];
  if (morale) more.push(button("clear", "SCI.Card.ClearMorale", "fa-eraser", emptyReason, "group-morale-clear"));
  more.push(button("delete", "SCI.Card.Delete", "fa-trash", null, "group-delete"));
  row.innerHTML = template({
    manager, expanded, chevron: expanded ? "up" : "down",
    iconSrc: sanitizeImagePath(group.img, "icons/svg/combat.svg"), changeIconLabel: t("SCI.Card.ChangeIcon"),
    name: group.name, renameTitle: t("SCI.Card.Rename"), renameLabel: game.i18n.format("SCI.Card.RenameLabel", { name: group.name }),
    showMeta: detail !== SQUAD_CARD_DETAIL.MINIMAL,
    count: game.i18n.format(model.members.length === 1 ? "SCI.Card.MemberCountOne" : "SCI.Card.MemberCount", { count: model.members.length }),
    mode: localizeEnumValue("SCI.InitiativeModeName", group.initiativeMode ?? "average"),
    score: model.initiative === null ? "—" : new Intl.NumberFormat(game.i18n.lang).format(model.initiative),
    initiativeLabel: t("SCI.Tracker.EditInitiative"), initiativeTitle: t(emptyReason || "SCI.Tracker.EditInitiative"), initiativeReason: emptyReason ? t(emptyReason) : null,
    toggleLabel: t("SCI.Card.ToggleMembers"),
    showSummary: showCaptain || showHidden || showMoraleSummary,
    showCaptain, captainName: captain?.name ?? null, noCaptainLabel: t("SCI.Tracker.NoCaptain"),
    showHidden, hiddenLabel: t("SCI.Card.Hidden"),
    showMorale: showMoraleSummary, moraleSummary: game.i18n.format("SCI.Card.MoraleSummary", { living: model.living, holding: model.holding, broken: model.broken }),
    moreLabel: t("SCI.Card.More"), primary, secondary, more,
  });
  if (pending.has(keyFor(combat, groupId))) setPending(row);
  return row;
}

function decorateMember(row, member, model, morale) {
  const li = row.querySelector(selector(member.id));
  const controls = li?.querySelector(".combatant-controls");
  if (!controls) return;
  li.classList.toggle("sci-captain", member.id === model.group.captainId);
  const status = member.getFlag(MODULE_ID, "moraleStatus");
  if (morale && status) {
    const icon = document.createElement("span");
    icon.className = `sci-member-decoration sci-morale-icon sci-morale-${status}`;
    icon.textContent = status === "passed" ? "◆" : "⚑";
    icon.title = t(status === "passed" ? "SCI.Tracker.MoraleHolding" : "SCI.Tracker.MoraleBroken");
    controls.prepend(icon);
  }
  if (!model.manager) return;
  const actions = [["captain", "SCI.Tracker.Captain", "fa-crown"], ["assignMember", "SCI.Card.Assign", "fa-users"]];
  if (morale) actions.push(["singleMorale", "SCI.Card.Morale", "fa-flag"]);
  for (const [action, label, icon] of actions) {
    const control = document.createElement("button");
    control.type = "button"; control.className = "sci-member-decoration sci-member-action";
    control.dataset.sciAction = action; control.dataset.memberId = member.id;
    control.title = t(label); control.setAttribute("aria-label", t(label));
    control.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
    controls.prepend(control);
  }
}

function setPending(row) {
  row.setAttribute("aria-busy", "true");
  row.querySelectorAll("button[data-sci-action]:not([data-sci-action='collapse'])").forEach(control => {
    control.disabled = true;
    control.setAttribute("aria-disabled", "true");
    control.title = t("SCI.Card.Unavailable.Pending");
    control.setAttribute("aria-description", control.title);
  });
}

function bindCard(row, combat, model, app) {
  const { groupId } = model;
  row.addEventListener("click", async event => {
    const control = event.target.closest("[data-sci-action]");
    if (!control) return;
    event.stopPropagation();
    if (control.disabled || control.getAttribute("aria-disabled") === "true") { event.preventDefault(); return; }
    const menu = control.closest(".sci-more");
    if (menu) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
    const action = control.dataset.sciAction;
    if (action === "collapse") {
      expandStore.setExpanded(combat.id, groupId, row.classList.contains("collapsed"));
      app.render(); return;
    }
    if (!model.manager || pending.has(keyFor(combat, groupId))) return;
    if (action === "rename") { editGroupName(control, combat, groupId, app); return; }
    if (action === "icon") { await pickGroupIcon(combat, groupId, app); return; }
    if (action === "initiative") { editInitiative(row, control, combat, groupId, app); return; }
    const key = keyFor(combat, groupId);
    pending.add(key); setPending(row);
    try {
      if (!game.combats.get(combat.id)?.getFlag(MODULE_ID, `groups.${groupId}`)) throw new Error(t("SCI.Errors.StaleDocument"));
      const current = combat.getFlag(MODULE_ID, `groups.${groupId}`);
      const memberId = control.dataset.memberId;
      if (action === "roll") await GroupManager.rollGroupAndApplyInitiative(combat, groupId, { mode: event.altKey ? "advantage" : event.ctrlKey || event.metaKey ? "disadvantage" : "normal" });
      else if (action === "skip") await GroupManager.skipGroupTurn(combat, groupId);
      else if (action === "morale") await MoraleManager.rollMorale(combat, groupId);
      else if (action === "rally") await MoraleManager.rallyMorale(combat, groupId);
      else if (action === "clear") await MoraleManager.clearMorale(combat, groupId);
      else if (action === "pin") await GroupManager.editGroup(combat, groupId, { pinned: !current.pinned });
      else if (action === "visibility") await GroupManager.toggleGroupVisibility(combat, groupId);
      else if (action === "edit") await GroupContextMenuManager.getContextOptions()[0].callback(row);
      else if (action === "delete") await GroupManager.deleteGroup(combat, groupId);
      else if (action === "reset") {
        if (await foundry.applications.api.DialogV2.confirm({ window: { title: t("SCI.Card.Reset") }, content: `<p>${escapeHtml(t("SCI.Dialog.ResetContent"))}</p>` })) await GroupManager.resetGroupInitiative(combat, groupId);
      } else if (action === "select") {
        canvas.tokens.releaseAll();
        model.members.map(c => c.token?.object).filter(token => token?.document?.parent?.id === canvas.scene?.id).forEach(token => token.control({ releaseOthers: false }));
      } else if (action === "assign") {
        const ids = canvas.tokens.controlled.flatMap(token => combat.combatants.filter(c => c.token?.uuid === token.document.uuid).map(c => c.id));
        await GroupManager.moveCombatants(combat, groupId, ids);
      } else if (action === "assignMember") await promptAssignment(combat, [memberId]);
      else if (action === "captain") {
        if (current.captainId === memberId) await GroupManager.removeCaptain(combat, groupId);
        else await GroupManager.setCaptain(combat, groupId, memberId);
      } else if (action === "singleMorale") await MoraleManager.rollMoraleSingle(combat, groupId, memberId);
    } catch (error) { ui.notifications.error(error.message); }
    finally { pending.delete(key); app.render(); }
  });
  row.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    const menus = row.querySelectorAll(".sci-more[open]");
    if (!menus.length) return;
    event.preventDefault(); event.stopPropagation();
    menus.forEach(menu => { menu.open = false; menu.querySelector("summary").focus(); });
  });
  const header = row.querySelector(".group-header");
  header.addEventListener("mouseenter", () => {
    highlightSquadTokens(model);
  });
  header.addEventListener("mouseleave", clearAllTokenHighlights);
}

/** Resolve the captured encounter again when a delayed editor/picker commits. */
function appearanceGroup(combat, groupId) {
  if (!canManageGroups()) throw new Error(t("SCI.Errors.ManagerRequired"));
  const group = game.combats.get(combat.id) === combat && combat.getFlag(MODULE_ID, `groups.${groupId}`);
  if (!group) throw new Error(t("SCI.Errors.StaleDocument"));
  return group;
}

async function saveAppearance(combat, groupId, data, app) {
  const key = keyFor(combat, groupId);
  let saving = false;
  try {
    const group = appearanceGroup(combat, groupId);
    const changes = normalizeGroupConfig(data, { combat, groupId });
    if (Object.entries(changes).every(([field, value]) => group[field] === value)) return;
    if (pending.has(key)) throw new Error(t("SCI.Card.Unavailable.Pending"));
    pending.add(key); saving = true;
    if (app.viewed === combat) app.element?.querySelectorAll(".sci-squad-card").forEach(row => {
      if (row.dataset.groupKey === groupId) setPending(row);
    });
    await GroupManager.editGroup(combat, groupId, changes);
  } catch (error) { ui.notifications.error(error.message); }
  finally {
    if (saving) pending.delete(key);
    if (app.element?.isConnected) renderSquadCards(app, app.element);
  }
}

function editGroupName(control, combat, groupId, app) {
  const input = control.ownerDocument.createElement("input");
  input.type = "text"; input.className = "sci-group-name-edit"; input.maxLength = 200; input.required = true;
  input.setAttribute("aria-label", t("SCI.Card.Rename")); input.title = t("SCI.Card.RenameHint");
  input.value = combat.getFlag(MODULE_ID, `groups.${groupId}.name`) ?? "";
  const original = input.value;
  const editor = { input, combatId: combat.id, groupId };
  nameEdits.set(app, editor);
  let finished = false;
  const finish = async (commit, restoreFocus = false) => {
    if (finished || input.sciRendering) return;
    let name;
    if (commit) {
      try { name = normalizeGroupConfig({ name: input.value }).name; }
      catch (error) {
        if (restoreFocus) { input.setCustomValidity(error.message); input.reportValidity(); return; }
        commit = false; // An invalid name abandoned by blur cancels the edit.
      }
    }
    finished = true;
    if (nameEdits.get(app) === editor) nameEdits.delete(app);
    const connected = input.isConnected;
    input.replaceWith(control);
    if (commit && connected && name !== original) await saveAppearance(combat, groupId, { name }, app);
    if (restoreFocus && app.viewed === combat) {
      app.element?.querySelector(`[data-group-key="${CSS.escape(groupId)}"] [data-sci-action="rename"]`)?.focus();
    }
  };
  input.addEventListener("input", () => input.setCustomValidity(""));
  // A native tracker redraw can detach the field before SCI renders its new list.
  // Keep the draft in the per-tracker WeakMap until that list is ready.
  input.addEventListener("blur", () => { if (input.isConnected) void finish(true); });
  input.addEventListener("keydown", event => {
    // Prevent Foundry shortcuts while editing; Enter during IME composition is text input.
    event.stopPropagation();
    if (event.isComposing || !["Enter", "Escape"].includes(event.key)) return;
    event.preventDefault(); void finish(event.key === "Enter", true);
  });
  control.replaceWith(input); input.focus(); input.select();
}

async function pickGroupIcon(combat, groupId, app) {
  const key = keyFor(combat, groupId);
  let picker;
  try {
    const group = appearanceGroup(combat, groupId);
    const existing = iconPickers.get(key);
    if (existing) { existing.bringToFront(); return; }
    let selected = false;
    picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image", current: sanitizeImagePath(group.img, "icons/svg/combat.svg"),
      callback: async path => {
        if (selected || !path) return;
        selected = true;
        // Foundry does not await this callback; saveAppearance handles failures.
        await saveAppearance(combat, groupId, { img: path }, app);
      },
    });
    iconPickers.set(key, picker);
    picker.addEventListener("close", () => { if (iconPickers.get(key) === picker) iconPickers.delete(key); }, { once: true });
    await picker.render({ force: true });
  } catch (error) {
    if (picker && iconPickers.get(key) === picker) iconPickers.delete(key);
    ui.notifications.error(error.message);
  }
}

function editInitiative(row, control, combat, groupId, app) {
  if (row.querySelector(".group-initiative-edit")) return;
  const input = document.createElement("input");
  input.type = "number"; input.step = "any"; input.className = "group-initiative-edit";
  input.setAttribute("aria-label", t("SCI.Tracker.EditInitiative"));
  input.value = combat.getFlag(MODULE_ID, `groups.${groupId}.initiative`) ?? "";
  control.replaceWith(input); input.focus(); input.select();
  let finished = false;
  const finish = async commit => {
    if (finished) return;
    if (commit && !Number.isFinite(input.valueAsNumber)) { input.setCustomValidity(t("SCI.Notifications.InvalidInitiative")); input.reportValidity(); return; }
    finished = true;
    const key = keyFor(combat, groupId);
    pending.add(key); setPending(row); input.disabled = true;
    try { if (commit) await GroupManager.setGroupInitiative(combat, groupId, input.valueAsNumber); }
    catch (error) { ui.notifications.error(error.message); }
    finally { pending.delete(key); app.render(); }
  };
  input.addEventListener("blur", () => void finish(true));
  input.addEventListener("keydown", event => {
    if (!["Enter", "Escape"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); void finish(event.key === "Enter");
  });
}

/** Highlights a squad's tokens when the highlight setting allows it for this user. */
export function highlightSquadTokens(model) {
  const setting = game.settings.get(MODULE_ID, "groupTokenHighlight");
  if (setting === "off" || setting === "gm" && !model.manager) return;
  model.members.map(c => c.token?.object).filter(token => token && (model.manager || token.isVisible && token.visible)).forEach(token => highlightToken(token, model.group.color));
}

function highlightToken(token, color) {
  if (!token.mesh || token._sciGroupHighlight) return;
  const graphics = new PIXI.Graphics();
  const size = Math.max(token.document.width, token.document.height) * canvas.grid.size;
  graphics.lineStyle(3, Number.parseInt(sanitizeColor(color, "#7b68ee").slice(1), 16), 0.9);
  graphics.drawCircle(size / 2, size / 2, size / 2 + 5);
  token.addChild(graphics); token._sciGroupHighlight = graphics; trackedTokens.add(token);
}

/** @returns {void} */
export function clearAllTokenHighlights() {
  for (const token of trackedTokens) {
    if (!token._sciGroupHighlight) continue;
    token.removeChild(token._sciGroupHighlight); token._sciGroupHighlight.destroy(); token._sciGroupHighlight = null;
  }
  trackedTokens.clear();
}
