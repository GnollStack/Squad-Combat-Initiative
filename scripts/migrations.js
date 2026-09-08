import { MODULE_ID, logger } from "./shared.js";
import { initiativeInputs, hasNativeGroup } from "./group-contracts.js";
import { GroupManager } from "./group-manager.js";
import { MoraleManager } from "./morale.js";
import { isMutationAuthority, registerCommandOwner } from "./mutation-authority.js";
import { updateCombatState } from "./combat-state.js";

export const migrationReport = { checkedAt: null, warnings: [] };

export class Migrations {
  static async combat(combat) {
    const updates = {};
    const reconcile = [];
    for (const [id, group] of Object.entries(combat.getFlag(MODULE_ID, "groups") ?? {})) {
      const inputs = initiativeInputs(combat, id);
      const defaults = {
        initiative: null, initiativeTiebreaker: null, initiativeMode: "average", captainId: null,
        discipline: "standard", moraleTrigger: "both", mobConfidenceDivisor: null,
        startingSize: null, deletedCount: 0, deletedCombatantIds: [], moralePrompted: false,
        captainDeathTriggered: false, hidden: false, pinned: false,
        // Legacy finite scores may have been manual. Preserve them on adoption.
        initiativeSource: Number.isFinite(group.initiative) ? "manual" : "computed", initiativeInputs: inputs,
      };
      for (const [key, value] of Object.entries(defaults)) {
        if (group[key] === undefined) updates[`flags.${MODULE_ID}.groups.${id}.${key}`] = value;
      }
      const members = combat.combatants.filter(c => c.getFlag(MODULE_ID, "groupId") === id);
      if (!members.length || members.some(c => !Number.isFinite(c.initiative)) || group.initiativeSource === "computed" || group.initiative == null || group.initiativeInputs && group.initiativeInputs !== inputs) reconcile.push(id);
    }
    if (Object.keys(updates).length) await updateCombatState(combat, updates);
    await GroupManager._local.reconcileGroupInitiatives(combat, reconcile);
    return combat.combatants.filter(c => hasNativeGroup(c) && c.getFlag(MODULE_ID, "groupId") && c.getFlag(MODULE_ID, "groupId") !== "ungrouped")
      .map(c => ({ code: "native-squad-conflict", combatUuid: combat.uuid, combatantUuid: c.uuid }));
  }
}
registerCommandOwner("migration", Migrations, { combat: "combat" });

export async function migrateWorldData() {
  if (!isMutationAuthority()) return migrationReport;
  const warnings = await MoraleManager.migrateEffectOrigins();
  for (const combat of game.combats ?? []) warnings.push(...await Migrations.combat(combat));
  Object.assign(migrationReport, { checkedAt: new Date().toISOString(), warnings });
  if (warnings.length) logger.warn("SCI migration requires review; ambiguous data was preserved", { data: warnings });
  return migrationReport;
}
