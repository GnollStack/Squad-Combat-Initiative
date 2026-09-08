/** Automatic document events have one authority and share the command queue. */
import { MODULE_ID, MORALE_TRIGGER, logger } from "./shared.js";
import { GroupManager } from "./group-manager.js";
import { MoraleManager } from "./morale.js";
import { isMutationAuthority, assertMutationAuthority, registerCommandOwner } from "./mutation-authority.js";
import { updateCombatState, updateMembers } from "./combat-state.js";

export class CombatEvents {
  static async nativeOrder(combat) {
    if (Object.keys(combat.getFlag(MODULE_ID, "groups") ?? {}).length) await updateCombatState(combat, {});
  }
  static async visibility(combat, member, hidden, source) {
    if (game.settings.get(MODULE_ID, "visibilitySyncMode") !== "bidirectional") return;
    if (source === "combatant" && member.token && member.token.hidden !== hidden) {
      assertMutationAuthority();
      await member.token.update({ hidden }, { sciVisibilitySync: true });
    } else if (source === "token" && member.hidden !== hidden) {
      await updateMembers(combat, [{ _id: member.id, hidden }], { sciVisibilitySync: true });
    }
    const id = member.getFlag(MODULE_ID, "groupId");
    if (!id || !combat.getFlag(MODULE_ID, `groups.${id}`)) return;
    const members = combat.combatants.filter(c => c.getFlag(MODULE_ID, "groupId") === id);
    if (members.every(c => c.hidden === hidden) && combat.getFlag(MODULE_ID, `groups.${id}.hidden`) !== hidden) {
      await updateCombatState(combat, { [`flags.${MODULE_ID}.groups.${id}.hidden`]: hidden });
    }
  }
  static async createdMember(combat, member) {
    const groupId = member.getFlag(MODULE_ID, "groupId");
    if (!groupId) {
      await updateMembers(combat, [{ _id: member.id, [`flags.${MODULE_ID}.groupId`]: "ungrouped" }]);
      return;
    }
    if (groupId === "ungrouped") return;
    const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
    if (group && Number.isFinite(group.startingSize)) {
      await updateCombatState(combat, { [`flags.${MODULE_ID}.groups.${groupId}.startingSize`]: group.startingSize + 1 });
    }
    await GroupManager._local.reconcileGroupInitiatives(combat, [groupId]);
  }

  static async membershipChanged(combat, member, previousGroup) {
    const target = member.getFlag(MODULE_ID, "groupId");
    if (target === previousGroup) return;
    await MoraleManager._local.clearMoraleEffect(member);
    const changes = {};
    for (const [id, delta] of [[previousGroup, -1], [target, 1]]) {
      const group = id && combat.getFlag(MODULE_ID, `groups.${id}`);
      if (!group) continue;
      if (Number.isFinite(group.startingSize)) changes[`flags.${MODULE_ID}.groups.${id}.startingSize`] = Math.max(0, group.startingSize + delta);
      if (delta < 0 && group.captainId === member.id) changes[`flags.${MODULE_ID}.groups.${id}.captainId`] = null;
    }
    if (Object.keys(changes).length) await updateCombatState(combat, changes);
    if (member.getFlag(MODULE_ID, "moraleStatus")) await updateMembers(combat, [{
      _id: member.id, [`flags.${MODULE_ID}.moraleStatus`]: new foundry.data.operators.ForcedDeletion(),
    }]);
    await GroupManager._local.reconcileGroupInitiatives(combat, [previousGroup, target]);
  }

  static async deletedMember(combat, member) {
    const groupId = member.getFlag(MODULE_ID, "groupId");
    await MoraleManager._local.clearMoraleEffect(member);
    if (!groupId || groupId === "ungrouped") return;
    const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
    if (!group) return;
    const ids = group.deletedCombatantIds ?? [];
    if (ids.includes(member.id)) return;
    await updateCombatState(combat, {
      [`flags.${MODULE_ID}.groups.${groupId}.deletedCount`]: (group.deletedCount ?? 0) + 1,
      [`flags.${MODULE_ID}.groups.${groupId}.deletedCombatantIds`]: [...ids, member.id],
    });
    if (group.captainId === member.id) {
      if (game.settings.get(MODULE_ID, "moraleEnabled") === true
        && [MORALE_TRIGGER.BOTH, MORALE_TRIGGER.CAPTAIN_DEATH].includes(group.moraleTrigger ?? MORALE_TRIGGER.BOTH)) {
        await MoraleManager._local.handleCaptainDeath(combat, groupId, member.name);
      } else await GroupManager._local.removeCaptain(combat, groupId);
    }
    await GroupManager._local.reconcileGroupInitiatives(combat, [groupId]);
    await this._local.casualty(combat, groupId);
  }

  static async casualty(combat, groupId) {
    if (game.settings.get(MODULE_ID, "moraleEnabled") !== true) return;
    const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
    if (!group) return;
    const trigger = group.moraleTrigger ?? MORALE_TRIGGER.BOTH;
    if (trigger === MORALE_TRIGGER.MANUAL) return;
    const captain = combat.combatants.get(group.captainId);
    if ([MORALE_TRIGGER.BOTH, MORALE_TRIGGER.CAPTAIN_DEATH].includes(trigger) && captain
      && (captain.isDefeated || captain.defeated || captain.actor?.system?.attributes?.hp?.value <= 0)) {
      await MoraleManager._local.handleCaptainDeath(combat, groupId, captain.name);
      return;
    }
    if ([MORALE_TRIGGER.BOTH, MORALE_TRIGGER.THRESHOLD].includes(trigger)
      && MoraleManager.shouldAutoPrompt(combat, groupId)) await MoraleManager._local.sendAutoPrompt(combat, groupId);
  }

  static async startTurn(combat) {
    if (game.settings.get(MODULE_ID, "moraleEnabled") !== true || !combat.started && !combat.round) return;
    await MoraleManager._local.recordStartingSizes(combat);
    if (combat.combatant) await MoraleManager._local.checkAutoMorale(combat, combat.combatant);
  }
}

registerCommandOwner("events", CombatEvents, { nativeOrder: "combat", visibility: "combat", createdMember: "combat", membershipChanged: "combat", deletedMember: "combat", casualty: "combat", startTurn: "combat" });

export async function handleActorCasualties(actor, changes) {
  if (!isMutationAuthority() || changes?.system?.attributes?.hp?.value === undefined) return;
  for (const combat of game.combats ?? []) {
    const groups = new Set(combat.combatants.filter(c => c.actor?.uuid === actor.uuid)
      .map(c => c.getFlag(MODULE_ID, "groupId")).filter(id => id && id !== "ungrouped"));
    for (const groupId of groups) await CombatEvents.casualty(combat, groupId);
  }
}

export async function cleanupDeletedCombat(combat) {
  if (!isMutationAuthority()) return;
  for (const member of combat.combatants) {
    try { await MoraleManager._local.clearMoraleEffect(member); }
    catch (error) { logger.error("Failed to clean deleted encounter morale", error); }
  }
}
