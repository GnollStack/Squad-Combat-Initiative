import test from "node:test";
import assert from "node:assert/strict";
import { environment, combat, MID } from "./fixtures.js";
import { suppressNativeMembership, disableNativeGrouping } from "../scripts/native-group-policy.js";
environment();
const { GroupManager } = await import("../scripts/group-manager.js");

test("native preparation suppression preserves serialized groups and restores individual rolls", () => {
  for (const initiative of [17, 0, null]) {
    const native = { id: "native", initiative: 99, members: new Set() };
    const member = { _source: { group: native.id, initiative }, group: native, initiative: 99 };
    native.members.add(member);
    const saved = JSON.stringify(member._source);
    suppressNativeMembership(member); suppressNativeMembership(member);
    assert.equal(member.group, null); assert.equal(member.initiative, initiative);
    assert.equal(native.members.size, 0); assert.equal(native.initiative, 99);
    assert.equal(JSON.stringify(member._source), saved);
    // Removing SCI and running normal preparation can restore the saved group.
    member.group = native; member.initiative = native.initiative;
    assert.equal(member._source.group, member.group.id);
  }
});

test("native preparation WRAPPER delegates exactly once and preserves results and errors", () => {
  let wrapper;
  globalThis.libWrapper = { register: (_id, path, fn, mode) => {
    assert.ok(path.endsWith("._prepareGroup")); assert.equal(mode, "WRAPPER"); wrapper = fn;
  } };
  disableNativeGrouping();
  const member = { _source: { initiative: 12, group: "native" } }; let calls = 0;
  assert.equal(wrapper.call(member, arg => { calls++; assert.equal(arg, "input"); member.initiative = 99; return "result"; }, "input"), "result");
  assert.equal(calls, 1); assert.equal(member.initiative, 12);
  const failure = new Error("native preparation error");
  assert.throws(() => wrapper.call(member, () => { calls++; throw failure; }), error => error === failure);
  assert.equal(calls, 2);
});

test("dormant saved native membership permits explicit SCI assignment without importing or deleting it", async () => {
  environment(); const doc = combat(); const member = doc.combatants[0];
  member._source = { initiative: member.initiative, group: "saved-native" }; member.group = { id: "saved-native", members: new Set([member]) };
  suppressNativeMembership(member);
  await GroupManager.removeCombatantFromGroup(doc, member.id);
  assert.equal(member.getFlag(MID, "groupId"), undefined);
  await GroupManager.addCombatantsToGroup(doc, "b", [member.id]);
  assert.equal(member.getFlag(MID, "groupId"), "b"); assert.equal(member._source.group, "saved-native");
});
