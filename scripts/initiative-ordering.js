/**
 * Pure helpers for ordering custom combatant groups without rewriting rolled
 * initiative values. This file intentionally has no Foundry globals so the
 * ordering contract can be exercised by Node's built-in test runner.
 */

/**
 * Compare combatants as stable group-sized units.
 *
 * Members of the same custom group retain the active system's native ordering.
 * Different custom groups compare using their finalized group initiative and
 * tiebreaker, so every comparison between two groups has the same sign. This is
 * what guarantees that groups remain contiguous regardless of member count.
 *
 * @param {object} a
 * @param {object} b
 * @param {object} options
 * @param {string} options.moduleId
 * @param {string} [options.ungrouped="ungrouped"]
 * @param {(a: object, b: object) => number} options.fallbackCompare
 * @returns {number}
 */
export function compareGroupedCombatants(a, b, {
  moduleId,
  ungrouped = "ungrouped",
  fallbackCompare,
} = {}) {
  if (typeof fallbackCompare !== "function") {
    throw new TypeError("fallbackCompare must be a function");
  }

  const unitA = getSortUnit(a, moduleId, ungrouped);
  const unitB = getSortUnit(b, moduleId, ungrouped);

  if (!unitA.grouped && !unitB.grouped) return fallbackCompare(a, b);
  if (unitA.key === unitB.key) return fallbackCompare(a, b);

  if (unitA.initiative !== unitB.initiative) {
    return unitB.initiative - unitA.initiative;
  }
  if (unitA.tiebreaker !== unitB.tiebreaker) {
    return unitB.tiebreaker - unitA.tiebreaker;
  }
  return unitA.key.localeCompare(unitB.key);
}

/**
 * Return the native initiative value used as the raw source for group math.
 * Rolled initiatives are never projected into artificial fractional values.
 *
 * @param {object} combatant
 * @returns {number|null}
 */
export function getRawInitiative(combatant) {
  return Number.isFinite(combatant?.initiative) ? combatant.initiative : null;
}

function getSortUnit(combatant, moduleId, ungrouped) {
  const groupId = combatant?.getFlag?.(moduleId, "groupId");
  const group = groupId && groupId !== ungrouped && !combatant.group
    ? combatant?.parent?.getFlag?.(moduleId, `groups.${groupId}`)
    : null;

  if (group && typeof group === "object") {
    return {
      grouped: true,
      key: `group:${groupId}`,
      initiative: Number.isFinite(group.initiative) ? group.initiative : -Infinity,
      tiebreaker: Number.isFinite(group.initiativeTiebreaker) ? group.initiativeTiebreaker : 0,
    };
  }

  return {
    grouped: false,
    key: `combatant:${combatant?.id ?? ""}`,
    initiative: Number.isFinite(combatant?.initiative) ? combatant.initiative : -Infinity,
    tiebreaker: 0,
  };
}
