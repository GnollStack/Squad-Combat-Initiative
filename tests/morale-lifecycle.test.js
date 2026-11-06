import test from "node:test";
import assert from "node:assert/strict";
import { environment, combat, settings, MID } from "./fixtures.js";
environment();
const { GroupManager } = await import("../scripts/group-manager.js");
const { MoraleManager } = await import("../scripts/morale.js");
const { CombatEvents, cleanupDeletedCombat, handleActorCasualties } = await import("../scripts/combat-events.js");
const { migrateWorldData } = await import("../scripts/migrations.js");

async function fail(member) {
  await member.setFlag(MID, "moraleStatus", "failed");
  await MoraleManager.applyMoraleEffect(member);
}

test("linked actors retain other encounter origins and unrelated conditions when one source clears", async () => {
  environment(); const first = combat(), second = combat();
  const a = first.combatants[0], b = second.combatants[0]; b.actor = a.actor;
  await a.actor.createEmbeddedDocuments("ActiveEffect", [{ name: "unrelated", statuses: ["fleeing"] }]);
  await fail(a); await fail(b); await MoraleManager.applyMoraleEffect(a);
  assert.equal(a.actor.effects.length, 3);
  await MoraleManager.clearMorale(first, "a", a.id);
  assert.equal(a.actor.effects.length, 2); assert.equal(a.getFlag(MID, "moraleStatus"), undefined);
  assert.equal(a.actor.effects[1].getFlag(MID, "moraleCombatUuid"), second.uuid);
  await cleanupDeletedCombat(second); assert.equal(a.actor.effects.length, 1);
});

test("timed morale effects store value and units on the registered and custom paths", async () => {
  for (const registered of [true, false]) {
    environment(); settings.set("moraleEffectDuration", 2);
    if (registered) {
      CONFIG.statusEffects = { fleeing: { id: "fleeing" } };
      globalThis.getDocumentClass = () => ({ fromStatusEffect: async id => ({ toObject: () => ({ _id: "static", name: "Fleeing", statuses: [id], duration: { value: null, units: "seconds", expiry: null } }) }) });
    }
    const member = combat().combatants[0];
    await fail(member);
    assert.deepEqual(member.actor.effects[0].duration, { value: 2, units: "rounds" });
    // The system's fixed condition id is kept, so dnd5e adds no second copy of the condition.
    assert.equal(member.actor.effects[0]._id, registered ? "static" : undefined);
    delete globalThis.getDocumentClass;
  }
});

test("clearing morale tolerates effects that vanished while the delete was in flight", async () => {
  environment();
  const member = combat().combatants[0];
  await fail(member);
  assert.equal(member.actor.effects.length, 1);
  member.actor.deleteEmbeddedDocuments = async function () {
    this.effects = [];
    throw new Error("undefined id [x] does not exist in the EmbeddedCollection collection.");
  };
  await MoraleManager.clearMoraleEffect(member);
  assert.equal(member.actor.effects.length, 0);
  member.actor.deleteEmbeddedDocuments = async function () { throw new Error("still there"); };
  await fail(member);
  await assert.rejects(() => MoraleManager.clearMoraleEffect(member), /still there/);
});

test("a morale effect takes its own id when the condition effect appears between the check and the write", async () => {
  environment(); settings.set("moraleEffectDuration", 2);
  CONFIG.statusEffects = { fleeing: { id: "fleeing" } };
  globalThis.getDocumentClass = () => ({ fromStatusEffect: async id => ({ toObject: () => ({ _id: "static", name: "Fleeing", statuses: [id], duration: { value: null, units: "seconds", expiry: null } }) }) });
  try {
    const member = combat().combatants[0];
    const create = member.actor.createEmbeddedDocuments.bind(member.actor);
    let attempts = 0;
    member.actor.createEmbeddedDocuments = async function (type, data, options) {
      attempts += 1;
      if (data[0]._id === "static") throw new Error("The _id [static] already exists within the parent collection: ActorDelta [x] effects");
      return create(type, data, options);
    };
    await fail(member);
    assert.equal(attempts, 2);
    assert.equal(member.actor.effects.length, 1);
    assert.equal(member.actor.effects[0]._id, undefined);
    assert.equal(member.actor.effects[0].getFlag(MID, "moraleEffect"), true);
  } finally { delete globalThis.getDocumentClass; }
});

test("an unrelated effect carrying the status makes the morale effect take its own id", async () => {
  environment(); settings.set("moraleEffectDuration", 2);
  CONFIG.statusEffects = { fleeing: { id: "fleeing" } };
  globalThis.getDocumentClass = () => ({ fromStatusEffect: async id => ({ toObject: () => ({ _id: "static", name: "Fleeing", statuses: [id], duration: { value: null, units: "seconds", expiry: null } }) }) });
  try {
    const member = combat().combatants[0];
    await member.actor.createEmbeddedDocuments("ActiveEffect", [{ name: "Unrelated", statuses: ["fleeing"] }]);
    await fail(member);
    assert.equal(member.actor.effects.length, 2);
    assert.equal(member.actor.effects[1]._id, undefined);
    assert.equal(member.actor.effects[1].getFlag(MID, "moraleEffect"), true);
  } finally { delete globalThis.getDocumentClass; }
});

test("a squad mate sharing the actor gets its own effect id once the condition effect exists", async () => {
  environment(); settings.set("moraleEffectDuration", 2);
  CONFIG.statusEffects = { fleeing: { id: "fleeing" } };
  globalThis.getDocumentClass = () => ({ fromStatusEffect: async id => ({ toObject: () => ({ _id: "static", name: "Fleeing", statuses: [id], duration: { value: null, units: "seconds", expiry: null } }) }) });
  try {
    const [first, second] = combat().combatants;
    second.actor = first.actor;
    await fail(first); await fail(second);
    assert.equal(first.actor.effects.length, 2);
    assert.equal(first.actor.effects[0]._id, "static");
    assert.equal(first.actor.effects[1]._id, undefined);
  } finally { delete globalThis.getDocumentClass; }
});

test("a repeat failure restarts a timed or expired effect and leaves a permanent one alone", async () => {
  environment(); settings.set("moraleEffectDuration", 2);
  const member = combat().combatants[0];
  await fail(member); const timed = member.actor.effects[0];
  await fail(member);
  assert.equal(member.actor.effects.length, 1); assert.notEqual(member.actor.effects[0].id, timed.id);

  settings.set("moraleEffectDuration", 0);
  await fail(member); const standing = member.actor.effects[0];
  assert.equal(standing.id, member.actor.effects[0].id);
  await fail(member); assert.equal(member.actor.effects[0].id, standing.id);

  standing.duration = { expired: true };
  await fail(member);
  assert.equal(member.actor.effects.length, 1); assert.notEqual(member.actor.effects[0].id, standing.id);
});

for (const boundary of ["reassign", "ungroup", "memberDelete", "groupDelete", "combatDelete"]) {
  test(`${boundary} removes only the departing morale source`, async () => {
    environment(); const doc = combat(), member = doc.combatants[0];
    await fail(member);
    if (boundary === "reassign") await GroupManager.moveCombatants(doc, "b", [member.id]);
    if (boundary === "ungroup") await GroupManager.removeCombatantFromGroup(doc, member.id);
    if (boundary === "groupDelete") await GroupManager.deleteGroup(doc, "a", { confirm: false });
    if (boundary === "combatDelete") await cleanupDeletedCombat(doc);
    if (boundary === "memberDelete") {
      doc.combatants.splice(0, 1); await CombatEvents.deletedMember(doc, member); await CombatEvents.deletedMember(doc, member);
      assert.equal(doc.getFlag(MID, "groups.a.deletedCount"), 1);
    }
    assert.equal(member.actor.effects.length, 0);
    if (["reassign", "ungroup"].includes(boundary)) {
      assert.equal(doc.getFlag(MID, "groups.a.startingSize"), 1);
      assert.equal(doc.getFlag(MID, "groups.a.deletedCount"), 0);
    }
  });
}

for (const method of ["rollMorale", "rollMoraleSingle", "rallyMorale"]) {
  test(`${method} clears a previous failure when the squad becomes Fearless`, async () => {
    environment(); const doc = combat(), member = doc.combatants[0];
    await fail(member); doc.getFlag(MID, "groups.a").discipline = "fearless";
    const result = await MoraleManager[method](doc, "a", member.id);
    assert.equal(result.reason, "Fearless"); assert.equal(member.actor.effects.length, 0);
    assert.equal(member.getFlag(MID, "moraleStatus"), "passed");
  });
}

test("simultaneous HP and defeated events trigger one group-wide captain response, persisted across reload", async () => {
  environment(); const doc = combat(), captain = doc.combatants[0];
  doc.getFlag(MID, "groups.a").captainId = captain.id;
  captain.actor.system.attributes.hp.value = 0; captain.defeated = true;
  const original = MoraleManager._local.rollMorale; let rolls = 0;
  MoraleManager._local.rollMorale = async () => { rolls++; };
  try {
    await Promise.all([handleActorCasualties(captain.actor, { system: { attributes: { hp: { value: 0 } } } }), CombatEvents.casualty(doc, "a")]);
    assert.equal(rolls, 1); assert.equal(doc.getFlag(MID, "groups.a.captainId"), null);
    assert.equal(doc.getFlag(MID, "groups.a.captainDeathTriggered"), true);
    MoraleManager.clearPromptedGroups(doc);
    await MoraleManager.handleCaptainDeath(doc, "a", captain.name); assert.equal(rolls, 1);
  } finally { MoraleManager._local.rollMorale = original; }
});

test("captain deletion takes the same one-time group path and counts a casualty", async () => {
  environment(); const doc = combat(), captain = doc.combatants.shift();
  doc.getFlag(MID, "groups.a").captainId = captain.id;
  const original = MoraleManager._local.rollMorale; let rolls = 0; MoraleManager._local.rollMorale = async () => { rolls++; };
  try {
    await CombatEvents.deletedMember(doc, captain); await CombatEvents.deletedMember(doc, captain);
    assert.equal(rolls, 1); assert.equal(doc.getFlag(MID, "groups.a.deletedCount"), 1);
  } finally { MoraleManager._local.rollMorale = original; }
});

test("migration adopts one unambiguous legacy origin and leaves ambiguous effects intact", async () => {
  environment(); const doc = combat(), member = doc.combatants[0];
  await member.setFlag(MID, "moraleStatus", "failed");
  const [effect] = await member.actor.createEmbeddedDocuments("ActiveEffect", [{ flags: { [MID]: { moraleEffect: true } } }]);
  const original = doc.combatants.map(c => c.initiative);
  await migrateWorldData(); const writes = doc.writes.length; await migrateWorldData();
  assert.equal(effect.getFlag(MID, "moraleCombatantUuid"), member.uuid);
  assert.equal(doc.writes.length, writes); assert.deepEqual(doc.combatants.map(c => c.initiative), original);
  const second = combat(), other = second.combatants[0]; other.actor = member.actor;
  await other.setFlag(MID, "moraleStatus", "failed");
  const [ambiguous] = await member.actor.createEmbeddedDocuments("ActiveEffect", [{ flags: { [MID]: { moraleEffect: true } } }]);
  const report = await migrateWorldData();
  assert.equal(ambiguous.getFlag(MID, "moraleCombatantUuid"), undefined);
  assert.ok(report.warnings.some(w => w.effectId === ambiguous.id));
});

test("manual group initiative survives startup and cosmetic edits but expires after member input changes", async () => {
  environment(); const doc = combat();
  await GroupManager.setGroupInitiative(doc, "a", 5); await migrateWorldData();
  await GroupManager.finalizeGroupInitiative(doc, "a");
  await GroupManager.moveCombatants(doc, "a", ["a1"]);
  await GroupManager.editGroup(doc, "a", { name: "Renamed", pinned: true });
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), 5);
  doc.combatants[0].initiative = 30; await migrateWorldData();
  assert.equal(doc.getFlag(MID, "groups.a.initiative"), 20);
});

test("existing native membership can be explicitly ungrouped but blocks new SCI assignment", async () => {
  environment(); const doc = combat(), member = doc.combatants[0]; member.group = "native";
  await assert.rejects(GroupManager.moveCombatants(doc, "b", [member.id]), /NativeGroupConflict/);
  await GroupManager.removeCombatantFromGroup(doc, member.id);
  assert.equal(member.group, "native"); assert.equal(member.getFlag(MID, "groupId"), undefined);
});

test("skip honors defeated members, round rollover, hooks, and world time; no eligible target is a no-op", async () => {
  environment(); const doc = combat(); const events = []; Hooks.callAll = (...args) => events.push(args);
  doc.turn = 1; doc.current = { combatantId: "a2" }; doc.combatants[2].defeated = true;
  const before = doc.writes.length; assert.equal(await GroupManager.skipGroupTurn(doc, "a"), false); assert.equal(doc.writes.length, before);
  doc.combatants[2].defeated = false;
  assert.equal(await GroupManager.skipGroupTurn(doc, "a"), true); assert.equal(doc.turn, 2); assert.equal(events[0][0], "combatTurn");
  assert.equal(doc.writes.at(-1).options.direction, 1); assert.equal(doc.writes.at(-1).options.worldTime.delta, 1);
  assert.equal(await GroupManager.skipGroupTurn(doc, "b"), true); assert.equal(doc.round, 2); assert.equal(doc.turn, 0); assert.equal(events[1][0], "combatRound");
});
