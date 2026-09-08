import test from "node:test";
import assert from "node:assert/strict";
import { collectContracts, localizationFailures } from "../tools/contract-snapshot.mjs";
const contract = await collectContracts();
const { summarizeSmokeChecks } = await import("../scripts/diagnostics.js");

test("skipped combat smoke checks never count as passed gameplay coverage", () => {
  const checks = [{ pass: true }, { pass: null, details: { skipped: true, reason: "No active combat." } }];
  assert.deepEqual(summarizeSmokeChecks(checks), { success: true, passed: 1, failed: 0, skipped: 1 });
  checks.push({ pass: false });
  assert.deepEqual(summarizeSmokeChecks(checks), { success: false, passed: 1, failed: 1, skipped: 1 });
});

test("all literal UI and template localization keys exist", () => { assert.deepEqual(localizationFailures(), []); });
test("configuration and persisted state have separate preset and diagnostic contracts", () => {
  assert.equal(contract.settings.defaultGroupPinned.default, true);
  assert.equal(contract.settings.groupPresets.type, "Object");
  assert.equal(contract.diagnostics.refreshClient, "client-refresh");
  assert.ok(contract.persistedFields.ActiveEffect.moraleCombatantUuid);
  assert.equal(contract.presetFields.includes("captainId"), false);
  assert.equal(contract.commands["groups.savePreset"], "world");
  assert.equal(contract.commands["morale.clearMoraleEffect"], "combatant");
  assert.equal(contract.api.createGroup.parameters, "combat, data, tokens = []");
});
