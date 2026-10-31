import test from "node:test";
import assert from "node:assert/strict";
import { environment, combat, MID } from "./fixtures.js";
environment();
const { GroupManager } = await import("../scripts/group-manager.js");

test("auto-grouping by actor through the facade creates squads, assigns members and reconciles initiative", async () => {
  environment(); const doc = combat();
  for (const member of doc.combatants) delete member.flags[MID].groupId;
  const result = await GroupManager.autoGroupCombatants(doc, { groupBy: "actor", includeSingletons: true });
  assert.deepEqual([result.groupsCreated, result.groupsDeleted, result.combatantsAssigned, result.skipped], [3, 0, 3, 0]);
  assert.equal(result.groupIds.length, 3);
  for (const member of doc.combatants) {
    const groupId = member.getFlag(MID, "groupId");
    assert.ok(result.groupIds.includes(groupId), member.id);
    const group = doc.getFlag(MID, `groups.${groupId}`);
    assert.equal(group.initiativeMode, "average"); assert.equal(group.pinned, false);
    assert.equal(group.initiative, member.initiative);
  }
  assert.equal(new Set(result.groupIds.map(id => doc.getFlag(MID, `groups.${id}.name`))).size, 3);
});

test("auto-grouping skips already grouped combatants unless regrouping is requested and honors the singleton filter", async () => {
  environment(); const doc = combat();
  const untouched = await GroupManager.autoGroupCombatants(doc, { groupBy: "disposition" });
  assert.deepEqual([untouched.groupsCreated, untouched.combatantsAssigned, untouched.skipped], [0, 0, 3]);
  assert.deepEqual(doc.combatants.map(c => c.getFlag(MID, "groupId")), ["a", "a", "b"]);
  const regrouped = await GroupManager.autoGroupCombatants(doc, { groupBy: "disposition", includeGrouped: true });
  assert.equal(regrouped.groupsCreated, 1); assert.equal(regrouped.combatantsAssigned, 3); assert.equal(regrouped.groupsDeleted, 2);
  assert.equal(new Set(doc.combatants.map(c => c.getFlag(MID, "groupId"))).size, 1);
  assert.equal(doc.getFlag(MID, "groups.a"), undefined); assert.equal(doc.getFlag(MID, "groups.b"), undefined);
});
