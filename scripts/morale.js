/**
 * @file morale.js
 * @description Squad Morale System - rolling, tracking, status effect application, and chat output.
 * @version Foundry V14+
 */

import {
  MODULE_ID,
  logger,
  isGM,
  MORALE_TRIGGER,
  escapeHtml,
  sanitizeColor,
  sanitizeImagePath,
  formatModifier,
  localizeEnumValue,
  TEMPLATES,
  renderModuleTemplate,
} from "./shared.js";

function isCombatantDefeated(combatant) {
  return combatant?.isDefeated ?? combatant?.defeated ?? false;
}

function getCombatantHp(combatant) {
  return combatant?.actor?.system?.attributes?.hp?.value;
}

/**
 * Discipline level enum.
 * @readonly
 * @enum {string}
 */
export const DISCIPLINE = Object.freeze({
  EXPENDABLE: "expendable",
  STANDARD: "standard",
  ELITE: "elite",
  FEARLESS: "fearless",
});

/**
 * In-memory set of groupIds that have already been auto-prompted this combat.
 * Prevents spamming the GM with repeated prompts.
 * @type {Set<string>}
 */
const _promptedGroups = new Set();

/**
 * In-memory set of groupIds that have already triggered captain death morale.
 * Prevents repeated morale checks from the same captain dying.
 * @type {Set<string>}
 */
const _captainDeathPrompted = new Set();

function moraleGateKey(combat, groupId) {
  return `${combat?.id ?? "unknown"}:${groupId}`;
}

const BUILT_IN_MORALE_STATUS_EFFECTS = new Set(["frightened", "prone"]);
const MORALE_EFFECT_FLAG = "moraleEffect";
const MORALE_EFFECT_STATUS_FLAG = "moraleEffectStatus";

function getChatGroupFields(groupMeta) {
  const groupName = groupMeta.name ?? game.i18n.localize("SCI.UnnamedGroup");
  return {
    groupName,
    groupColor: sanitizeColor(groupMeta.color, "#7b68ee"),
    groupImg: sanitizeImagePath(groupMeta.img, "icons/svg/combat.svg"),
  };
}

function getCombatantImage(combatant) {
  return sanitizeImagePath(combatant?.img || combatant?.token?.texture?.src || "", "");
}

/**
 * Wrap a user-controlled name in <strong> for safe insertion into a
 * localized HTML fragment rendered with triple-stash.
 * @param {string} name
 * @returns {string}
 */
function boldName(name) {
  return `<strong>${escapeHtml(name)}</strong>`;
}

function formatMoraleModifiers(entry) {
  return game.i18n.format("SCI.Chat.Modifiers", {
    wis: formatModifier(entry.wisSave),
    cr: formatModifier(entry.cr),
    mob: formatModifier(entry.mobConfidence),
  });
}

function formatDcBreakdown(count) {
  return game.i18n.format("SCI.Chat.DcBreakdown", { count });
}

/**
 * Static class managing morale checks for groups.
 */
export class MoraleManager {

  /**
   * Get living members of a group (not defeated and HP > 0 when HP exists).
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {Combatant[]}
   */
  static getLivingMembers(combat, groupId) {
    return combat.combatants.filter((c) => {
      if (c.getFlag(MODULE_ID, "groupId") !== groupId) return false;
      if (isCombatantDefeated(c)) return false;
      const hp = getCombatantHp(c);
      return hp == null || hp > 0;
    });
  }

  /**
   * Get dead members of a group (defeated or HP <= 0).
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {Combatant[]}
   */
  static getDeadMembers(combat, groupId) {
    return combat.combatants.filter((c) => {
      if (c.getFlag(MODULE_ID, "groupId") !== groupId) return false;
      const hp = getCombatantHp(c);
      return isCombatantDefeated(c) || (hp != null && hp <= 0);
    });
  }

  /**
   * Calculate casualty count: dead members + deleted members.
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {number}
   */
  static getCasualtyCount(combat, groupId) {
    const dead = this.getDeadMembers(combat, groupId).length;
    const deletedCount = combat.getFlag(MODULE_ID, `groups.${groupId}.deletedCount`) ?? 0;
    return dead + deletedCount;
  }

  /**
   * Calculate mob confidence bonus.
   * @param {number} livingCount
   * @param {number} divisor
   * @returns {number}
   */
  static getMobConfidence(livingCount, divisor = 3) {
    return Math.floor(livingCount / divisor);
  }

  /**
   * Check if auto-prompt threshold is met for a group.
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {boolean}
   */
  static shouldAutoPrompt(combat, groupId) {
    const threshold = game.settings.get(MODULE_ID, "moraleAutoPromptThreshold");
    if (threshold <= 0) return false;

    if (this.isGroupPrompted(combat, groupId)) return false;

    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const startingSize = groupMeta.startingSize;
    if (!startingSize || startingSize <= 0) return false;

    const living = this.getLivingMembers(combat, groupId);
    return living.length <= Math.floor(startingSize * (threshold / 100));
  }

  /**
   * Prepare common morale check parameters for a group.
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {{ groupMeta: Object, groupName: string, discipline: string, dc: number, dieExpr: string, mobConfidence: number, mobConfidenceDivisor: number, casualtyCount: number, living: Combatant[] }}
   */
  static _prepareGroupParams(combat, groupId) {
    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const groupName = groupMeta.name ?? game.i18n.localize("SCI.UnnamedGroup");
    const discipline = groupMeta.discipline ?? DISCIPLINE.STANDARD;
    const living = this.getLivingMembers(combat, groupId);
    const casualtyCount = this.getCasualtyCount(combat, groupId);
    const mobConfidenceDivisor = groupMeta.mobConfidenceDivisor
      ?? game.settings.get(MODULE_ID, "moraleMobConfidenceDivisor");
    const mobConfidence = this.getMobConfidence(living.length, mobConfidenceDivisor);
    const dc = 10 + casualtyCount;
    const dieExpr = discipline === DISCIPLINE.EXPENDABLE ? "2d20kl"
      : discipline === DISCIPLINE.ELITE ? "2d20kh"
        : "1d20";

    return { groupMeta, groupName, discipline, dc, dieExpr, mobConfidence, mobConfidenceDivisor, casualtyCount, living };
  }

  /**
   * Roll morale for a single combatant and return the result entry.
   * @param {Combatant} combatant
   * @param {number} dc
   * @param {string} dieExpr
   * @param {number} mobConfidence
   * @returns {Promise<Object|null>}
   */
  static async _rollForCombatant(combatant, dc, dieExpr, mobConfidence) {
    const log = logger.fn("_rollForCombatant");
    const actor = combatant.actor;
    if (!actor) return null;

    const wisMod = actor.system?.abilities?.wis?.mod;
    const wisSave = typeof wisMod === "number" ? wisMod : Number(wisMod) || 0;
    const crRaw = actor.system?.details?.cr;
    const cr = Math.floor(typeof crRaw === "number" ? crRaw : Number(crRaw) || 0);
    const totalMod = wisSave + cr + mobConfidence;

    log.trace(`${combatant.name} modifiers`, { wisSave, cr, mobConfidence, totalMod });

    const safeMod = Number.isFinite(totalMod) ? totalMod : 0;
    const formula = safeMod >= 0 ? `${dieExpr} + ${safeMod}` : `${dieExpr} - ${Math.abs(safeMod)}`;
    const roll = new Roll(formula);
    await roll.evaluate();

    return {
      combatant,
      name: combatant.name,
      rollTotal: roll.total,
      rawRoll: roll.dice[0]?.total ?? roll.total - totalMod,
      wisSave,
      cr,
      mobConfidence,
      totalMod,
      passed: roll.total >= dc,
    };
  }

  /**
   * Roll morale for a group. Main entry point.
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {Promise<Object|null>}
   */
  static async rollMorale(combat, groupId) {
    const log = logger.fn("rollMorale");

    if (!isGM()) {
      log.warn("Non-GM attempted morale roll");
      return null;
    }

    if (!combat?.getFlag(MODULE_ID, `groups.${groupId}`)) {
      log.warn("Morale group not found", { groupId });
      return null;
    }
    const params = this._prepareGroupParams(combat, groupId);

    // Fearless groups are immune
    if (params.discipline === DISCIPLINE.FEARLESS) {
      log.debug(`Group "${params.groupName}" is Fearless - morale check skipped`);
      await this._sendFearlessChat(combat, groupId);
      if (params.living.length) {
        await combat.updateEmbeddedDocuments("Combatant", params.living.map((combatant) => ({
          _id: combatant.id,
          [`flags.${MODULE_ID}.moraleStatus`]: "passed",
        })));
      }
      await this.markGroupPrompted(combat, groupId);
      return { skipped: true, reason: "Fearless" };
    }

    if (!params.living.length) {
      ui.notifications.info(game.i18n.format("SCI.Notifications.NoLivingMembers", { name: params.groupName }));
      return null;
    }

    log.groupStart(`Morale Check for "${params.groupName}"`, {
      discipline: params.discipline,
      dc: params.dc,
      casualties: params.casualtyCount,
      living: params.living.length,
      mobConfidence: params.mobConfidence,
    });

    const results = {
      passed: [],
      failed: [],
      dc: params.dc,
      casualtyPenalty: params.casualtyCount,
      mobConfidence: params.mobConfidence,
      mobConfidenceDivisor: params.mobConfidenceDivisor,
      discipline: params.discipline,
      dieExpr: params.dieExpr,
    };

    const entries = [];
    for (const combatant of params.living) {
      const entry = await this._rollForCombatant(combatant, params.dc, params.dieExpr, params.mobConfidence);
      if (!entry) continue;
      entries.push(entry);
      (entry.passed ? results.passed : results.failed).push(entry);
    }

    if (entries.length) {
      await combat.updateEmbeddedDocuments("Combatant", entries.map((entry) => ({
        _id: entry.combatant.id,
        [`flags.${MODULE_ID}.moraleStatus`]: entry.passed ? "passed" : "failed",
      })));
    }
    for (const entry of entries) {
      await this.clearMoraleEffect(entry.combatant);
      if (!entry.passed) await this.applyMoraleEffect(entry.combatant);
      log.trace(`${entry.combatant.name}: rolled ${entry.rollTotal} vs DC ${params.dc} → ${entry.passed ? "PASS" : "FAIL"}`);
    }

    await this.sendMoraleChat(combat, groupId, results);

    // Mark as prompted so auto-prompt doesn't fire again
    await this.markGroupPrompted(combat, groupId);

    log.groupEnd(`${results.passed.length} passed, ${results.failed.length} failed`);
    return results;
  }

  /**
   * Roll morale for a single combatant within a group.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {string} combatantId
   * @returns {Promise<Object|null>}
   */
  static async rollMoraleSingle(combat, groupId, combatantId) {
    const log = logger.fn("rollMoraleSingle");

    if (!isGM()) {
      log.warn("Non-GM attempted single morale roll");
      return null;
    }

    const combatant = combat.combatants.get(combatantId);
    if (!combatant || combatant.getFlag(MODULE_ID, "groupId") !== groupId) {
      log.warn("Combatant is not a member of the requested morale group", { combatantId, groupId });
      return null;
    }
    if (!this.getLivingMembers(combat, groupId).some((member) => member.id === combatantId)) {
      log.warn("Cannot roll morale for a dead or defeated combatant", { combatantId, groupId });
      return null;
    }

    const params = this._prepareGroupParams(combat, groupId);

    // Fearless groups are immune
    if (params.discipline === DISCIPLINE.FEARLESS) {
      log.debug(`Group "${params.groupName}" is Fearless - morale check skipped`);
      await this._sendFearlessChat(combat, groupId);
      await combatant.setFlag(MODULE_ID, "moraleStatus", "passed");
      await this.markGroupPrompted(combat, groupId);
      return { skipped: true, reason: "Fearless" };
    }

    const entry = await this._rollForCombatant(combatant, params.dc, params.dieExpr, params.mobConfidence);
    if (!entry) return null;

    // Only replace an existing effect after a successful roll evaluation.
    await this.clearMoraleEffect(combatant);

    if (entry.passed) {
      await combatant.setFlag(MODULE_ID, "moraleStatus", "passed");
    } else {
      await combatant.setFlag(MODULE_ID, "moraleStatus", "failed");
      await this.applyMoraleEffect(combatant);
    }

    log.debug(`${combatant.name}: rolled ${entry.rollTotal} vs DC ${params.dc} → ${entry.passed ? "PASS" : "FAIL"}`);

    await this.sendMoraleSingleChat(combat, groupId, entry, params);
    return entry;
  }

  /**
   * Reroll morale for broken members of a group. Passing members rally and
   * have morale effects removed; failing members remain broken.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {string|null} [combatantId=null] - If provided, only rally this combatant
   * @returns {Promise<Object|null>}
   */
  static async rallyMorale(combat, groupId, combatantId = null) {
    const log = logger.fn("rallyMorale");

    if (!isGM()) {
      log.warn("Non-GM attempted rally roll");
      return null;
    }

    const params = this._prepareGroupParams(combat, groupId);
    const livingIds = new Set(params.living.map((c) => c.id));
    const targets = combatantId
      ? [combat.combatants.get(combatantId)].filter(Boolean)
      : params.living;
    const broken = targets.filter((c) =>
      c.getFlag(MODULE_ID, "groupId") === groupId
      && livingIds.has(c.id)
      && c.getFlag(MODULE_ID, "moraleStatus") === "failed"
    );

    if (!broken.length) {
      ui.notifications.info(game.i18n.format("SCI.Notifications.NoBrokenMembers", { name: params.groupName }));
      return null;
    }

    if (params.discipline === DISCIPLINE.FEARLESS) {
      for (const combatant of broken) {
        await combatant.setFlag(MODULE_ID, "moraleStatus", "passed");
        await this.clearMoraleEffect(combatant);
      }
      await this.sendRallyChat(combat, groupId, {
        passed: broken.map((combatant) => ({ combatant, name: combatant.name, automatic: true })),
        failed: [],
        dc: params.dc,
        casualtyPenalty: params.casualtyCount,
        mobConfidence: params.mobConfidence,
        mobConfidenceDivisor: params.mobConfidenceDivisor,
        discipline: params.discipline,
        dieExpr: params.dieExpr,
      });
      return { skipped: true, reason: "Fearless", rallied: broken.length };
    }

    log.groupStart(`Rally Check for "${params.groupName}"`, {
      discipline: params.discipline,
      dc: params.dc,
      targets: broken.length,
      mobConfidence: params.mobConfidence,
    });

    const results = {
      passed: [],
      failed: [],
      dc: params.dc,
      casualtyPenalty: params.casualtyCount,
      mobConfidence: params.mobConfidence,
      mobConfidenceDivisor: params.mobConfidenceDivisor,
      discipline: params.discipline,
      dieExpr: params.dieExpr,
    };

    const entries = [];
    for (const combatant of broken) {
      const entry = await this._rollForCombatant(combatant, params.dc, params.dieExpr, params.mobConfidence);
      if (!entry) continue;
      entries.push(entry);
      (entry.passed ? results.passed : results.failed).push(entry);
    }

    if (entries.length) {
      await combat.updateEmbeddedDocuments("Combatant", entries.map((entry) => ({
        _id: entry.combatant.id,
        [`flags.${MODULE_ID}.moraleStatus`]: entry.passed ? "passed" : "failed",
      })));
    }
    for (const entry of entries) {
      await this.clearMoraleEffect(entry.combatant);
      if (!entry.passed) await this.applyMoraleEffect(entry.combatant);
      log.trace(`${entry.combatant.name}: rally rolled ${entry.rollTotal} vs DC ${params.dc} -> ${entry.passed ? "PASS" : "FAIL"}`);
    }

    await this.sendRallyChat(combat, groupId, results);
    log.groupEnd(`${results.passed.length} rallied, ${results.failed.length} still broken`);
    return results;
  }

  /**
   * Check and auto-roll morale for a combatant at the start of their turn.
   * Fires when either condition is met (based on the group's morale trigger setting):
   * - Casualty threshold: living members have dropped to the configured % of starting size
   * - Captain death: the group's captain is dead/defeated
   * @param {Combat} combat
   * @param {Combatant} combatant
   */
  static async checkAutoMorale(combat, combatant) {
    if (!isGM()) return;
    const log = logger.fn("checkAutoMorale");

    // Skip dead/defeated combatants
    const hp = getCombatantHp(combatant);
    if (isCombatantDefeated(combatant) || (hp != null && hp <= 0)) {
      log.trace(`Skipping auto-morale for "${combatant.name}" — dead or defeated`);
      return;
    }

    const groupId = combatant.getFlag(MODULE_ID, "groupId");
    if (!groupId || groupId === "ungrouped") {
      log.trace(`Skipping auto-morale for "${combatant.name}" — not in a group`);
      return;
    }

    // Already has a morale status — skip
    const existingStatus = combatant.getFlag(MODULE_ID, "moraleStatus");
    if (existingStatus) {
      log.trace(`Skipping auto-morale for "${combatant.name}" — already has status: ${existingStatus}`);
      return;
    }

    const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const trigger = meta.moraleTrigger ?? MORALE_TRIGGER.BOTH;

    log.debug(`Checking auto-morale for "${combatant.name}" in group "${meta.name}"`, {
      trigger,
      captainId: meta.captainId,
      startingSize: meta.startingSize,
    });

    if (trigger === MORALE_TRIGGER.MANUAL) {
      log.trace(`Skipping — trigger is MANUAL`);
      return;
    }

    let shouldRoll = false;

    // Check 1: Casualty threshold
    const thresholdEnabled = trigger === MORALE_TRIGGER.THRESHOLD || trigger === MORALE_TRIGGER.BOTH;
    if (thresholdEnabled) {
      const threshold = game.settings.get(MODULE_ID, "moraleAutoPromptThreshold");
      const startingSize = meta.startingSize;
      if (threshold > 0 && startingSize > 0) {
        const living = this.getLivingMembers(combat, groupId);
        const thresholdCount = Math.floor(startingSize * (threshold / 100));
        const thresholdMet = living.length <= thresholdCount;
        log.debug(`Threshold check: living=${living.length}, threshold=${thresholdCount} (${threshold}% of ${startingSize}), met=${thresholdMet}`);
        if (thresholdMet) shouldRoll = true;
      } else {
        log.trace(`Threshold check skipped — threshold=${threshold}, startingSize=${startingSize}`);
      }
    }

    // Check 2: Captain death
    const captainDeathEnabled = trigger === MORALE_TRIGGER.CAPTAIN_DEATH || trigger === MORALE_TRIGGER.BOTH;
    if (captainDeathEnabled && !shouldRoll) {
      const captainId = meta.captainId;
      if (captainId) {
        const captain = combat.combatants.get(captainId);
        if (captain) {
          const captainHp = getCombatantHp(captain);
          const captainDead = isCombatantDefeated(captain) || (captainHp != null && captainHp <= 0);
          log.debug(`Captain death check: captain="${captain.name}", hp=${captainHp}, defeated=${isCombatantDefeated(captain)}, dead=${captainDead}`);
          if (captainDead) {
            await this._clearFallenCaptain(combat, groupId);
            shouldRoll = true;
          }
        } else {
          // Captain combatant no longer exists (deleted) — treat as dead
          log.debug(`Captain death check: captain combatant "${captainId}" not found (deleted) — treating as dead`);
          await this._clearFallenCaptain(combat, groupId);
          shouldRoll = true;
        }
      } else {
        log.trace(`Captain death check skipped — no captain assigned`);
      }
    }

    if (!shouldRoll) {
      log.trace(`No morale trigger conditions met for "${combatant.name}"`);
      return;
    }

    log.debug(`Auto-morale triggered for "${combatant.name}" in group "${meta.name}"`);
    await this.rollMoraleSingle(combat, groupId, combatant.id);
  }

  /**
   * Apply the configured morale failure status effect to a combatant's token.
   * @param {Combatant} combatant
   */
  static async applyMoraleEffect(combatant) {
    const log = logger.fn("applyMoraleEffect");
    const statusId = game.settings.get(MODULE_ID, "moraleStatusEffect");
    const duration = game.settings.get(MODULE_ID, "moraleEffectDuration");
    const token = combatant.token;
    if (!token?.actor) return;

    try {
      if (statusId === "none") {
        log.trace(`No morale effect configured for ${combatant.name}`);
        return;
      }

      if (BUILT_IN_MORALE_STATUS_EFFECTS.has(statusId)) {
        await this._createMoraleStatusEffect(token.actor, statusId, duration);
      } else if (statusId === "fleeing") {
        await this._createCustomMoraleEffect(token.actor, duration);
      } else {
        log.warn(`Unknown morale status effect "${statusId}"`);
        return;
      }
      log.trace(`Applied ${statusId} effect to ${combatant.name}`);
    } catch (err) {
      log.error(`Failed to apply morale effect to ${combatant.name}`, err);
    }
  }

  static async _createMoraleStatusEffect(actor, statusId, duration) {
    const existing = actor.effects.find((effect) =>
      effect.getFlag(MODULE_ID, MORALE_EFFECT_FLAG)
      && effect.getFlag(MODULE_ID, MORALE_EFFECT_STATUS_FLAG) === statusId
    );
    if (existing) {
      if (duration > 0) await existing.update({ "duration.rounds": duration });
      return;
    }

    let effectData = null;
    const ActiveEffectCls = globalThis.getDocumentClass?.("ActiveEffect") ?? CONFIG.ActiveEffect?.documentClass;
    if (ActiveEffectCls?.fromStatusEffect) {
      const statusEffect = await ActiveEffectCls.fromStatusEffect(statusId);
      effectData = statusEffect?.toObject?.() ?? statusEffect;
    }

    if (!effectData) {
      const status = CONFIG.statusEffects?.find((candidate) => candidate.id === statusId) ?? {};
      effectData = {
        name: status.name ? game.i18n.localize(status.name) : statusId,
        icon: status.img ?? status.icon ?? "icons/svg/aura.svg",
        statuses: [statusId],
        changes: [],
      };
    }

    delete effectData._id;
    effectData.flags = {
      ...(effectData.flags ?? {}),
      [MODULE_ID]: {
        ...(effectData.flags?.[MODULE_ID] ?? {}),
        [MORALE_EFFECT_FLAG]: true,
        [MORALE_EFFECT_STATUS_FLAG]: statusId,
      },
    };
    if (duration > 0) {
      effectData.duration = {
        ...(effectData.duration ?? {}),
        rounds: duration,
      };
    }

    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  }

  static async _createCustomMoraleEffect(actor, duration) {
    const existing = actor.effects.find((effect) =>
      effect.getFlag(MODULE_ID, MORALE_EFFECT_FLAG)
      && effect.getFlag(MODULE_ID, MORALE_EFFECT_STATUS_FLAG) === "fleeing"
    );
    if (existing) {
      if (duration > 0) await existing.update({ "duration.rounds": duration });
      return;
    }

    const effectData = {
      name: game.i18n.localize("SCI.Effect.Fleeing"),
      icon: "icons/svg/terror.svg",
      statuses: ["fleeing"],
      description: game.i18n.localize("SCI.Effect.FleeingDescription"),
      flags: {
        [MODULE_ID]: {
          [MORALE_EFFECT_FLAG]: true,
          [MORALE_EFFECT_STATUS_FLAG]: "fleeing",
        },
      },
    };
    if (duration > 0) {
      effectData.duration = { rounds: duration };
    }
    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  }

  /**
   * Remove morale status effects from a combatant's token.
   * @param {Combatant} combatant
   */
  static async clearMoraleEffect(combatant) {
    const log = logger.fn("clearMoraleEffect");
    const token = combatant.token;
    if (!token?.actor) return;

    try {
      const moraleEffects = token.actor.effects.filter((effect) =>
        effect.getFlag(MODULE_ID, MORALE_EFFECT_FLAG)
      );
      if (moraleEffects.length) {
        await token.actor.deleteEmbeddedDocuments("ActiveEffect", moraleEffects.map((effect) => effect.id));
      }

      log.trace(`Cleared morale effects from ${combatant.name}`);
    } catch (err) {
      log.error(`Failed to clear morale effect from ${combatant.name}`, err);
    }
  }

  /**
   * Clear morale flags and effects for a group or a single combatant.
   * Resets the prompted/captain-death gates so auto-triggers can fire again.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {string|null} [combatantId=null] - If provided, only clear this combatant
   */
  static async clearMorale(combat, groupId, combatantId = null) {
    if (!isGM()) return;
    const log = logger.fn("clearMorale");

    const requested = combatantId ? combat.combatants.get(combatantId) : null;
    if (combatantId && requested?.getFlag(MODULE_ID, "groupId") !== groupId) {
      log.warn("Refusing to clear morale for a combatant outside the requested group", { combatantId, groupId });
      return;
    }
    const targets = combatantId
      ? [requested].filter(Boolean)
      : combat.combatants.filter((c) => c.getFlag(MODULE_ID, "groupId") === groupId);

    for (const c of targets) {
      const status = c.getFlag(MODULE_ID, "moraleStatus");
      if (status) await c.unsetFlag(MODULE_ID, "moraleStatus");
      await this.clearMoraleEffect(c);
    }

    // Reset the prompted gates so auto-checks can fire again
    if (!combatantId) await this.resetPromptForGroup(combat, groupId);

    const label = combatantId ? "combatant" : "group";
    log.debug(`Cleared morale for ${label} in group "${groupId}"`);
  }

  /**
   * Record starting size for all groups when combat starts.
   * @param {Combat} combat
   */
  static async recordStartingSizes(combat) {
    if (!isGM()) return;
    const log = logger.fn("recordStartingSizes");

    const groups = combat.getFlag(MODULE_ID, "groups") ?? {};

    for (const [groupId, groupData] of Object.entries(groups)) {
      if (groupData.startingSize != null) continue;

      const members = combat.combatants.filter(
        (c) => c.getFlag(MODULE_ID, "groupId") === groupId
      );
      await combat.setFlag(MODULE_ID, `groups.${groupId}.startingSize`, members.length);
      log.trace(`Recorded starting size for "${groupData.name}": ${members.length}`);
    }
  }

  /**
   * Send auto-prompt whisper to GM with a clickable [Roll Morale] button.
   * @param {Combat} combat
   * @param {string} groupId
   */
  static async sendAutoPrompt(combat, groupId) {
    const log = logger.fn("sendAutoPrompt");

    if (this.isGroupPrompted(combat, groupId)) return;

    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const { groupName, groupColor, groupImg } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const living = this.getLivingMembers(combat, groupId);

    const content = await renderModuleTemplate(TEMPLATES.CHAT_MORALE_PROMPT, {
      groupColor,
      groupImg,
      groupName,
      bodyHtml: game.i18n.format("SCI.Chat.SufferedCasualties", { name: boldName(groupName) }),
      livingCount: living.length,
      startingSize: groupMeta.startingSize ?? "?",
      combatId: combat.id,
      groupId,
    });

    await ChatMessage.create({ content, whisper: gmIds, blind: true });
    await this.markGroupPrompted(combat, groupId);
    log.debug(`Auto-prompt sent for "${groupName}"`);
  }

  /**
   * Send formatted GM-only morale check results to chat.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} results
   */
  static async sendMoraleChat(combat, groupId, results) {
    const log = logger.fn("sendMoraleChat");
    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const { groupName, groupColor, groupImg } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const buildRow = (entry, passed) => ({
      img: getCombatantImage(entry.combatant),
      name: entry.name,
      roll: entry.rollTotal,
      modifiers: formatMoraleModifiers(entry),
      passed,
      resultLabel: game.i18n.localize(passed ? "SCI.Chat.Holds" : "SCI.Chat.Breaks"),
    });

    const content = await renderModuleTemplate(TEMPLATES.CHAT_MORALE_CHECK, {
      groupColor,
      groupImg,
      title: game.i18n.format("SCI.Chat.MoraleCheckTitle", { name: groupName }),
      dc: results.dc,
      dcBreakdown: formatDcBreakdown(results.casualtyPenalty),
      disciplineLabel: localizeEnumValue("SCI.Discipline", results.discipline),
      dieExpr: results.dieExpr,
      mobConfidence: results.mobConfidence,
      casualties: results.casualtyPenalty,
      passedCount: results.passed.length,
      failedCount: results.failed.length,
      rows: [
        ...results.passed.map((e) => buildRow(e, true)),
        ...results.failed.map((e) => buildRow(e, false)),
      ],
    });

    try {
      await ChatMessage.create({ content, whisper: gmIds, blind: true });
    } catch (err) {
      log.warn("Failed to create morale chat summary", { error: err.message });
    }
  }

  /**
   * Send a condensed GM-only chat card for a single-combatant morale result.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} entry - The roll result entry from _rollForCombatant
   * @param {Object} params - Group params from _prepareGroupParams
   */
  static async sendMoraleSingleChat(combat, groupId, entry, params) {
    const log = logger.fn("sendMoraleSingleChat");
    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const { groupName, groupColor } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const content = await renderModuleTemplate(TEMPLATES.CHAT_MORALE_SINGLE, {
      groupColor,
      groupName,
      img: getCombatantImage(entry.combatant),
      title: game.i18n.format("SCI.Chat.MoraleCheckTitle", { name: entry.name }),
      dc: params.dc,
      dcBreakdown: formatDcBreakdown(params.casualtyCount),
      modifiers: formatMoraleModifiers(entry),
      rollTotal: entry.rollTotal,
      passed: entry.passed,
      resultLabel: game.i18n.localize(entry.passed ? "SCI.Chat.Holds" : "SCI.Chat.Breaks"),
    });

    try {
      await ChatMessage.create({ content, whisper: gmIds, blind: true });
    } catch (err) {
      log.warn("Failed to create single morale chat", { error: err.message });
    }
  }

  /**
   * Send formatted GM-only rally results to chat.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {Object} results
   */
  static async sendRallyChat(combat, groupId, results) {
    const log = logger.fn("sendRallyChat");
    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const { groupName, groupColor, groupImg } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const buildRow = (entry, passed) => ({
      img: getCombatantImage(entry.combatant),
      name: entry.name,
      roll: entry.automatic ? game.i18n.localize("SCI.Chat.Auto") : entry.rollTotal,
      modifiers: entry.automatic
        ? game.i18n.localize("SCI.Chat.Fearless")
        : formatMoraleModifiers(entry),
      passed,
      resultLabel: game.i18n.localize(passed ? "SCI.Chat.Rallies" : "SCI.Chat.StillBroken"),
    });

    const content = await renderModuleTemplate(TEMPLATES.CHAT_RALLY, {
      groupColor,
      groupImg,
      title: game.i18n.format("SCI.Chat.RallyTitle", { name: groupName }),
      dc: results.dc,
      dcBreakdown: formatDcBreakdown(results.casualtyPenalty),
      dieExpr: results.dieExpr,
      mobConfidence: results.mobConfidence,
      casualties: results.casualtyPenalty,
      passedCount: results.passed.length,
      failedCount: results.failed.length,
      rows: [
        ...results.passed.map((e) => buildRow(e, true)),
        ...results.failed.map((e) => buildRow(e, false)),
      ],
    });

    try {
      await ChatMessage.create({ content, whisper: gmIds, blind: true });
    } catch (err) {
      log.warn("Failed to create rally chat summary", { error: err.message });
    }
  }

  /**
   * Send a simple chat message when a Fearless group is checked.
   * @param {Combat} combat
   * @param {string} groupId
   */
  static async _sendFearlessChat(combat, groupId) {
    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const { groupName, groupColor } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const content = await renderModuleTemplate(TEMPLATES.CHAT_FEARLESS, {
      groupColor,
      bodyHtml: game.i18n.format("SCI.Chat.FearlessSkipped", { name: boldName(groupName) }),
    });

    await ChatMessage.create({ content, whisper: gmIds, blind: true });
  }

  /**
   * Clear prompted groups tracking. Call on combat deletion.
   */
  static clearPromptedGroups(combat = null) {
    if (!combat?.id) {
      _promptedGroups.clear();
      _captainDeathPrompted.clear();
      return;
    }
    const prefix = `${combat.id}:`;
    for (const key of _promptedGroups) if (key.startsWith(prefix)) _promptedGroups.delete(key);
    for (const key of _captainDeathPrompted) if (key.startsWith(prefix)) _captainDeathPrompted.delete(key);
  }

  static isGroupPrompted(combat, groupId) {
    return _promptedGroups.has(moraleGateKey(combat, groupId))
      || combat?.getFlag(MODULE_ID, `groups.${groupId}.moralePrompted`) === true;
  }

  static async markGroupPrompted(combat, groupId) {
    _promptedGroups.add(moraleGateKey(combat, groupId));
    await combat.setFlag(MODULE_ID, `groups.${groupId}.moralePrompted`, true);
  }

  /**
   * Reset the prompted state for a specific group (e.g., after a morale roll).
   * @param {string} groupId
   */
  static async resetPromptForGroup(combat, groupId) {
    _promptedGroups.delete(moraleGateKey(combat, groupId));
    _captainDeathPrompted.delete(moraleGateKey(combat, groupId));
    if (combat?.getFlag(MODULE_ID, `groups.${groupId}`)) {
      await combat.update({
        [`flags.${MODULE_ID}.groups.${groupId}.moralePrompted`]: false,
        [`flags.${MODULE_ID}.groups.${groupId}.captainDeathTriggered`]: false,
      });
    }
  }

  /**
   * Check if a captain death morale check has already been triggered for a group.
   * @param {string} groupId
   * @returns {boolean}
   */
  static hasCaptainDeathTriggered(combat, groupId) {
    return _captainDeathPrompted.has(moraleGateKey(combat, groupId))
      || combat?.getFlag(MODULE_ID, `groups.${groupId}.captainDeathTriggered`) === true;
  }

  /**
   * Mark a group as having triggered captain death morale.
   * Also marks as prompted to prevent double-firing with threshold morale.
   * @param {string} groupId
   */
  static async markCaptainDeathTriggered(combat, groupId) {
    _captainDeathPrompted.add(moraleGateKey(combat, groupId));
    _promptedGroups.add(moraleGateKey(combat, groupId));
    await combat.update({
      [`flags.${MODULE_ID}.groups.${groupId}.captainDeathTriggered`]: true,
      [`flags.${MODULE_ID}.groups.${groupId}.moralePrompted`]: true,
    });
  }

  /**
   * Send a captain death morale prompt to chat, then auto-roll morale.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {string} captainName - Name of the fallen captain
   */
  static async handleCaptainDeath(combat, groupId, captainName) {
    const log = logger.fn("handleCaptainDeath");

    if (this.hasCaptainDeathTriggered(combat, groupId)) return;

    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const { groupName, groupColor, groupImg } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const content = await renderModuleTemplate(TEMPLATES.CHAT_CAPTAIN_DEATH, {
      groupColor,
      groupImg,
      groupName,
      bodyHtml: game.i18n.format("SCI.Chat.CaptainFallenBody", {
        captain: boldName(captainName),
        group: boldName(groupName),
      }),
    });

    await ChatMessage.create({ content, whisper: gmIds, blind: true });
    await this.markCaptainDeathTriggered(combat, groupId);
    log.debug(`Captain death morale triggered for "${groupName}" (captain: ${captainName})`);

    await this._clearFallenCaptain(combat, groupId);

    // Auto-roll morale
    await this.rollMorale(combat, groupId);
  }

  static async _clearFallenCaptain(combat, groupId) {
    const log = logger.fn("_clearFallenCaptain");
    try {
      const { GroupManager } = await import("./group-manager.js");
      await GroupManager.removeCaptain(combat, groupId);
    } catch (err) {
      log.error("Failed to clear fallen captain", err);
    }
  }
}
