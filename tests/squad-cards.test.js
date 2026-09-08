import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { environment, combat, settings, MID } from "./fixtures.js";
environment();
const { renderSquadCards, getSquadCardModel } = await import("../scripts/squad-card-renderer.js");
const { expandStore, renderBatcher } = await import("../scripts/shared.js");
const { parseCombatantDrop, promptAssignment } = await import("../scripts/combat-tracker.js");
const { GroupManager } = await import("../scripts/group-manager.js");
const { registerSettings } = await import("../scripts/settings.js");

function fixture() {
  environment();
  const dom = new JSDOM('<main><ol class="combat-tracker"></ol></main>', { url: "https://foundry.test" });
  for (const key of ["window", "document", "HTMLElement", "localStorage"]) globalThis[key] = dom.window[key];
  globalThis.CSS = { escape: value => value };
  foundry.applications.ux = { ContextMenu: { implementation: class {} } };
  const doc = combat(); const element = document.querySelector("main");
  const app = { viewed: doc, element, render() { renderSquadCards(this, this.element); } };
  for (const member of doc.combatants) {
    const row = document.createElement("li"); row.dataset.combatantId = member.id;
    row.innerHTML = `<strong>${member.name}</strong><div class="combatant-controls"></div>`;
    element.querySelector("ol").append(row);
  }
  return { dom, doc, element, app };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("repeated rendering keeps original member nodes and one set of cards and controls", () => {
  const { doc, app, element } = fixture(); const original = element.querySelector('[data-combatant-id="a1"]');
  let nativeCalls = 0; const native = () => { nativeCalls++; };
  renderSquadCards(app, element, native); renderSquadCards(app, element, native);
  assert.equal(nativeCalls, 1); assert.equal(element.querySelectorAll(".sci-combatant-group").length, 2);
  assert.equal(element.querySelectorAll("[data-combatant-id]").length, 3);
  assert.equal(element.querySelector('[data-combatant-id="a1"]'), original);
  assert.equal(original.querySelectorAll('[data-sci-action="assignMember"]').length, 1);
  assert.equal(element.querySelectorAll(".sci-ungrouped-drop").length, 1);
  const card = element.querySelector('[data-group-key="a"]');
  assert.equal(card.querySelector('[data-sci-action="collapse"]').getAttribute("aria-expanded"), "false");
  card.querySelector('[data-sci-action="collapse"]').click();
  assert.ok(expandStore.load(doc.id).has("a")); assert.equal(element.querySelector('[data-group-key="a"]').classList.contains("collapsed"), false);
});

test("player summaries exclude hidden captains, hidden members, empty groups and all-hidden groups", () => {
  const { doc, app, element } = fixture(); game.user = { id: "player", isGM: false, role: 1 };
  doc.getFlag(MID, "groups.a").captainId = "a1"; doc.combatants[0].hidden = true; doc.combatants[2].hidden = true;
  doc.getFlag(MID, "groups").empty = { name: "Empty" };
  const model = getSquadCardModel(doc, "a"); assert.equal(model.members.length, 1); assert.equal(model.captain, undefined);
  assert.equal(getSquadCardModel(doc, "b"), null); assert.equal(getSquadCardModel(doc, "empty"), null);
  element.querySelector('[data-combatant-id="a1"]').remove(); element.querySelector('[data-combatant-id="b1"]').remove();
  renderSquadCards(app, element); assert.equal(element.querySelectorAll(".sci-combatant-group").length, 1);
  assert.equal(element.querySelector(".sci-captain-label"), null); assert.equal(element.querySelector(".sci-primary-actions"), null);
  assert.equal(element.querySelector("[data-sci-action=assignMember]"), null);
  assert.equal(element.querySelector('[data-sci-action="rename"]'), null);
  assert.equal(element.querySelector('[data-sci-action="icon"]'), null);
});

test("players see morale totals for permitted members only, and no summary when morale is off", () => {
  const { doc, app, element } = fixture(); game.user = { id: "player", isGM: false, role: 1 };
  doc.combatants[0].hidden = true;
  doc.combatants[0].flags[MID].moraleStatus = "passed";
  doc.combatants[1].flags[MID].moraleStatus = "failed";
  element.querySelector('[data-combatant-id="a1"]').remove();
  renderSquadCards(app, element);
  const stats = element.querySelector('[data-group-key="a"] .sci-morale-summary').textContent;
  assert.ok(stats.includes('"living":1')); assert.ok(stats.includes('"holding":0')); assert.ok(stats.includes('"broken":1'));
  settings.set("moraleEnabled", false); renderSquadCards(app, element);
  assert.equal(element.querySelector(".sci-morale-summary"), null);
});

test("Holding and Broken count only living members without changing stored morale", () => {
  const { doc } = fixture();
  const [first, second] = doc.combatants;
  first.flags[MID].moraleStatus = "passed"; second.flags[MID].moraleStatus = "failed";
  for (const manager of [true, false]) {
    let model = getSquadCardModel(doc, "a", manager);
    assert.deepEqual([model.living, model.holding, model.broken], [2, 1, 1]);
    first.defeated = true; second.actor.system.attributes.hp.value = 0;
    model = getSquadCardModel(doc, "a", manager);
    assert.deepEqual([model.living, model.holding, model.broken], [0, 0, 0]);
    first.defeated = false; second.actor.system.attributes.hp.value = 10;
  }
  assert.equal(first.getFlag(MID, "moraleStatus"), "passed");
  assert.equal(second.getFlag(MID, "moraleStatus"), "failed");
});

test("player morale visibility removes both summaries and badges and restores them on render", () => {
  const { doc, app, element } = fixture(); game.user = { id: "player", isGM: false, role: 1 };
  doc.combatants[0].flags[MID].moraleStatus = "passed";
  doc.combatants[1].flags[MID].moraleStatus = "failed";
  settings.set("playerMoraleVisibility", "gm"); renderSquadCards(app, element);
  assert.equal(element.querySelector(".sci-morale-summary"), null);
  assert.equal(element.querySelector(".sci-morale-icon"), null);
  assert.equal(element.querySelector(".sci-card-summary"), null);
  settings.set("playerMoraleVisibility", "visible"); renderSquadCards(app, element);
  assert.equal(element.querySelectorAll(".sci-morale-icon").length, 2);
  assert.ok(element.querySelector(".sci-morale-summary"));
  settings.set("moraleEnabled", false); renderSquadCards(app, element);
  assert.equal(element.querySelector(".sci-morale-icon"), null);
});

test("GM detail levels preserve controls, hidden indicators, member rows and player displays", () => {
  const { doc, app, element } = fixture();
  Object.assign(doc.getFlag(MID, "groups.a"), { captainId: "a1", hidden: true });
  doc.combatants[0].flags[MID].moraleStatus = "passed";
  const original = element.querySelector('[data-combatant-id="a1"]');
  const flags = JSON.stringify(doc.flags);
  settings.set("playerMoraleVisibility", "gm");
  for (const role of [4, 3]) {
    game.user = { id: `manager-${role}`, isGM: role === 4, role };
    for (const detail of ["full", "compact", "minimal", "invalid"]) {
      settings.set("gmSquadCardDetail", detail); renderSquadCards(app, element);
      const card = element.querySelector('[data-group-key="a"]'), full = ["full", "invalid"].includes(detail);
      assert.equal(!!card.querySelector(".sci-card-meta"), detail !== "minimal");
      assert.equal(!!card.querySelector(".sci-captain-label"), full);
      assert.equal(!!card.querySelector(".sci-morale-summary"), full);
      assert.ok(card.querySelector(".sci-hidden-label"));
      assert.ok(card.querySelector('[data-sci-action="morale"]'));
      assert.ok(card.querySelector('[data-sci-action="rename"]'));
      assert.ok(card.querySelector('[data-sci-action="icon"]'));
      assert.ok(card.querySelector(".sci-morale-icon"));
      assert.equal(card.querySelector('[data-combatant-id="a1"]'), original);
    }
  }
  assert.equal(JSON.stringify(doc.flags), flags);
  doc.getFlag(MID, "groups.a").hidden = false;
  game.user = { id: "player", isGM: false, role: 1 };
  settings.set("gmSquadCardDetail", "minimal"); settings.set("playerMoraleVisibility", "visible");
  renderSquadCards(app, element);
  assert.ok(element.querySelector(".sci-card-meta")); assert.ok(element.querySelector(".sci-morale-summary"));
});

test("display settings have independent user/world scope and refresh sidebar and popout", async () => {
  const { app, element } = fixture(), registrations = new Map();
  game.settings.register = (_module, key, metadata) => registrations.set(key, metadata);
  registerSettings();
  const detail = registrations.get("gmSquadCardDetail"), visibility = registrations.get("playerMoraleVisibility");
  assert.equal(detail.scope, "user"); assert.equal(detail.default, "full"); assert.equal(detail.config, true);
  assert.equal(visibility.scope, "world"); assert.equal(visibility.default, "visible");
  game.user = { id: "player", isGM: false, role: 1 }; assert.equal(detail.config, false);
  game.user = { id: "assistant", isGM: false, role: 3 }; assert.equal(detail.config, true);
  const otherRoot = element.cloneNode(true); document.body.append(otherRoot);
  const calls = [];
  ui.combat = { ...app, renderGroups(root) { calls.push("sidebar"); renderSquadCards(this, root); },
    popout: { ...app, element: otherRoot, renderGroups(root) { calls.push("popout"); renderSquadCards(this, root); } } };
  renderSquadCards(ui.combat, element); renderSquadCards(ui.combat.popout, otherRoot);
  settings.set("gmSquadCardDetail", "minimal"); detail.onChange("minimal");
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(calls.sort(), ["popout", "sidebar"]);
  assert.equal(document.querySelector(".sci-card-meta"), null);
  game.user = { id: "player", isGM: false, role: 1 };
  settings.set("playerMoraleVisibility", "gm"); visibility.onChange("gm");
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(document.querySelector(".sci-morale-summary"), null);
});

test("unavailable actions explain their state and cannot execute while keyboard focus remains available", () => {
  const { doc, app, element } = fixture();
  renderSquadCards(app, element);
  const checks = [["a", "roll", "AllRolled"], ["b", "skip", "Inactive"], ["a", "rally", "NoBroken"]];
  const original = GroupManager.rollGroupAndApplyInitiative; let calls = 0;
  GroupManager.rollGroupAndApplyInitiative = () => { calls++; };
  try {
    for (const [group, action, reason] of checks) {
      const control = element.querySelector(`[data-group-key="${group}"] [data-sci-action="${action}"]`);
      assert.equal(control.getAttribute("aria-disabled"), "true");
      assert.equal(control.title, `SCI.Card.Unavailable.${reason}`);
      assert.equal(control.getAttribute("aria-description"), control.title);
      control.focus(); assert.equal(document.activeElement, control); control.click();
    }
    assert.equal(calls, 0);
    for (const member of doc.combatants) member.defeated = true;
    renderSquadCards(app, element);
    assert.equal(element.querySelector('[data-sci-action="morale"]').title, "SCI.Card.Unavailable.NoLiving");
    doc.getFlag(MID, "groups").empty = { name: "Empty" }; renderSquadCards(app, element);
    const empty = element.querySelector('[data-group-key="empty"]');
    assert.equal(empty.querySelector('[data-sci-action="roll"]').title, "SCI.Card.Unavailable.Empty");
    assert.equal(empty.querySelector('[data-sci-action="initiative"]').getAttribute("aria-disabled"), "true");
  } finally { GroupManager.rollGroupAndApplyInitiative = original; }
});

test("clicking a squad title renames once, trims text and preserves initiative and collapse state", async () => {
  const { doc, app, element } = fixture();
  const group = doc.getFlag(MID, "groups.a"); Object.assign(group, { initiativeSource: "manual", initiativeInputs: "saved-inputs" });
  const before = structuredClone(group), turns = doc.turns.map(c => [c.id, c.initiative]);
  renderSquadCards(app, element);
  const title = element.querySelector('[data-group-key="a"] [data-sci-action="rename"]');
  assert.equal(title.tagName, "BUTTON"); title.click();
  const input = element.querySelector(".sci-group-name-edit");
  assert.equal(document.activeElement, input); assert.equal(input.value, "A");
  input.value = "  Iron Guard  ";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  input.dispatchEvent(new window.Event("blur")); await tick();
  assert.deepEqual(group, { ...before, name: "Iron Guard" });
  assert.deepEqual(doc.turns.map(c => [c.id, c.initiative]), turns);
  assert.equal(doc.writes.filter(write => `flags.${MID}.groups.a.name` in write.changes).length, 1);
  assert.equal(element.querySelector('[data-group-key="a"] .name').textContent, "Iron Guard");
  assert.ok(element.querySelector('[data-group-key="a"]').classList.contains("collapsed"));
});

test("inline names survive card refresh, cancel with Escape and validate before saving on blur", async () => {
  const { doc, app, element } = fixture(); renderSquadCards(app, element);
  const open = () => { element.querySelector('[data-group-key="a"] [data-sci-action="rename"]').click(); return element.querySelector(".sci-group-name-edit"); };
  let input = open(); input.value = "Draft squad"; input.setSelectionRange(2, 5);
  renderSquadCards(app, element);
  assert.equal(element.querySelector(".sci-group-name-edit"), input);
  assert.equal(input.value, "Draft squad"); assert.equal(document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 5]);
  const nativeList = document.createElement("ol"); nativeList.className = "combat-tracker";
  nativeList.append(...element.querySelectorAll("[data-combatant-id]"));
  element.querySelector(".combat-tracker").replaceWith(nativeList);
  input.dispatchEvent(new window.Event("blur")); renderSquadCards(app, element);
  assert.equal(element.querySelector(".sci-group-name-edit"), input);
  assert.equal(input.value, "Draft squad"); assert.equal(document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 5]);
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  assert.equal(doc.writes.length, 0);
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  input.dispatchEvent(new window.Event("blur")); await tick();
  assert.equal(doc.writes.length, 0); assert.equal(element.querySelector(".sci-group-name-edit"), null);
  input = open(); input.value = " ";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.ok(input.validationMessage); assert.equal(element.querySelector(".sci-group-name-edit"), input);
  input.value = "x".repeat(201);
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.ok(input.validationMessage); input.blur(); await tick(); assert.equal(doc.writes.length, 0);
  input = open(); input.value = '<b>Brave & Bold</b>'; input.dispatchEvent(new window.Event("input")); input.blur(); await tick();
  assert.equal(doc.getFlag(MID, "groups.a.name"), '<b>Brave & Bold</b>');
  const title = element.querySelector('[data-group-key="a"] .name');
  assert.equal(title.textContent, '<b>Brave & Bold</b>'); assert.equal(title.querySelector("b"), null);
});

function mockImagePicker() {
  const instances = [];
  foundry.applications.apps = { FilePicker: { implementation: class {
    constructor(options) { this.options = options; this.front = 0; instances.push(this); }
    addEventListener(type, callback) { if (type === "close") this.onClose = callback; }
    render(options) { this.renderOptions = options; return Promise.resolve(this); }
    bringToFront() { this.front++; }
    close() { this.onClose?.(); }
  } } };
  return instances;
}

test("clicking the icon reuses the image picker and saves to its captured encounter", async () => {
  const { doc, app, element } = fixture(); const pickers = mockImagePicker();
  doc.getFlag(MID, "groups.a").img = "icons/old.svg";
  renderSquadCards(app, element);
  const icon = element.querySelector('[data-group-key="a"] [data-sci-action="icon"]');
  assert.equal(icon.tagName, "BUTTON"); assert.equal(icon.getAttribute("aria-label"), "SCI.Card.ChangeIcon");
  icon.querySelector("img").click(); icon.click();
  assert.equal(pickers.length, 1); const picker = pickers[0]; assert.equal(picker.front, 1);
  assert.equal(picker.options.type, "image"); assert.equal(picker.options.current, "icons/old.svg");
  assert.deepEqual(picker.renderOptions, { force: true });
  const other = combat(); app.viewed = other; game.combat = other;
  await picker.options.callback("icons/new.webp"); await picker.options.callback("icons/duplicate.webp"); picker.close();
  assert.equal(doc.getFlag(MID, "groups.a.img"), "icons/new.webp");
  assert.equal(other.getFlag(MID, "groups.a.img"), undefined);
  assert.equal(doc.writes.filter(write => `flags.${MID}.groups.a.img` in write.changes).length, 1);
});

test("picker cancellation and deleted squads leave data untouched, and a later picker can open", async () => {
  const { doc, app, element } = fixture(); const pickers = mockImagePicker(), errors = [];
  ui.notifications.error = message => errors.push(message); renderSquadCards(app, element);
  const open = () => element.querySelector('[data-group-key="a"] [data-sci-action="icon"]').click();
  open(); pickers[0].close(); assert.equal(doc.writes.length, 0);
  open(); assert.equal(pickers.length, 2);
  const saved = doc.getFlag(MID, "groups.a"); delete doc.flags[MID].groups.a;
  await pickers[1].options.callback("icons/new.svg"); pickers[1].close();
  assert.deepEqual(errors, ["SCI.Errors.StaleDocument"]); assert.equal(doc.writes.length, 0);
  doc.flags[MID].groups.a = saved; renderSquadCards(app, element); open(); assert.equal(pickers.length, 3);
  pickers[2].close();
});

test("appearance mutation failures clear pending state and allow another edit", async () => {
  const { app, element } = fixture(); const original = GroupManager.editGroup; let reject;
  const errors = []; ui.notifications.error = message => errors.push(message);
  GroupManager.editGroup = () => new Promise((_resolve, fail) => { reject = fail; });
  try {
    renderSquadCards(app, element); element.querySelector('[data-sci-action="rename"]').click();
    const input = element.querySelector(".sci-group-name-edit"); input.value = "Retry squad";
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(element.querySelector('[data-sci-action="icon"]').disabled, true);
    reject(new Error("fixture edit failure")); await tick();
    assert.deepEqual(errors, ["fixture edit failure"]);
    assert.equal(element.querySelector('[data-sci-action="icon"]').disabled, false);
    element.querySelector('[data-sci-action="rename"]').click();
    assert.equal(element.querySelector(".sci-group-name-edit").value, "A");
  } finally { GroupManager.editGroup = original; }
});

test("three-dot menus dismiss outside the menu and coordinate across tracker roots", () => {
  const { doc, app, element } = fixture(); renderSquadCards(app, element);
  const outside = document.createElement("button"); document.body.append(outside);
  outside.addEventListener("click", event => event.stopPropagation());
  const menu = element.querySelector(".sci-more"), trigger = menu.querySelector("summary");
  assert.equal(trigger.textContent, ""); assert.equal(trigger.getAttribute("aria-label"), "SCI.Card.More");
  assert.ok(trigger.querySelector(".fa-ellipsis"));
  trigger.click(); assert.equal(menu.open, true);
  menu.querySelector("div").click(); assert.equal(menu.open, true);
  outside.click(); assert.equal(menu.open, false);
  trigger.click(); outside.focus(); assert.equal(menu.open, false);

  const otherRoot = element.cloneNode(true); document.body.append(otherRoot);
  const popout = { ...app, element: otherRoot }; renderSquadCards(popout, otherRoot);
  const other = otherRoot.querySelector(".sci-more");
  trigger.click(); other.querySelector("summary").click();
  assert.equal(menu.open, false); assert.equal(other.open, true);
  other.querySelector("summary").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(other.open, false); assert.equal(document.activeElement, other.querySelector("summary"));

  doc.getFlag(MID, "groups.a").pinned = true; renderSquadCards(app, element);
  const next = element.querySelector(".sci-more"); next.querySelector("summary").click(); outside.click();
  assert.equal(next.open, false);
  assert.equal(element.querySelector('[data-sci-action="pin"]').textContent, "SCI.Card.Unpin");
});

test("choosing a menu command closes the dropdown before the action finishes", async () => {
  const { app, element } = fixture(); const original = GroupManager.deleteGroup;
  let finish, calls = 0;
  GroupManager.deleteGroup = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  try {
    renderSquadCards(app, element); const menu = element.querySelector(".sci-more");
    menu.querySelector("summary").click(); menu.querySelector('[data-sci-action="delete"]').click();
    assert.equal(calls, 1); assert.equal(menu.open, false);
    assert.equal(document.activeElement, menu.querySelector("summary"));
    finish(false); await tick();
  } finally { GroupManager.deleteGroup = original; }
});

test("stale native headers are removed while original member rows join SCI cards", () => {
  const { doc, app, element } = fixture(); doc.combatants[0]._source = { group: "saved-native" };
  const native = document.createElement("li"); native.className = "combatant-group"; native.innerHTML = '<ol class="native-children"></ol>';
  element.querySelector("ol").prepend(native); native.firstChild.append(element.querySelector('[data-combatant-id="a1"]'));
  renderSquadCards(app, element); renderSquadCards(app, element);
  assert.equal(element.querySelectorAll(".combatant-group").length, 0);
  assert.ok(element.querySelector('[data-group-key="a"] [data-combatant-id="a1"]'));
  assert.equal(doc.combatants[0]._source.group, "saved-native");
});

test("rendered names and images cannot inject markup", () => {
  const { doc, app, element } = fixture(); Object.assign(doc.getFlag(MID, "groups.a"), { name: '<img src=x onerror="bad()">', img: 'javascript:alert(1)', color: 'red;display:none' });
  renderSquadCards(app, element); const card = element.querySelector('[data-group-key="a"]');
  assert.equal(card.querySelector("[onerror]"), null); assert.ok(card.querySelector(".name").textContent.startsWith("<img"));
  assert.equal(card.querySelector(".token-image").getAttribute("src"), "icons/svg/combat.svg");
});

test("pending actions reject duplicate clicks and recover after a failed mutation", async () => {
  const { app, element } = fixture(); let reject; let calls = 0; const original = GroupManager.editGroup;
  GroupManager.editGroup = () => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); };
  try {
    renderSquadCards(app, element); const pin = element.querySelector('[data-sci-action="pin"]'); pin.click(); pin.click();
    assert.equal(calls, 1); assert.ok(pin.disabled); assert.equal(pin.closest(".sci-combatant-group").getAttribute("aria-busy"), "true");
    assert.equal(pin.title, "SCI.Card.Unavailable.Pending");
    assert.equal(pin.getAttribute("aria-description"), pin.title);
    reject(new Error("fixture failure")); await tick();
    assert.equal(element.querySelector('[data-sci-action="pin"]').disabled, false);
    assert.equal(element.querySelector('[data-sci-action="pin"]').getAttribute("aria-disabled"), null);
  } finally { GroupManager.editGroup = original; }
});

test("sidebar and popout scheduling both render rather than cancelling one another", async () => {
  const { element } = fixture(); const calls = [];
  const first = { renderGroups: () => calls.push("sidebar") }, second = { renderGroups: () => calls.push("popout") };
  renderBatcher.schedule(first, element); renderBatcher.schedule(second, element);
  await new Promise(resolve => setTimeout(resolve, 120)); assert.deepEqual(calls.sort(), ["popout", "sidebar"]);
});

test("scheduled rendering discards detached HTML, changed encounters and cancelled trackers", async () => {
  const { element } = fixture(); let calls = 0;
  const app = { viewed: { id: "first" }, renderGroups() { calls++; } };
  renderBatcher.schedule(app, element); app.viewed = { id: "second" };
  const detached = element.cloneNode(true); renderBatcher.schedule({ renderGroups() { calls++; } }, detached);
  const cancelled = { renderGroups() { calls++; } }; renderBatcher.schedule(cancelled, element); renderBatcher.cancel(cancelled);
  await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(calls, 0); assert.equal(renderBatcher._pending.size, 0);
});

test("expansion state is namespaced by world, user and combat and merges successive toggles", () => {
  const { doc } = fixture(); expandStore.setExpanded(doc.id, "a", true); expandStore.setExpanded(doc.id, "b", true);
  assert.deepEqual([...expandStore.load(doc.id)].sort(), ["a", "b"]);
  game.user.id = "different"; assert.equal(expandStore.load(doc.id).size, 0);
  game.user.id = "gm"; game.world.id = "different"; assert.equal(expandStore.load(doc.id).size, 0);
});

test("keyboard assignment uses the captured combat; cross-combat and stale drops are rejected", async () => {
  const { doc } = fixture(); foundry.applications.api.DialogV2.wait = async () => "b";
  game.combat = combat(); await promptAssignment(doc, ["a1"]); assert.equal(doc.combatants[0].getFlag(MID, "groupId"), "b");
  const payload = { type: "SCI.Combatant", combatId: doc.id, combatantId: "a1" };
  assert.equal(parseCombatantDrop(JSON.stringify(payload), doc), "a1");
  assert.throws(() => parseCombatantDrop(JSON.stringify({ ...payload, combatId: "other" }), doc));
  assert.throws(() => parseCombatantDrop(JSON.stringify({ ...payload, combatantId: "gone" }), doc));
  foundry.applications.api.DialogV2.wait = async () => ""; await promptAssignment(doc, ["a1"]);
  assert.equal(doc.combatants[0].getFlag(MID, "groupId"), undefined);
});

test("preset CRUD retains its ID on rename and excludes combat-specific fields", async () => {
  fixture(); const id = await GroupManager.savePreset("Original", { initiativeMode: "highest", discipline: "elite", captainId: "a1", initiative: 20 });
  await GroupManager.updatePreset(id, { name: "Renamed", moraleTrigger: "manual", startingSize: 10 });
  const presets = GroupManager.getPresets(); assert.equal(presets[id].name, "Renamed"); assert.equal(presets[id].initiativeMode, "highest");
  for (const field of ["captainId", "initiative", "startingSize"]) assert.equal(presets[id][field], undefined);
  await assert.rejects(GroupManager.savePreset("bad", { initiativeMode: "invented" }), /InvalidGroupField/);
  assert.equal(await GroupManager.deletePreset(id), true); assert.deepEqual(settings.get("groupPresets"), {});
});
