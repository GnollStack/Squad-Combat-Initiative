/** Shared validation for API, form, preset, and diagnostic group configuration. */
import { MODULE_ID, INITIATIVE_MODE, MORALE_TRIGGER, sanitizeColor, sanitizeImagePath } from "./shared.js";

export const GROUP_CONFIG_FIELDS = Object.freeze({
  name: "string", img: "image", color: "color", pinned: "boolean", hidden: "boolean",
  initiativeMode: Object.values(INITIATIVE_MODE),
  discipline: ["standard", "expendable", "elite", "fearless"],
  moraleTrigger: Object.values(MORALE_TRIGGER), mobConfidenceDivisor: "divisor", captainId: "captain",
});
export const GROUP_STATE_FIELDS = Object.freeze({
  initiative: "number|null", initiativeTiebreaker: "number|null", startingSize: "integer|null",
  deletedCount: "integer", deletedCombatantIds: "string[]", moralePrompted: "boolean", captainDeathTriggered: "boolean",
  initiativeSource: "computed|manual", initiativeInputs: "string",
});
export const PRESET_FIELDS = Object.freeze(["name", "img", "color", "initiativeMode", "discipline", "moraleTrigger"]);
export const PERSISTED_FIELDS = Object.freeze({
  Combat: { groups: { ...GROUP_CONFIG_FIELDS, ...GROUP_STATE_FIELDS }, groupManualOverrides: "object (external read-only override)", skipFinalize: "legacy object, removed at startup" },
  Combatant: { groupId: "string|absent", rawInitiative: "number|absent", moraleStatus: "passed|failed|absent" },
  ActiveEffect: { moraleEffect: "boolean", moraleEffectStatus: "frightened|prone|fleeing", moraleCombatUuid: "string", moraleCombatantUuid: "string", moraleGroupId: "string|null" },
  Fixture: { diagnosticsFixture: "marker object; fixtures only" },
});

export function initiativeInputs(combat, groupId) {
  const group = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
  const members = combat.combatants.filter(c => c.getFlag(MODULE_ID, "groupId") === groupId)
    .map(c => [c.id, Number.isFinite(c.initiative) ? c.initiative : null]).sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify([group.initiativeMode ?? "average", group.captainId ?? null, members]);
}

export function normalizeGroupConfig(data, { partial = true, combat = null, groupId = null } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(game.i18n.localize("SCI.Errors.InvalidGroup"));
  const result = {};
  for (const [key, kind] of Object.entries(GROUP_CONFIG_FIELDS)) {
    const value = data[key];
    if (value === undefined) continue;
    let valid = true;
    if (Array.isArray(kind)) valid = kind.includes(value);
    else if (kind === "string") valid = typeof value === "string" && value.trim().length > 0 && value.length <= 200;
    else if (kind === "boolean") valid = typeof value === "boolean";
    else if (kind === "divisor") valid = value === null || (Number.isInteger(value) && value >= 1 && value <= 10);
    else if (kind === "captain") valid = value === null || (typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value));
    else valid = typeof value === "string";
    if (!valid) throw new Error(game.i18n.format("SCI.Errors.InvalidGroupField", { field: key }));
    result[key] = key === "name" ? value.trim() : key === "img" ? sanitizeImagePath(value, "icons/svg/combat.svg")
      : key === "color" ? sanitizeColor(value, "#7b68ee") : value;
  }
  if (!partial && !result.name) throw new Error(game.i18n.localize("SCI.Errors.InvalidGroup"));
  if (combat && groupId && result.captainId) {
    const captain = combat.combatants.get(result.captainId);
    if (!captain || captain.getFlag(MODULE_ID, "groupId") !== groupId) {
      throw new Error(game.i18n.localize("SCI.Errors.CaptainMembership"));
    }
  }
  return result;
}

export function hasNativeGroup(combatant) {
  // Stored legacy native IDs are inert while SCI is enabled.
  return !!combatant.group;
}

export function assertSeparateGroups(combatants) {
  if (combatants.some(hasNativeGroup)) throw new Error(game.i18n.localize("SCI.Errors.NativeGroupConflict"));
}
