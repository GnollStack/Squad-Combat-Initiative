import test from "node:test";
import assert from "node:assert/strict";

import { compareGroupedCombatants, getRawInitiative } from "../scripts/initiative-ordering.js";
import { calculateGroupInitiative, INITIATIVE_MODE } from "../scripts/shared.js";

globalThis.CONST = {
  TOKEN_DISPOSITIONS: { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 },
};
const { GroupManager } = await import("../scripts/group-manager.js");

const MODULE_ID = "squad-combat-initiative";

function makeCombat(groups) {
  return {
    groups,
    getFlag(moduleId, path) {
      assert.equal(moduleId, MODULE_ID);
      const [, groupId] = path.split(".");
      return this.groups[groupId];
    },
  };
}

function makeCombatant(combat, id, groupId, initiative) {
  return {
    id,
    name: id,
    initiative,
    parent: combat,
    getFlag(moduleId, key) {
      assert.equal(moduleId, MODULE_ID);
      return key === "groupId" ? groupId : undefined;
    },
  };
}

function nativeCompare(a, b) {
  const ia = Number.isFinite(a.initiative) ? a.initiative : -Infinity;
  const ib = Number.isFinite(b.initiative) ? b.initiative : -Infinity;
  return (ib - ia) || a.id.localeCompare(b.id);
}

function groupCompare(a, b) {
  return compareGroupedCombatants(a, b, {
    moduleId: MODULE_ID,
    fallbackCompare: nativeCompare,
  });
}

test("initiative modes always use the original rolls", () => {
  const raw = [20, 10];
  assert.equal(calculateGroupInitiative(raw, INITIATIVE_MODE.AVERAGE), 15);
  assert.equal(calculateGroupInitiative(raw, INITIATIVE_MODE.HIGHEST), 20);
  assert.equal(calculateGroupInitiative(raw, INITIATIVE_MODE.LOWEST), 10);
  assert.equal(calculateGroupInitiative(raw, INITIATIVE_MODE.MEDIAN), 15);
  assert.equal(calculateGroupInitiative(raw, INITIATIVE_MODE.CAPTAIN, 10), 10);
});

test("two tied twelve-member groups remain contiguous", () => {
  const combat = makeCombat({
    a: { initiative: 10, initiativeTiebreaker: 2 },
    b: { initiative: 10, initiativeTiebreaker: 1 },
  });
  const combatants = [];
  for (let i = 0; i < 12; i += 1) {
    combatants.push(makeCombatant(combat, `a-${i}`, "a", 20 - i));
    combatants.push(makeCombatant(combat, `b-${i}`, "b", 20 - i));
  }

  combatants.sort(groupCompare);
  assert.deepEqual(combatants.map((c) => c.getFlag(MODULE_ID, "groupId")), [
    ...Array(12).fill("a"),
    ...Array(12).fill("b"),
  ]);
});

test("members keep native initiative and tie ordering inside their group", () => {
  const combat = makeCombat({ a: { initiative: 15, initiativeTiebreaker: 0 } });
  const members = [
    makeCombatant(combat, "low", "a", 10),
    makeCombatant(combat, "high", "a", 20),
    makeCombatant(combat, "tie-b", "a", 12),
    makeCombatant(combat, "tie-a", "a", 12),
  ];

  members.sort(groupCompare);
  assert.deepEqual(members.map((c) => c.id), ["high", "tie-a", "tie-b", "low"]);
  assert.deepEqual(members.map(getRawInitiative), [20, 12, 12, 10]);
});

test("ungrouped combatants retain native ordering", () => {
  const combat = makeCombat({});
  const members = [
    makeCombatant(combat, "low", null, 2),
    makeCombatant(combat, "high", "ungrouped", 18),
  ];
  members.sort(groupCompare);
  assert.deepEqual(members.map((c) => c.id), ["high", "low"]);
});

test("unfinalized groups are contiguous below finite initiatives", () => {
  const combat = makeCombat({ a: { initiative: null }, b: { initiative: null } });
  const members = [
    makeCombatant(combat, "b-1", "b", 17),
    makeCombatant(combat, "solo", null, 1),
    makeCombatant(combat, "a-1", "a", null),
    makeCombatant(combat, "b-2", "b", null),
    makeCombatant(combat, "a-2", "a", 19),
  ];
  members.sort(groupCompare);
  assert.deepEqual(members.map((c) => c.id), ["solo", "a-2", "a-1", "b-1", "b-2"]);
});

test("per-combat initiative queue serializes work without dropping operations", async () => {
  const combat = { id: "combat-queue" };
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = GroupManager._enqueueInitiativeOperation(combat, async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = GroupManager._enqueueInitiativeOperation(combat, async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("legacy normalization helper never projects member initiatives", () => {
  const groups = { a: { initiative: 15 } };
  const combat = makeCombat(groups);
  const members = [
    makeCombatant(combat, "high", "a", 20),
    makeCombatant(combat, "low", "a", 10),
  ];
  for (const member of members) {
    member.actor = { system: { abilities: { dex: { mod: 1, value: 12 } } } };
  }
  combat.combatants = members;

  const result = GroupManager._buildNormalizedGroupUpdates(combat);
  assert.deepEqual(result.updates, []);
  assert.deepEqual(members.map((member) => member.initiative), [20, 10]);
});

test("moving rolled combatants reconciles source and target from raw rolls", async () => {
  globalThis.game = {
    user: { id: "gm", isGM: true, isActiveGM: true },
    settings: { get: () => "off" },
  };
  globalThis.ui = { notifications: { warn: () => undefined } };

  const combat = makeMutableCombat({
    source: { name: "Source", initiative: 15, initiativeMode: "average", captainId: "high" },
    target: { name: "Target", initiative: 5, initiativeMode: "average", captainId: null },
  });
  const high = makeMutableCombatant(combat, "high", "source", 20);
  const low = makeMutableCombatant(combat, "low", "source", 10);
  const target = makeMutableCombatant(combat, "target", "target", 5);
  combat.combatants.push(high, low, target);

  assert.equal(await GroupManager.moveCombatants(combat, "target", ["high"]), true);
  assert.equal(high.getFlag(MODULE_ID, "groupId"), "target");
  assert.equal(combat.getFlag(MODULE_ID, "groups.source.captainId"), null);
  assert.equal(combat.getFlag(MODULE_ID, "groups.source.initiative"), 10);
  assert.equal(combat.getFlag(MODULE_ID, "groups.target.initiative"), 13);
  assert.deepEqual([high.initiative, low.initiative, target.initiative], [20, 10, 5]);
});

function makeMutableCombat(groups) {
  const combatants = [];
  combatants.get = (id) => combatants.find((combatant) => combatant.id === id);
  const combat = {
    id: "mutable-combat",
    flags: { [MODULE_ID]: { groups: structuredClone(groups) } },
    combatants,
    getFlag(moduleId, path) {
      return getPath(this.flags[moduleId], path);
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) setFlatPath(this, path, value);
      return this;
    },
    async updateEmbeddedDocuments(_type, updates) {
      for (const update of updates) {
        const combatant = combatants.get(update._id);
        for (const [path, value] of Object.entries(update)) {
          if (path !== "_id") setFlatPath(combatant, path, value);
        }
      }
      return updates.map((update) => combatants.get(update._id));
    },
  };
  return combat;
}

function makeMutableCombatant(combat, id, groupId, initiative) {
  return {
    id,
    name: id,
    initiative,
    parent: combat,
    flags: { [MODULE_ID]: { groupId } },
    actor: { system: { abilities: { dex: { mod: 0, value: 10 } } } },
    getFlag(moduleId, path) {
      return getPath(this.flags[moduleId], path);
    },
  };
}

function getPath(root, path) {
  return String(path).split(".").reduce((value, key) => value?.[key], root);
}

function setFlatPath(root, flatPath, value) {
  const parts = flatPath.split(".");
  let target = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    target[part] ??= {};
    target = target[part];
  }
  const last = parts.at(-1);
  if (last.startsWith("-=")) delete target[last.slice(2)];
  else target[last] = value;
}
