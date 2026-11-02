import test from "node:test";
import assert from "node:assert/strict";
import { collectContracts } from "../tools/contract-snapshot.mjs";

await collectContracts();
const { registerDiagnostics } = await import("../scripts/diagnostics.js");

function setup({ combat = null, scene = { id: "scene", name: "Scene" } } = {}) {
  const writes = [];
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => { writes.push(["setItem", key]); store.set(key, value); },
    removeItem: key => { writes.push(["removeItem", key]); store.delete(key); },
  };
  globalThis.game = {
    world: { id: "world" },
    user: { id: "player", name: "Player", isGM: false, active: true, role: 1 },
    users: [],
    combat,
    modules: new Map(),
    settings: {
      get: () => false,
      set: async (...entry) => writes.push(["set", ...entry]),
    },
    socket: { on() {}, emit: (...entry) => writes.push(["emit", ...entry]) },
    i18n: { localize: key => key, format: key => key },
  };
  globalThis.canvas = { scene, ready: Boolean(scene) };
  globalThis.ui = { combat: { rendered: false }, notifications: { warn() {}, info() {}, error() {} } };
  return { store, writes };
}

const diagnosticsOf = () => registerDiagnostics({});

test("clientEvidence answers on a player client with the diagnostics gate closed", () => {
  const { writes } = setup();
  const diagnostics = diagnosticsOf();
  assert.equal(diagnostics.getAvailability().available, false);
  assert.equal(diagnostics.actions.clientEvidence, undefined);
  const evidence = diagnostics.clientEvidence({}, { requesterId: "gm", requesterName: "GM" });
  assert.equal(evidence.success, true, evidence.reason);
  assert.equal(evidence.user.id, "player");
  assert.equal(evidence.scene.id, "scene");
  assert.equal(evidence.moduleState.combat, null);
  assert.deepEqual(writes, []);
});

test("mutation is unavailable until confirmMutation is passed, and the actions enforce it", async () => {
  setup();
  game.user.isGM = true;
  const values = { debugLevel: "info", enableMcpDiagnostics: true, allowMutatingDiagnostics: true };
  game.settings.get = (_module, key) => values[key];
  const diagnostics = diagnosticsOf();

  const unconfirmed = diagnostics.getMutationAvailability();
  assert.equal(unconfirmed.available, false);
  assert.equal(unconfirmed.reason, "Missing confirmMutation: true");
  assert.equal(unconfirmed.gates.mutationEnabled, true);
  assert.equal(unconfirmed.gates.mutationConfirmed, false);

  const confirmed = diagnostics.getMutationAvailability({ confirmMutation: true });
  assert.equal(confirmed.available, true);
  assert.equal(confirmed.reason, undefined);

  values.allowMutatingDiagnostics = false;
  const disallowed = diagnostics.getMutationAvailability({ confirmMutation: true });
  assert.equal(disallowed.available, false);
  assert.equal(disallowed.gates.mutationEnabled, false);
  values.allowMutatingDiagnostics = true;

  const denied = await Promise.resolve().then(() => diagnostics.actions.cleanupFixtures({})).then(result => result, error => ({ thrown: error.message }));
  assert.match(denied.thrown ?? denied.error ?? JSON.stringify(denied), /confirmMutation/);
});

test("clientEvidence reads a legacy expanded key without migrating it", () => {
  const combat = { id: "combat", round: 1, turn: 0, combatant: null, turns: [], combatants: [], groups: [], getFlag: () => ({}) };
  const { store, writes } = setup({ combat });
  store.set("squad-combat-initiative.expanded.combat", JSON.stringify(["legacy"]));
  store.set("squad-combat-initiative.expanded.world.player.combat", JSON.stringify(["current"]));
  const evidence = diagnosticsOf().clientEvidence();
  assert.equal(evidence.success, true, evidence.reason);
  assert.deepEqual(evidence.moduleState.localUi.expandedGroupIds, ["current"]);

  store.delete("squad-combat-initiative.expanded.world.player.combat");
  const legacyOnly = diagnosticsOf().clientEvidence();
  assert.deepEqual(legacyOnly.moduleState.localUi.expandedGroupIds, []);
  assert.equal(store.has("squad-combat-initiative.expanded.combat"), true);
  assert.deepEqual(writes, []);
});

test("clientEvidence stays under 16 kB in a very large fight", () => {
  const turns = Array.from({ length: 900 }, (_, index) => ({ id: `combatant-with-a-long-id-${index}` }));
  const combat = { id: "combat", round: 1, turn: 0, combatant: null, turns, combatants: turns, groups: [], getFlag: () => ({}) };
  setup({ combat });
  const evidence = diagnosticsOf().clientEvidence();
  assert.equal(evidence.success, true, evidence.reason);
  assert.equal(evidence.moduleState.combat.truncated, true);
  assert.equal(evidence.moduleState.combat.combatants, 900);
  assert.ok(JSON.stringify(evidence).length <= 16000);
});

test("clientEvidence returns a reason instead of throwing, with no scene it still answers", () => {
  setup({ scene: null });
  assert.equal(diagnosticsOf().clientEvidence().scene.id, null);
  setup();
  Object.defineProperty(game, "combat", { get() { throw new Error("broken combat"); } });
  const evidence = diagnosticsOf().clientEvidence();
  assert.equal(evidence.success, false);
  assert.match(evidence.reason, /broken combat/);
});
