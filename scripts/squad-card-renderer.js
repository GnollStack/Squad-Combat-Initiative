/** Synchronous SCI cards preserve individual Foundry tracker rows. */
import { MODULE_ID, logger, expandStore, canManageGroups, normalizeHtml, escapeHtml, escapeAttribute, sanitizeColor, sanitizeImagePath, localizeEnumValue } from "./shared.js";
import { GroupManager } from "./group-manager.js";
import { MoraleManager } from "./morale.js";
import { hasNativeGroup, normalizeGroupConfig } from "./group-contracts.js";
import { GroupContextMenuManager } from "./group-context-menu.js";
import { attachContextMenu, promptAssignment } from "./combat-tracker.js";
import { SQUAD_CARD_DETAIL, PLAYER_MORALE_VISIBILITY } from "./settings.js";

const nativeLists = new WeakSet();
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

export function groupHeaderRendering() {
  const prototype = ui.combat?.constructor?.prototype;
  if (!prototype || prototype.__sciCardsPatched) return;
  const nativeRender = prototype.renderGroups;
  prototype.renderGroups = function (html) { return renderSquadCards(this, normalizeHtml(html), nativeRender); };
  const nativeHover = prototype.hoverCombatant;
  prototype.hoverCombatant = function (combatant, hover) {
    nativeHover?.call(this, combatant, hover);
    for (const root of [this.element, this.popout?.element].filter(Boolean)) {
      if (!hover) root.querySelectorAll(".sci-hover-expanded").forEach(row => row.classList.remove("sci-hover-expanded"));
      else root.querySelector(selector(combatant.id))?.closest(".sci-combatant-group.collapsed")?.classList.add("sci-hover-expanded");
    }
  };
  prototype.__sciCardsPatched = true;
}

export function renderSquadCards(app, element, nativeRender) {
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
    if (!nativeLists.has(list)) { nativeRender?.call(app, element); nativeLists.add(list); }
    // A tracker may survive a policy reload or another renderer may leave native
    // wrappers behind. Preserve its original rows while removing those headers.
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

function availability(label, reason) {
  // Keep inapplicable actions focusable so keyboard users can discover the reason.
  return `title="${escapeAttribute(t(reason || label))}"${reason ? ` aria-disabled="true" aria-description="${escapeAttribute(t(reason))}"` : ""}`;
}

function button(action, label, icon, reason = null, extra = "") {
  return `<button type="button" data-sci-action="${action}" class="combat-button ${extra}" ${availability(label, reason)}><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${escapeHtml(t(label))}</span></button>`;
}

function makeCard(combat, model, expanded, morale, showMorale, detail) {
  const { group, groupId, manager, captain } = model;
  const row = document.createElement("li");
  row.className = `sci-combatant-group sci-squad-card${expanded ? "" : " collapsed"}${model.active ? " sci-active-group" : ""}${group.hidden ? " sci-hidden" : ""}`;
  row.dataset.groupKey = groupId;
  row.dataset.sciCombatId = combat.id;
  row.style.setProperty("--group-color", sanitizeColor(group.color, "#7b68ee"));
  const count = game.i18n.format(model.members.length === 1 ? "SCI.Card.MemberCountOne" : "SCI.Card.MemberCount", { count: model.members.length });
  const stats = game.i18n.format("SCI.Card.MoraleSummary", { living: model.living, holding: model.holding, broken: model.broken });
  const mode = localizeEnumValue("SCI.InitiativeModeName", group.initiativeMode ?? "average");
  const score = model.initiative === null ? "—" : new Intl.NumberFormat(game.i18n.lang).format(model.initiative);
  const empty = !model.members.length;
  const emptyReason = empty ? "SCI.Card.Unavailable.Empty" : null;
  const full = detail === SQUAD_CARD_DETAIL.FULL;
  const showCaptain = full && (captain || manager && group.initiativeMode === "captain");
  const showSummary = showCaptain || manager && group.hidden || full && showMorale;
  const icon = `<img class="token-image" alt="" src="${escapeAttribute(sanitizeImagePath(group.img, "icons/svg/combat.svg"))}">`;
  const name = manager
    ? `<button type="button" class="name sci-name-button" data-sci-action="rename" title="${escapeAttribute(t("SCI.Card.Rename"))}" aria-label="${escapeAttribute(game.i18n.format("SCI.Card.RenameLabel", { name: group.name }))}">${escapeHtml(group.name)}</button>`
    : `<strong class="name" title="${escapeAttribute(group.name)}">${escapeHtml(group.name)}</strong>`;
  row.innerHTML = `
    <div class="group-header sci-card-heading">
      ${manager ? `<button type="button" class="sci-icon-button" data-sci-action="icon" title="${escapeAttribute(t("SCI.Card.ChangeIcon"))}" aria-label="${escapeAttribute(t("SCI.Card.ChangeIcon"))}">${icon}</button>` : icon}
      <div class="sci-card-title">${name}${detail !== SQUAD_CARD_DETAIL.MINIMAL ? `<div class="sci-card-meta"><span class="group-numbers">${escapeHtml(count)}</span><span class="sci-mode">${escapeHtml(mode)}</span></div>` : ""}</div>
      ${manager ? `<button type="button" class="group-initiative-value" data-sci-action="initiative" ${availability("SCI.Tracker.EditInitiative", emptyReason)} aria-label="${escapeAttribute(t("SCI.Tracker.EditInitiative"))}">${score}</button>` : `<span class="group-initiative-value">${score}</span>`}
      <button type="button" data-sci-action="collapse" class="sci-collapse-toggle" aria-expanded="${expanded}" aria-label="${escapeAttribute(t("SCI.Card.ToggleMembers"))}"><i class="fa-solid fa-chevron-${expanded ? "up" : "down"}" aria-hidden="true"></i></button>
    </div>
    ${showSummary ? `<div class="sci-card-summary">
      ${showCaptain ? captain ? `<span class="sci-captain-label"><i class="fas fa-crown" aria-hidden="true"></i> ${escapeHtml(captain.name)}</span>` : `<span>${escapeHtml(t("SCI.Tracker.NoCaptain"))}</span>` : ""}
      ${group.hidden && manager ? `<span class="sci-hidden-label">${escapeHtml(t("SCI.Card.Hidden"))}</span>` : ""}
      ${full && showMorale ? `<span class="sci-morale-summary">${escapeHtml(stats)}</span>` : ""}</div>` : ""}
    ${manager ? `<div class="group-controls sci-primary-actions">
      ${button("roll", "SCI.Card.Roll", "fa-dice-d20", emptyReason || (!model.unrolled ? "SCI.Card.Unavailable.AllRolled" : null), "group-roll")}
      ${button("skip", "SCI.Card.Skip", "fa-forward-step", !model.active ? "SCI.Card.Unavailable.Inactive" : null, "group-skip-turn")}
      ${morale ? button("morale", "SCI.Card.Morale", "fa-flag", !model.living ? "SCI.Card.Unavailable.NoLiving" : null, "group-morale") + button("rally", "SCI.Card.Rally", "fa-shield", !model.broken ? "SCI.Card.Unavailable.NoBroken" : null, "group-morale-rally") : ""}
    </div><div class="group-controls sci-secondary-actions">
      ${button("pin", group.pinned ? "SCI.Card.Unpin" : "SCI.Card.Pin", "fa-thumbtack", false, `group-pin${group.pinned ? " pinned" : ""}`)}
      ${button("select", "SCI.Card.Select", "fa-object-group", emptyReason, "group-select-tokens")}
      ${button("visibility", group.hidden ? "SCI.Card.Show" : "SCI.Card.Hide", group.hidden ? "fa-eye-slash" : "fa-eye", false, "group-toggle-visibility")}
      ${button("edit", "SCI.Card.Edit", "fa-pen", false, "group-edit")}
      <details class="sci-more"><summary title="${escapeAttribute(t("SCI.Card.More"))}" aria-label="${escapeAttribute(t("SCI.Card.More"))}"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></summary><div>
        ${button("assign", "SCI.Card.AssignSelected", "fa-users")}${button("reset", "SCI.Card.Reset", "fa-rotate-left", emptyReason, "group-reset")}
        ${morale ? button("clear", "SCI.Card.ClearMorale", "fa-eraser", emptyReason, "group-morale-clear") : ""}
        ${button("delete", "SCI.Card.Delete", "fa-trash", false, "group-delete")}
      </div></details>
    </div>` : ""}
    <div class="collapsible-content"><div class="wrapper"><ol class="group-children"></ol></div></div>`;
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
    const setting = game.settings.get(MODULE_ID, "groupTokenHighlight");
    if (setting === "off" || setting === "gm" && !model.manager) return;
    model.members.map(c => c.token?.object).filter(token => token && (model.manager || token.isVisible && token.visible)).forEach(token => highlightToken(token, model.group.color));
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
