import test from "node:test";
import assert from "node:assert/strict";
import { environment, combat, settings, MID } from "./fixtures.js";
environment();
const { GroupManager } = await import("../scripts/group-manager.js");
const { CombatEvents } = await import("../scripts/combat-events.js");
const { calculateGroupInitiative, INITIATIVE_MODE } = await import("../scripts/shared.js");
const { pickSharedInitiative, sharedRepresentative } = await import("../scripts/initiative-ordering.js");
const { onEncounterPlaced } = await import("../scripts/encounter-squads.js");

function sharedSquad({ a1 = 20, a2 = 10, captainId = null, value = null } = {}) {
  environment();
  const doc = combat();
  Object.assign(doc.flags[MID].groups.a, { initiativeMode: INITIATIVE_MODE.SHARED, captainId, initiative: value });
  doc.combatants.get("a1").initiative = a1;
  doc.combatants.get("a2").initiative = a2;
  return { doc, a1: doc.combatants.get("a1"), a2: doc.combatants.get("a2"), b1: doc.combatants.get("b1") };
}
const native = member => member.getFlag(MID, "nativeInitiative");

test("the shared aggregate is the most common value, ties to the highest", () => {
  assert.equal(calculateGroupInitiative([12, 12, 12], INITIATIVE_MODE.SHARED), 12);
  assert.equal(calculateGroupInitiative([12, 12, 18], INITIATIVE_MODE.SHARED), 12);
  assert.equal(calculateGroupInitiative([12, 18], INITIATIVE_MODE.SHARED), 18);
});

test("the representative is a living captain, otherwise the first living member", () => {
  const member = (id, hp = 10, defeated = false) => ({ id, isDefeated: defeated, actor: { system: { attributes: { hp: { value: hp } } } } });
  const members = [member("first", 0), member("second"), member("captain")];
  assert.equal(sharedRepresentative(members, "captain").id, "captain");
  assert.equal(sharedRepresentative(members, null).id, "second");
  assert.equal(sharedRepresentative([member("down", 0), member("gone", 10, true)], "gone").id, "down");
  assert.equal(sharedRepresentative([], null), null);
});

test("the shared value prefers an edit, then a settled value, then the representative", () => {
  const member = (id, initiative) => ({ id, initiative, actor: { system: { attributes: { hp: { value: 10 } } } } });
  assert.equal(pickSharedInitiative([member("a", null), member("b", null)], {}), null);
  assert.equal(pickSharedInitiative([member("a", null), member("b", 9)], {}), 9);
  assert.equal(pickSharedInitiative([member("a", 15), member("b", 18)], { initiative: 15 }, "b"), 18);
  assert.equal(pickSharedInitiative([member("a", 15), member("b", 15), member("c", 3)], { initiative: 15 }), 15);
  assert.equal(pickSharedInitiative([member("a", 20), member("b", 10)], { initiative: null, captainId: "b" }), 10);
  assert.equal(pickSharedInitiative([member("a", 20), member("b", 10), member("c", null)], { captainId: "c" }), 20);
});

test("a shared squad roll rolls once for the representative and fills every member", async () => {
  const { doc, a1, a2 } = sharedSquad({ a1: null, a2: null, captainId: "a2" });
  let rolls = 0, messages = 0;
  const roll = { evaluate: async () => {}, total: 14, toMessage: async () => { messages += 1; } };
  a1.actor.getInitiativeRoll = () => { throw new Error("only the representative rolls"); };
  a2.actor.getInitiativeRoll = () => { rolls += 1; return roll; };
  await GroupManager.rollGroupAndApplyInitiative(doc, "a");
  assert.deepEqual([rolls, messages], [1, 1]);
  assert.deepEqual([a1.initiative, a2.initiative], [14, 14]);
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), 14);
  assert.equal(a1.getFlag(MID, "rawInitiative"), 14);
  assert.equal(native(a1), undefined);
});

test("a shared squad roll inherits instead of rolling when a member already rolled", async () => {
  const { doc, a1, a2 } = sharedSquad({ a1: null, a2: 9 });
  a1.actor.getInitiativeRoll = () => { throw new Error("no new roll"); };
  a2.actor.getInitiativeRoll = () => { throw new Error("no new roll"); };
  await GroupManager.rollGroupAndApplyInitiative(doc, "a");
  assert.deepEqual([a1.initiative, a2.initiative], [9, 9]);
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), 9);
});

test("native rolls normalize to the representative and save the overwritten roll", async () => {
  const { doc, a1, a2 } = sharedSquad({ captainId: "a2" });
  await GroupManager.finalizeGroupInitiative(doc, "a");
  assert.deepEqual([a1.initiative, a2.initiative], [10, 10]);
  assert.equal(native(a1), 20);
  assert.equal(native(a2), undefined);
  assert.equal(a1.getFlag(MID, "rawInitiative"), 10);
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), 10);
});

test("a lone roll becomes the squad value and an unrolled member inherits it", async () => {
  const { doc, a1, a2 } = sharedSquad({ a1: null, a2: 7 });
  await GroupManager.finalizeGroupInitiative(doc, "a", { editedCombatantId: "a2" });
  assert.deepEqual([a1.initiative, a2.initiative], [7, 7]);
  assert.equal(native(a1), undefined);
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), 7);
});

test("an edit to one member moves the squad and keeps saved native rolls", async () => {
  const { doc, a1, a2 } = sharedSquad({ a1: 15, a2: 18, value: 15 });
  a1.flags[MID].nativeInitiative = 4;
  await GroupManager.finalizeGroupInitiative(doc, "a", { editedCombatantId: "a2" });
  assert.deepEqual([a1.initiative, a2.initiative], [18, 18]);
  assert.equal(native(a1), 4);
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), 18);
});

test("a member moved into a shared squad inherits, and restores its roll when it leaves", async () => {
  const { doc, a1, a2, b1 } = sharedSquad({ a1: 15, a2: 15, value: 15 });
  await GroupManager.moveCombatants(doc, "a", ["b1"]);
  await CombatEvents.membershipChanged(doc, b1, "b");
  assert.deepEqual([a1.initiative, a2.initiative, b1.initiative], [15, 15, 15]);
  assert.equal(native(b1), 12);

  await GroupManager.moveCombatants(doc, "b", ["b1"]);
  await CombatEvents.membershipChanged(doc, b1, "a");
  assert.equal(b1.initiative, 12);
  assert.equal(native(b1), undefined);
  assert.deepEqual([a1.initiative, a2.initiative], [15, 15]);
});

test("leaving shared mode restores saved rolls and returning uses the representative", async () => {
  const { doc, a1, a2 } = sharedSquad({ captainId: "a2" });
  await GroupManager.finalizeGroupInitiative(doc, "a");
  await GroupManager.editGroup(doc, "a", { initiativeMode: INITIATIVE_MODE.HIGHEST });
  assert.deepEqual([a1.initiative, a2.initiative], [20, 10]);
  assert.equal(native(a1), undefined);
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), 20);

  await GroupManager.editGroup(doc, "a", { initiativeMode: INITIATIVE_MODE.SHARED });
  assert.deepEqual([a1.initiative, a2.initiative], [10, 10]);
  assert.equal(native(a1), 20);
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), 10);
});

test("reset and clearing every member drop saved rolls, and a squad score moves every member", async () => {
  const { doc, a1, a2 } = sharedSquad({ captainId: "a2" });
  await GroupManager.finalizeGroupInitiative(doc, "a");
  await GroupManager.setGroupInitiative(doc, "a", 17);
  assert.deepEqual([a1.initiative, a2.initiative], [17, 17]);
  assert.equal(doc.getFlag(MID, "groups.a.initiativeSource"), "manual");

  await GroupManager.resetGroupInitiative(doc, "a");
  assert.equal(native(a1), undefined);
  assert.deepEqual([a1.initiative, a2.initiative], [null, null]);

  a1.flags[MID].nativeInitiative = 5;
  await GroupManager.finalizeGroupInitiative(doc, "a");
  assert.equal(native(a1), undefined);
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), null);
});

test("other modes are unaffected by the shared path", async () => {
  environment();
  const doc = combat();
  await GroupManager.finalizeGroupInitiative(doc, "a", { editedCombatantId: "a1" });
  assert.deepEqual([doc.combatants.get("a1").initiative, doc.combatants.get("a2").initiative], [20, 10]);
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), 15);
});

test("a placed encounter becomes one squad with its Important member as captain", async (t) => {
  environment();
  settings.set("encounterSquads", true);
  const doc = combat();
  game.combats.viewed = doc;
  doc.combatants.forEach((member, index) => { member.tokenId = `t${index}`; });
  doc.combatants.get("a2").actor.system.traits = { important: true };
  const created = t.mock.method(GroupManager, "createGroup", async () => "encounter");
  const captain = t.mock.method(GroupManager, "setCaptain", async () => {});

  const id = await onEncounterPlaced({ name: "Ambush", img: "ambush.webp" }, [{ id: "t1" }, { id: "t0" }], { combatBehavior: "createCombatants" });
  assert.equal(id, "encounter");
  const [target, data, tokens] = created.mock.calls[0].arguments;
  assert.equal(target, doc);
  assert.deepEqual([data.name, data.img, data.initiativeMode], ["Ambush", "ambush.webp", "average"]);
  assert.deepEqual(tokens, [{ id: "t0" }, { id: "t1" }]);
  assert.deepEqual(captain.mock.calls[0].arguments, [doc, "encounter", "a2"]);
});

test("an encounter with no linked scene accepts tokens from any scene, and a linked one still refuses", async () => {
  environment();
  const doc = combat();
  doc.combatants.forEach((member, index) => { member.tokenId = `t${index}`; });
  const token = { id: "t2", parent: { id: "elsewhere" } };

  const groupId = await GroupManager.createGroup(doc, { name: "Unlinked" }, [token]);
  assert.ok(groupId);
  assert.equal(doc.combatants.get("b1").getFlag(MID, "groupId"), groupId);

  doc.scene = { id: "linked", tokens: new Map() };
  await assert.rejects(GroupManager.createGroup(doc, { name: "Linked" }, [token]), /CrossCombatDrop/);
});

test("hiding a squad updates its tokens through each token's own scene", async () => {
  environment();
  settings.set("visibilitySyncMode", "bidirectional");
  const doc = combat();
  const writes = [];
  const scene = name => ({ updateEmbeddedDocuments: async (_type, updates) => { writes.push([name, updates]); } });
  const first = scene("first"), second = scene("second");
  doc.combatants.get("a1").token = { id: "t1", parent: first };
  doc.combatants.get("a2").token = { id: "t2", parent: second };

  await GroupManager.toggleGroupVisibility(doc, "a");
  assert.deepEqual(writes, [["first", [{ _id: "t1", hidden: true }]], ["second", [{ _id: "t2", hidden: true }]]]);
});

test("encounter placement creates no squad when off, empty, or outside combat", async (t) => {
  environment();
  const doc = combat();
  game.combats.viewed = doc;
  doc.combatants.forEach((member, index) => { member.tokenId = `t${index}`; });
  const created = t.mock.method(GroupManager, "createGroup", async () => "encounter");
  const encounter = { name: "Ambush" }, tokens = [{ id: "t0" }];

  settings.set("encounterSquads", false);
  assert.equal(await onEncounterPlaced(encounter, tokens, { combatBehavior: "createCombatants" }), null);
  settings.set("encounterSquads", true);
  assert.equal(await onEncounterPlaced(encounter, tokens, { combatBehavior: "none" }), null);
  assert.equal(await onEncounterPlaced(encounter, [], { combatBehavior: "createCombatants" }), null);
  assert.equal(await onEncounterPlaced(encounter, [{ id: "elsewhere" }], { combatBehavior: "createCombatants" }), null);
  assert.equal(created.mock.callCount(), 0);
});
