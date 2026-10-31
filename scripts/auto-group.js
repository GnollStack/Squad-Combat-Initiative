/** Automatic squad creation by actor or disposition. Invoked with GroupManager as `this`. */
import { MODULE_ID, logger, isGM, MORALE_TRIGGER, generateGroupId, expandStore } from "./shared.js";
import { updateCombatState, updateMembers } from "./combat-state.js";
import { hasNativeGroup, UNGROUPED } from "./group-contracts.js";
import { MoraleManager } from "./morale.js";

const AUTO_GROUP_COLORS = Object.freeze([
  "#7b68ee",
  "#4caf50",
  "#ff9800",
  "#03a9f4",
  "#e91e63",
  "#8bc34a",
  "#f44336",
  "#9c27b0",
]);

const DISPOSITION_LABEL_KEYS = Object.freeze({
  [CONST.TOKEN_DISPOSITIONS.SECRET]: "SCI.Disposition.Secret",
  [CONST.TOKEN_DISPOSITIONS.HOSTILE]: "SCI.Disposition.Hostile",
  [CONST.TOKEN_DISPOSITIONS.NEUTRAL]: "SCI.Disposition.Neutral",
  [CONST.TOKEN_DISPOSITIONS.FRIENDLY]: "SCI.Disposition.Friendly",
});

/** Implementation of GroupManager.autoGroupCombatants; the facade in group-manager.js carries the public contract. */
export async function autoGroupCombatants(combat, {
  combatants = null,
  groupBy = "actor",
  includeGrouped = false,
  includeSingletons = false,
} = {}) {
  const log = logger.fn("autoGroupCombatants");

  if (!isGM()) {
    log.warn("Non-GM attempted to auto-group combatants");
    return { groupsCreated: 0, groupsDeleted: 0, combatantsAssigned: 0, skipped: 0, groupIds: [] };
  }
  if (!combat) throw new Error("combat is required");

  const source = Array.from(combatants ?? combat.combatants).filter((c) => c?.actor);
  if (source.some(c => c.parent !== combat)) throw new Error(game.i18n.localize("SCI.Errors.CrossCombatDrop"));
  const eligible = source.filter(c => !hasNativeGroup(c));
  const candidates = includeGrouped
    ? eligible
    : eligible.filter((c) => {
        const groupId = c.getFlag(MODULE_ID, "groupId");
        return !groupId || groupId === UNGROUPED;
      });

  const buckets = new Map();
  for (const combatant of candidates) {
    const bucket = this._getAutoGroupBucket(combatant, groupBy);
    if (!bucket) continue;
    if (!buckets.has(bucket.key)) {
      buckets.set(bucket.key, { ...bucket, members: [] });
    }
    buckets.get(bucket.key).members.push(combatant);
  }

  const groups = Array.from(buckets.values())
    .filter((bucket) => includeSingletons || bucket.members.length > 1)
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

  if (!groups.length) {
    return {
      groupsCreated: 0,
      groupsDeleted: 0,
      combatantsAssigned: 0,
      skipped: source.length - candidates.length,
      groupIds: [],
    };
  }

  const existingNames = new Set(
    Object.values(combat.getFlag(MODULE_ID, "groups") ?? {})
      .map((group) => group?.name)
      .filter(Boolean)
  );
  const expandedSet = expandStore.load(combat.id);
  const groupIds = [];
  const updateData = {};
  const combatantUpdates = [];
  const captainClearGroupIds = new Set();
  const oldGroupIds = new Set();
  const reassignedCombatantIds = new Set();

  groups.forEach((bucket, index) => {
    const groupId = generateGroupId();
    const groupName = this._getUniqueGroupName(bucket.name, existingNames);
    const hidden = bucket.members.every((c) => c.hidden);

    groupIds.push(groupId);
    expandedSet.add(groupId);

    updateData[`flags.${MODULE_ID}.groups.${groupId}`] = {
      name: groupName,
      initiative: null,
      pinned: game.settings.get(MODULE_ID, "defaultGroupPinned"),
      img: bucket.img || "icons/svg/combat.svg",
      color: AUTO_GROUP_COLORS[index % AUTO_GROUP_COLORS.length],
      hidden,
      discipline: "standard",
      startingSize: combat.round >= 1 ? bucket.members.length : null,
      deletedCount: 0,
      initiativeMode: game.settings.get(MODULE_ID, "defaultInitiativeMode"),
      captainId: null,
      moraleTrigger: MORALE_TRIGGER.BOTH,
    };

    for (const combatant of bucket.members) {
      const oldGroupId = combatant.getFlag(MODULE_ID, "groupId");
      if (includeGrouped && oldGroupId && oldGroupId !== UNGROUPED) {
        oldGroupIds.add(oldGroupId);
        const oldMeta = combat.getFlag(MODULE_ID, `groups.${oldGroupId}`) ?? {};
        if (oldMeta.captainId === combatant.id) {
          captainClearGroupIds.add(oldGroupId);
        }
      }
      reassignedCombatantIds.add(combatant.id);
      combatantUpdates.push({
        _id: combatant.id,
        [`flags.${MODULE_ID}.groupId`]: groupId,
      });
    }
  });

  const deletedOldGroupIds = new Set();
  if (includeGrouped) {
    for (const oldGroupId of oldGroupIds) {
      const remaining = combat.combatants.filter((combatant) => {
        if (reassignedCombatantIds.has(combatant.id)) return false;
        return combatant.getFlag(MODULE_ID, "groupId") === oldGroupId;
      });
      if (!remaining.length) {
        updateData[`flags.${MODULE_ID}.groups.${oldGroupId}`] = new foundry.data.operators.ForcedDeletion();
        deletedOldGroupIds.add(oldGroupId);
      }
    }

    for (const oldGroupId of captainClearGroupIds) {
      if (!deletedOldGroupIds.has(oldGroupId)) {
        updateData[`flags.${MODULE_ID}.groups.${oldGroupId}.captainId`] = null;
      }
    }
  }

  for (const member of source.filter(c => reassignedCombatantIds.has(c.id))) {
    const oldGroupId = member.getFlag(MODULE_ID, "groupId");
    if (oldGroupId && oldGroupId !== UNGROUPED) {
      await MoraleManager._local.clearMorale(combat, oldGroupId, member.id);
      if (!deletedOldGroupIds.has(oldGroupId)) {
        const path = `flags.${MODULE_ID}.groups.${oldGroupId}.startingSize`;
        const size = updateData[path] ?? combat.getFlag(MODULE_ID, `groups.${oldGroupId}.startingSize`);
        if (Number.isFinite(size)) updateData[path] = Math.max(0, size - 1);
      }
    }
  }
  await updateCombatState(combat, updateData);
  await updateMembers(combat, combatantUpdates);
  await this._local.reconcileGroupInitiatives(combat, [
    ...groupIds,
    ...[...oldGroupIds].filter((groupId) => !deletedOldGroupIds.has(groupId)),
  ]);
  expandStore.save(combat.id, expandedSet);

  const result = {
    groupsCreated: groupIds.length,
    groupsDeleted: deletedOldGroupIds.size,
    combatantsAssigned: combatantUpdates.length,
    skipped: source.length - candidates.length,
    groupIds,
  };
  log.debug("Auto-grouped combatants", result);
  return result;
}

/** Implementation of GroupManager._getAutoGroupBucket; the facade in group-manager.js carries the public contract. */
export function _getAutoGroupBucket(combatant, groupBy) {
  if (groupBy === "disposition") {
    const disposition = combatant.token?.disposition ?? CONST.TOKEN_DISPOSITIONS.NEUTRAL;
    const labelKey = DISPOSITION_LABEL_KEYS[disposition];
    return {
      key: `disposition:${disposition}`,
      name: labelKey
        ? game.i18n.localize(labelKey)
        : game.i18n.format("SCI.Disposition.Other", { disposition }),
      img: "icons/svg/mystery-man.svg",
    };
  }

  const actor = combatant.token?.baseActor ?? combatant.actor;
  const actorId = actor?.id ?? combatant.actorId ?? combatant.name;
  const actorName = actor?.name ?? combatant.actor?.name ?? combatant.name ?? game.i18n.localize("SCI.UnknownActor");
  return {
    key: `actor:${actorId}`,
    name: actorName,
    img: combatant.img || actor?.img || combatant.actor?.img || "icons/svg/mystery-man.svg",
  };
}

/** Implementation of GroupManager._getUniqueGroupName; the facade in group-manager.js carries the public contract. */
export function _getUniqueGroupName(baseName, existingNames) {
  const name = baseName || game.i18n.localize("SCI.AutoGroupFallbackName");
  if (!existingNames.has(name)) {
    existingNames.add(name);
    return name;
  }

  let i = 2;
  let candidate = `${name} ${i}`;
  while (existingNames.has(candidate)) {
    i += 1;
    candidate = `${name} ${i}`;
  }
  existingNames.add(candidate);
  return candidate;
}
