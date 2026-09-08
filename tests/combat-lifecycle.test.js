import test from "node:test";
import assert from "node:assert/strict";
import { compareGroupedCombatants } from "../scripts/initiative-ordering.js";

globalThis.CONST = { TOKEN_DISPOSITIONS: { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 } };
globalThis.game = {
  user: { id: "gm", isGM: true, isActiveGM: true },
  settings: { get: () => "off" },
  i18n: { localize: key => key, format: key => key },
  users: Object.assign([], { activeGM: { id: "gm" } }),
};
globalThis.ui = { notifications: { warn() {} }, combat: { render() {} } };
globalThis.foundry = { data: { operators: { ForcedDeletion: class {} } } };
const { GroupManager } = await import("../scripts/group-manager.js");
const { onDeleteCombatant } = await import("../scripts/combat-tracker.js");
const MID = "squad-combat-initiative";

function put(root, path, value) {
  const parts = path.split(".");
  for (const part of parts.slice(0, -1)) root = root[part] ??= {};
  if (value instanceof foundry.data.operators.ForcedDeletion) delete root[parts.at(-1)];
  else root[parts.at(-1)] = value;
}

function fixture() {
  const combat = {
    id: "fixture", uuid: "Combat.fixture", documentName: "Combat", round: 1, turn: 0,
    flags: { [MID]: { groups: {
      a: { name: "A", initiative: 15, initiativeMode: "average" },
      b: { name: "B", initiative: 12, initiativeMode: "average" },
    } } },
    combatants: [], turns: [], writes: [],
    get combatant() { return this.turns[this.turn]; },
    getFlag(module, path) { return path.split(".").reduce((v, p) => v?.[p], this.flags[module]); },
    async setFlag(module, path, value) { return this.update({ [`flags.${module}.${path}`]: value }); },
    async update(changes, options = {}) {
      this.writes.push({ changes, options });
      for (const [key, value] of Object.entries(changes)) put(this, key, value);
      // Core Combat does not rebuild turns for flag-only updates.
      return this;
    },
    async updateEmbeddedDocuments(_type, updates) {
      for (const update of updates) {
        const member = this.combatants.get(update._id);
        for (const [key, value] of Object.entries(update)) if (key !== "_id") put(member, key, value);
      }
      this.setupTurns();
      return updates.map(update => this.combatants.get(update._id));
    },
    setupTurns() {
      this.turns = [...this.combatants].sort((a, b) => compareGroupedCombatants(a, b, {
        moduleId: MID, fallbackCompare: (a, b) => b.initiative - a.initiative,
      }));
      this.current = { combatantId: this.combatant?.id, turn: this.turn, round: this.round };
      return this.turns;
    },
  };
  for (const [id, groupId, initiative] of [["a1", "a", 20], ["a2", "a", 10], ["b1", "b", 12]]) {
    const member = {
      id, uuid: `Combat.fixture.Combatant.${id}`, documentName: "Combatant", name: id,
      parent: combat, initiative, flags: { [MID]: { groupId } },
      actor: { system: { abilities: { dex: { mod: 0, value: 10 } } } },
      getFlag(module, path) { return path.split(".").reduce((v, p) => v?.[p], this.flags[module]); },
      async unsetFlag(module, path) { delete this.flags[module][path]; },
    };
    combat.combatants.push(member);
  }
  combat.combatants.get = id => combat.combatants.find(c => c.id === id);
  combat.setupTurns(); // Initial native document preparation, never a post-action repair.
  game.combats = Object.assign([combat], { get: id => id === combat.id ? combat : undefined });
  return combat;
}

test("setting group initiative refreshes actual turn order and preserves the active member", async () => {
  const combat = fixture();
  await GroupManager.setGroupInitiative(combat, "a", 5);
  assert.deepEqual(combat.turns.map(c => c.id), ["b1", "a1", "a2"]);
  assert.equal(combat.combatant.id, "a1");
  assert.equal(combat.round, 1);
  assert.deepEqual(combat.combatants.map(c => c.initiative), [20, 10, 12]);
});

test("deleting an ordinary member recalculates the group and records one casualty", async () => {
  const combat = fixture();
  const deleted = combat.combatants.shift();
  combat.setupTurns(); // Core rebuilds before dispatching deleteCombatant.
  await onDeleteCombatant(deleted);
  assert.equal(combat.getFlag(MID, "groups.a.initiative"), 10);
  assert.equal(combat.getFlag(MID, "groups.a.deletedCount"), 1);
});

test("individual reset clears a partially rolled group's computed initiative", async () => {
  const combat = fixture();
  combat.combatants[0].initiative = null;
  await GroupManager.finalizeGroupInitiative(combat, "a");
  assert.equal(combat.getFlag(MID, "groups.a.initiative"), null);
});

test("an edit arriving during finalization is reconciled after the in-flight write", async () => {
  const combat = fixture();
  let started, release;
  const start = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const apply = GroupManager._applyGroupOrder;
  const snapshots = [];
  GroupManager._applyGroupOrder = async (_combat, _group, list) => {
    snapshots.push(list.map(entry => entry.init));
    if (snapshots.length === 1) { started(); await gate; }
  };
  try {
    const first = GroupManager.finalizeGroupInitiative(combat, "a");
    await start;
    combat.combatants[0].initiative = 30;
    const second = GroupManager.finalizeGroupInitiative(combat, "a");
    release();
    await Promise.all([first, second]);
    assert.deepEqual(snapshots.at(-1), [30, 10]);
  } finally { GroupManager._applyGroupOrder = apply; }
});
