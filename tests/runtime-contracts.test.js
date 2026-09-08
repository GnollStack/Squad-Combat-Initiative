import assert from "node:assert/strict";
import test from "node:test";

const moduleId = "squad-combat-initiative";
const hooks = new Map();
const wrappers = new Map();
const moduleRecord = {};
globalThis.CONST = { TOKEN_DISPOSITIONS: { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 } };
globalThis.Hooks = {
  once() {},
  on(name, callback) {
    const callbacks = hooks.get(name) ?? [];
    callbacks.push(callback);
    hooks.set(name, callbacks);
  },
};
globalThis.game = {
  user: { id: "gm", isGM: true, isActiveGM: true },
  system: { id: "dnd5e" },
  settings: { get: (_module, key) => key === "moraleEnabled" ? true : "off" },
  modules: { get: (id) => id === "lib-wrapper" ? { active: true } : moduleRecord },
};
globalThis.Combat = class { rollAll() {} };
globalThis.dnd5e = { documents: { Combat5e: class {} } };
globalThis.libWrapper = { register: (_id, target, callback, mode) => {
  assert.equal(mode, "WRAPPER");
  wrappers.set(target, callback);
} };

const { overrideRollMethods } = await import("../scripts/rolling-overrides.js");
const { MoraleManager } = await import("../scripts/morale.js");
await import("../scripts/main.js");

test("sort WRAPPER always calls the native comparator exactly once", () => {
  overrideRollMethods();
  const sort = wrappers.get("dnd5e.documents.Combat5e.prototype._sortCombatants");
  const combat = { getFlag: (_module, key) => ({ initiative: key.endsWith("a") ? 10 : 5 }) };
  const member = (id, group) => ({ id, parent: combat, getFlag: () => group });
  for (const [a, b, expected] of [
    [member("1", "a"), member("2", "b"), -5],
    [member("1", "a"), member("2", "a"), 7],
    [member("1", "ungrouped"), member("2", "ungrouped"), 7],
  ]) {
    let calls = 0;
    const result = sort.call(combat, (left, right) => {
      calls += 1;
      assert.equal(left, a);
      assert.equal(right, b);
      return 7;
    }, a, b);
    assert.equal(calls, 1);
    assert.equal(result, expected);
  }
});

test("an unlinked casualty does not trigger captain death for another token of the same base actor", async () => {
  const captain = { id: "captain", actorId: "shared-actor", actor: { uuid: "Scene.test.Token.captain.Actor.shared-actor" }, getFlag: () => "squad" };
  const casualty = { id: "casualty", actorId: "shared-actor", actor: { uuid: "Scene.test.Token.casualty.Actor.shared-actor" }, getFlag: () => "squad" };
  captain.actor.system = { attributes: { hp: { value: 10 } } };
  const combat = {
    id: "test", uuid: "Combat.test",
    combatants: Object.assign([captain, casualty], { get: id => [captain, casualty].find(c => c.id === id) }),
    getFlag: () => ({ captainId: captain.id, moraleTrigger: "captainDeath" }),
  };
  game.combats = Object.assign([combat], { get: id => id === combat.id ? combat : null });
  const original = MoraleManager._local.handleCaptainDeath;
  let deaths = 0;
  MoraleManager._local.handleCaptainDeath = async () => { deaths += 1; };
  try {
    for (const callback of hooks.get("updateActor")) {
      await callback({ id: "shared-actor", uuid: casualty.actor.uuid }, { system: { attributes: { hp: { value: 0 } } } });
    }
    assert.equal(deaths, 0);
    captain.actor.system.attributes.hp.value = 0;
    for (const callback of hooks.get("updateActor")) {
      await callback({ id: "shared-actor", uuid: captain.actor.uuid }, { system: { attributes: { hp: { value: 0 } } } });
    }
    assert.equal(deaths, 1);
  } finally {
    MoraleManager._local.handleCaptainDeath = original;
  }
});

test("bulk WRAPPER preserves native filtering, return values and errors with exactly one call", async () => {
  const { GroupManager } = await import("../scripts/group-manager.js");
  const wrapper = wrappers.get("dnd5e.documents.Combat5e.prototype.rollNPC");
  const members = [{ id: "pc", initiative: null, player: true }, { id: "npc", initiative: null, player: false }];
  members.forEach(c => { c.getFlag = () => "squad"; });
  const doc = { id: "native", combatants: members };
  const original = GroupManager.finalizeGroupInitiative; let finalized = 0; let calls = 0;
  GroupManager.finalizeGroupInitiative = async () => { finalized++; };
  try {
    const expected = {};
    assert.equal(await wrapper.call(doc, async options => {
      calls++; assert.equal(options.messageMode, "gm");
      members.filter(c => !c.player).forEach(c => { c.initiative = 14; }); return expected;
    }, { messageMode: "gm" }), expected);
    assert.equal(calls, 1); assert.equal(finalized, 1); assert.equal(members[0].initiative, null);
    const failure = new Error("native recovery failed");
    await assert.rejects(wrapper.call(doc, async () => { calls++; throw failure; }), error => error === failure);
    assert.equal(calls, 2); assert.equal(GroupManager.isBulkRollInProgress(doc), false);
  } finally { GroupManager.finalizeGroupInitiative = original; }
});

test("dnd5e grouping WRAPPER delegates once and suppresses all native group headers", () => {
  const wrapper = wrappers.get("dnd5e.documents.Combat5e.prototype.createGroups"); let calls = 0;
  const members = [{ getFlag: () => "sci" }, { group: { id: "native" }, getFlag: () => "sci" }, { getFlag: () => "ungrouped" }];
  const result = wrapper(() => { calls++; return new Map([["native", { combatants: members, expanded: true }]]); });
  assert.equal(calls, 1); assert.equal(result.size, 0); assert.equal(members.length, 3);
});

test("each client's descendant lifecycle preserves the active ID before native turn bookkeeping", () => {
  const memberA = { id: "a" }, memberB = { id: "b" };
  const setup = wrappers.get("dnd5e.documents.Combat5e.prototype.setupTurns");
  const descendant = wrappers.get("dnd5e.documents.Combat5e.prototype._onUpdateDescendantDocuments");
  const doc = { getFlag: () => ({}), turns: [memberA, memberB], round: 3, turn: 0, current: { combatantId: "a" }, get combatant() { return this.turns[this.turn]; } };
  let nativeCalls = 0;
  const result = descendant.call(doc, () => {
    nativeCalls++;
    setup.call(doc, () => { doc.turns = [memberB, memberA]; doc.current = { combatantId: "b" }; return doc.turns; });
    assert.equal(doc.combatant.id, "a"); assert.equal(doc.current.combatantId, "a"); return "native-result";
  }, doc, "combatants", [], [], { sciGroupInitiative: true, sciActiveCombatantId: "a", turnEvents: false }, "gm");
  assert.equal(nativeCalls, 1); assert.equal(result, "native-result"); assert.equal(doc.turn, 1); assert.equal(doc.round, 3);
});

test("native group updates rebuild mixed squad order on receiving clients", () => {
  const descendant = wrappers.get("dnd5e.documents.Combat5e.prototype._onUpdateDescendantDocuments");
  const first = { id: "squad" }, second = { id: "native" }; let calls = 0;
  const doc = {
    getFlag: () => ({ squad: {} }), round: 2, turn: 0, turns: [first, second], current: { combatantId: first.id },
    get combatant() { return this.turns[this.turn]; },
    setupTurns() { this.turns = [second, first]; this.current = { combatantId: second.id }; return this.turns; },
  };
  descendant.call(doc, () => { calls++; }, doc, "groups", [], [], {}, "other-gm");
  assert.equal(calls, 1); assert.deepEqual(doc.turns.map(c => c.id), ["native", "squad"]);
  assert.equal(doc.combatant.id, "squad"); assert.equal(doc.round, 2);
});
