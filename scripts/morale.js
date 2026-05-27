/**
 * @file morale.js
 * @description Squad Morale System - rolling, tracking, status effect application, and chat output.
 * @version V13 Only
 */

import {
  MODULE_ID,
  logger,
  isGM,
  MORALE_TRIGGER,
  escapeHtml,
  escapeAttribute,
  sanitizeColor,
  sanitizeImagePath,
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

const BUILT_IN_MORALE_STATUS_EFFECTS = new Set(["frightened", "prone"]);
const CUSTOM_MORALE_EFFECT_NAME = "Fleeing";
const MORALE_EFFECT_FLAG = "moraleEffect";
const MORALE_EFFECT_STATUS_FLAG = "moraleEffectStatus";

function getChatGroupFields(groupMeta) {
  const groupName = groupMeta.name ?? "Unnamed Group";
  return {
    groupName,
    safeGroupName: escapeHtml(groupName),
    safeGroupColor: sanitizeColor(groupMeta.color, "#7b68ee"),
    safeGroupImg: escapeAttribute(sanitizeImagePath(groupMeta.img, "icons/svg/combat.svg")),
  };
}

function getSafeCombatantImage(combatant) {
  return escapeAttribute(sanitizeImagePath(combatant?.img || combatant?.token?.texture?.src || "", ""));
}

function renderChatImage(src, size = 24) {
  return src
    ? `<img src="${src}" width="${size}" height="${size}" style="border: none; vertical-align: middle; margin-right: 4px; border-radius: 50%;">`
    : "";
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

    if (_promptedGroups.has(groupId)) return false;

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
    const groupName = groupMeta.name ?? "Unnamed Group";
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

    const params = this._prepareGroupParams(combat, groupId);

    // Fearless groups are immune
    if (params.discipline === DISCIPLINE.FEARLESS) {
      log.debug(`Group "${params.groupName}" is Fearless - morale check skipped`);
      await this._sendFearlessChat(combat, groupId);
      return { skipped: true, reason: "Fearless" };
    }

    if (!params.living.length) {
      ui.notifications.info(`Group "${params.groupName}" has no living members.`);
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

    for (const combatant of params.living) {
      const entry = await this._rollForCombatant(combatant, params.dc, params.dieExpr, params.mobConfidence);
      if (!entry) continue;

      await this.clearMoraleEffect(combatant);
      if (entry.passed) {
        results.passed.push(entry);
        await combatant.setFlag(MODULE_ID, "moraleStatus", "passed");
      } else {
        results.failed.push(entry);
        await combatant.setFlag(MODULE_ID, "moraleStatus", "failed");
        await this.applyMoraleEffect(combatant);
      }

      log.trace(`${combatant.name}: rolled ${entry.rollTotal} vs DC ${params.dc} → ${entry.passed ? "PASS" : "FAIL"}`);
    }

    await this.sendMoraleChat(combat, groupId, results);

    // Mark as prompted so auto-prompt doesn't fire again
    _promptedGroups.add(groupId);

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
    if (!combatant) {
      log.warn("Combatant not found", { combatantId });
      return null;
    }

    const params = this._prepareGroupParams(combat, groupId);

    // Fearless groups are immune
    if (params.discipline === DISCIPLINE.FEARLESS) {
      log.debug(`Group "${params.groupName}" is Fearless - morale check skipped`);
      await this._sendFearlessChat(combat, groupId);
      return { skipped: true, reason: "Fearless" };
    }

    // Clear any existing morale effect before re-rolling
    await this.clearMoraleEffect(combatant);

    const entry = await this._rollForCombatant(combatant, params.dc, params.dieExpr, params.mobConfidence);
    if (!entry) return null;

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
      ui.notifications.info(`Group "${params.groupName}" has no broken members to rally.`);
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

    for (const combatant of broken) {
      await this.clearMoraleEffect(combatant);
      const entry = await this._rollForCombatant(combatant, params.dc, params.dieExpr, params.mobConfidence);
      if (!entry) continue;

      if (entry.passed) {
        results.passed.push(entry);
        await combatant.setFlag(MODULE_ID, "moraleStatus", "passed");
      } else {
        results.failed.push(entry);
        await combatant.setFlag(MODULE_ID, "moraleStatus", "failed");
        await this.applyMoraleEffect(combatant);
      }

      log.trace(`${combatant.name}: rally rolled ${entry.rollTotal} vs DC ${params.dc} -> ${entry.passed ? "PASS" : "FAIL"}`);
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
      name: CUSTOM_MORALE_EFFECT_NAME,
      icon: "icons/svg/terror.svg",
      statuses: ["fleeing"],
      description: "This creature has broken morale and is fleeing combat.",
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

    const targets = combatantId
      ? [combat.combatants.get(combatantId)].filter(Boolean)
      : combat.combatants.filter((c) => c.getFlag(MODULE_ID, "groupId") === groupId);

    for (const c of targets) {
      const status = c.getFlag(MODULE_ID, "moraleStatus");
      if (status) await c.unsetFlag(MODULE_ID, "moraleStatus");
      await this.clearMoraleEffect(c);
    }

    // Reset the prompted gates so auto-checks can fire again
    this.resetPromptForGroup(groupId);
    _captainDeathPrompted.delete(groupId);

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

    if (_promptedGroups.has(groupId)) return;
    _promptedGroups.add(groupId);

    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const { groupName, safeGroupName, safeGroupColor, safeGroupImg } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const living = this.getLivingMembers(combat, groupId);
    const startingSize = escapeHtml(groupMeta.startingSize ?? "?");

    const content = `
      <div style="border: 2px solid ${safeGroupColor}; border-radius: 8px; overflow: hidden; font-size: 13px;">
        <div style="padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid ${safeGroupColor};">
          <img src="${safeGroupImg}" width="32" height="32" style="border: none; border-radius: 50%;">
          <div style="flex: 1;">
            <strong style="font-size: 15px; display: block;">Morale Warning</strong>
            <span style="font-size: 12px; opacity: 0.7;">${safeGroupName}</span>
          </div>
        </div>
        <div style="padding: 10px;">
          <p style="margin: 0 0 8px;">
            <strong>${safeGroupName}</strong> has suffered heavy casualties!
          </p>
          <p style="margin: 0 0 10px; font-size: 12px; opacity: 0.8;">
            Living: <strong>${living.length}</strong> / Starting: <strong>${startingSize}</strong>
          </p>
          <button type="button" class="sci-morale-roll-btn" data-combat-id="${escapeAttribute(combat.id)}" data-group-id="${escapeAttribute(groupId)}">
            <i class="fa-solid fa-flag"></i> Roll Morale
          </button>
        </div>
      </div>`;

    await ChatMessage.create({ content, whisper: gmIds, blind: true });
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
    const { safeGroupName, safeGroupColor, safeGroupImg } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const disciplineLabel = {
      [DISCIPLINE.EXPENDABLE]: "Expendable (Disadvantage)",
      [DISCIPLINE.STANDARD]: "Standard",
      [DISCIPLINE.ELITE]: "Elite (Advantage)",
      [DISCIPLINE.FEARLESS]: "Fearless (Immune)",
    }[results.discipline] ?? results.discipline;
    const safeDisciplineLabel = escapeHtml(disciplineLabel);
    const safeDieExpr = escapeHtml(results.dieExpr);

    const formatMod = (v) => (v >= 0 ? `+${v}` : `${v}`);

    const buildRow = (entry, passed) => {
      const bgColor = passed ? "rgba(76, 175, 80, 0.08)" : "rgba(244, 67, 54, 0.08)";
      const icon = passed
        ? '<i class="fas fa-shield-alt" style="color: #4caf50;"></i>'
        : '<i class="fas fa-running" style="color: #f44336;"></i>';
      const img = getSafeCombatantImage(entry.combatant);
      const safeName = escapeHtml(entry.name);
      return `<tr style="background: ${bgColor};">
        <td style="padding: 4px 6px;">
          ${renderChatImage(img)}
          ${safeName}
        </td>
        <td style="padding: 4px 6px; text-align: center; font-weight: bold;">${entry.rollTotal}</td>
        <td style="padding: 4px 6px; text-align: center; opacity: 0.8; font-size: 11px;">
          WIS ${formatMod(entry.wisSave)} | CR ${formatMod(entry.cr)} | Mob ${formatMod(entry.mobConfidence)}
        </td>
        <td style="padding: 4px 6px; text-align: center;">${icon} ${passed ? "Holds" : "Breaks"}</td>
      </tr>`;
    };

    const allEntries = [
      ...results.passed.map((e) => buildRow(e, true)),
      ...results.failed.map((e) => buildRow(e, false)),
    ].join("");

    const content = `
      <div style="border: 2px solid ${safeGroupColor}; border-radius: 8px; overflow: hidden; font-size: 13px;">
        <div style="padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid ${safeGroupColor};">
          <img src="${safeGroupImg}" width="32" height="32" style="border: none; border-radius: 50%;">
          <div style="flex: 1;">
            <strong style="font-size: 15px; display: block;">${safeGroupName} - Morale Check</strong>
            <span style="font-size: 12px; opacity: 0.7;">
              DC <strong style="font-size: 14px; opacity: 1;">${results.dc}</strong>
              <span style="margin-left: 4px;">(10 + ${results.casualtyPenalty} casualties)</span>
            </span>
          </div>
        </div>
        <div style="padding: 6px 10px; display: flex; gap: 12px; flex-wrap: wrap; background: rgba(0,0,0,0.03); border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 12px;">
          <span title="Discipline Level"><i class="fas fa-shield-alt" style="opacity: 0.6;"></i> ${safeDisciplineLabel}</span>
          <span title="Roll formula"><i class="fas fa-dice-d20" style="opacity: 0.6;"></i> ${safeDieExpr}</span>
          <span title="Mob Confidence Bonus"><i class="fas fa-users" style="opacity: 0.6;"></i> Mob Confidence: <strong>+${results.mobConfidence}</strong></span>
          <span title="Casualties"><i class="fas fa-skull" style="opacity: 0.6;"></i> Casualties: <strong>${results.casualtyPenalty}</strong></span>
        </div>
        <div style="padding: 6px 10px; display: flex; gap: 16px; border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 13px;">
          <span style="color: #4caf50;"><i class="fas fa-shield-alt"></i> <strong>${results.passed.length}</strong> held</span>
          <span style="color: #f44336;"><i class="fas fa-running"></i> <strong>${results.failed.length}</strong> broke</span>
        </div>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 11px; text-transform: uppercase; opacity: 0.6;">
              <th style="padding: 4px 6px; text-align: left;">Combatant</th>
              <th style="padding: 4px 6px; text-align: center;">Roll</th>
              <th style="padding: 4px 6px; text-align: center;">Modifiers</th>
              <th style="padding: 4px 6px; text-align: center;">Result</th>
            </tr>
          </thead>
          <tbody>${allEntries}</tbody>
        </table>
      </div>`;

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
    const { safeGroupName, safeGroupColor } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const formatMod = (v) => (v >= 0 ? `+${v}` : `${v}`);
    const passed = entry.passed;
    const bgColor = passed ? "rgba(76, 175, 80, 0.08)" : "rgba(244, 67, 54, 0.08)";
    const icon = passed
      ? '<i class="fas fa-shield-alt" style="color: #4caf50;"></i>'
      : '<i class="fas fa-running" style="color: #f44336;"></i>';
    const statusText = passed ? "Holds" : "Breaks";
    const img = getSafeCombatantImage(entry.combatant);
    const safeName = escapeHtml(entry.name);

    const content = `
      <div style="border: 2px solid ${safeGroupColor}; border-radius: 8px; overflow: hidden; font-size: 13px;">
        <div style="padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid ${safeGroupColor};">
          ${renderChatImage(img, 32)}
          <div style="flex: 1;">
            <strong style="font-size: 15px; display: block;">${safeName} - Morale Check</strong>
            <span style="font-size: 12px; opacity: 0.7;">
              ${safeGroupName} | DC <strong style="opacity: 1;">${params.dc}</strong>
              <span style="margin-left: 4px;">(10 + ${params.casualtyCount} casualties)</span>
            </span>
          </div>
        </div>
        <div style="padding: 10px; background: ${bgColor}; display: flex; align-items: center; gap: 12px;">
          <div style="flex: 1;">
            <div style="font-size: 11px; opacity: 0.7; margin-bottom: 2px;">
              WIS ${formatMod(entry.wisSave)} | CR ${formatMod(entry.cr)} | Mob ${formatMod(entry.mobConfidence)}
            </div>
            <div style="font-weight: bold; font-size: 15px;">
              Rolled: ${entry.rollTotal}
            </div>
          </div>
          <div style="font-size: 14px; font-weight: bold;">
            ${icon} ${statusText}
          </div>
        </div>
      </div>`;

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
    const { safeGroupName, safeGroupColor, safeGroupImg } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const formatMod = (v) => (v >= 0 ? `+${v}` : `${v}`);
    const safeDieExpr = escapeHtml(results.dieExpr);

    const buildRow = (entry, passed) => {
      const bgColor = passed ? "rgba(76, 175, 80, 0.08)" : "rgba(244, 67, 54, 0.08)";
      const icon = passed
        ? '<i class="fas fa-hand-fist" style="color: #4caf50;"></i>'
        : '<i class="fas fa-running" style="color: #f44336;"></i>';
      const img = getSafeCombatantImage(entry.combatant);
      const roll = entry.automatic ? "Auto" : entry.rollTotal;
      const mods = entry.automatic
        ? "Fearless"
        : `WIS ${formatMod(entry.wisSave)} | CR ${formatMod(entry.cr)} | Mob ${formatMod(entry.mobConfidence)}`;
      const safeName = escapeHtml(entry.name);

      return `<tr style="background: ${bgColor};">
        <td style="padding: 4px 6px;">
          ${renderChatImage(img)}
          ${safeName}
        </td>
        <td style="padding: 4px 6px; text-align: center; font-weight: bold;">${roll}</td>
        <td style="padding: 4px 6px; text-align: center; opacity: 0.8; font-size: 11px;">${mods}</td>
        <td style="padding: 4px 6px; text-align: center;">${icon} ${passed ? "Rallies" : "Still Broken"}</td>
      </tr>`;
    };

    const allEntries = [
      ...results.passed.map((e) => buildRow(e, true)),
      ...results.failed.map((e) => buildRow(e, false)),
    ].join("");

    const content = `
      <div style="border: 2px solid ${safeGroupColor}; border-radius: 8px; overflow: hidden; font-size: 13px;">
        <div style="padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid ${safeGroupColor};">
          <img src="${safeGroupImg}" width="32" height="32" style="border: none; border-radius: 50%;">
          <div style="flex: 1;">
            <strong style="font-size: 15px; display: block;">${safeGroupName} - Rally</strong>
            <span style="font-size: 12px; opacity: 0.7;">
              DC <strong style="font-size: 14px; opacity: 1;">${results.dc}</strong>
              <span style="margin-left: 4px;">(10 + ${results.casualtyPenalty} casualties)</span>
            </span>
          </div>
        </div>
        <div style="padding: 6px 10px; display: flex; gap: 12px; flex-wrap: wrap; background: rgba(0,0,0,0.03); border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 12px;">
          <span title="Roll formula"><i class="fas fa-dice-d20" style="opacity: 0.6;"></i> ${safeDieExpr}</span>
          <span title="Mob Confidence Bonus"><i class="fas fa-users" style="opacity: 0.6;"></i> Mob Confidence: <strong>+${results.mobConfidence}</strong></span>
          <span title="Casualties"><i class="fas fa-skull" style="opacity: 0.6;"></i> Casualties: <strong>${results.casualtyPenalty}</strong></span>
        </div>
        <div style="padding: 6px 10px; display: flex; gap: 16px; border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 13px;">
          <span style="color: #4caf50;"><i class="fas fa-hand-fist"></i> <strong>${results.passed.length}</strong> rallied</span>
          <span style="color: #f44336;"><i class="fas fa-running"></i> <strong>${results.failed.length}</strong> still broken</span>
        </div>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 11px; text-transform: uppercase; opacity: 0.6;">
              <th style="padding: 4px 6px; text-align: left;">Combatant</th>
              <th style="padding: 4px 6px; text-align: center;">Roll</th>
              <th style="padding: 4px 6px; text-align: center;">Modifiers</th>
              <th style="padding: 4px 6px; text-align: center;">Result</th>
            </tr>
          </thead>
          <tbody>${allEntries}</tbody>
        </table>
      </div>`;

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
    const { safeGroupName, safeGroupColor } = getChatGroupFields(groupMeta);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const content = `
      <div style="border: 2px solid ${safeGroupColor}; border-radius: 8px; padding: 10px; font-size: 13px;">
        <strong>${safeGroupName}</strong> is <strong>Fearless</strong> - morale check skipped.
      </div>`;

    await ChatMessage.create({ content, whisper: gmIds, blind: true });
  }

  /**
   * Clear prompted groups tracking. Call on combat deletion.
   */
  static clearPromptedGroups() {
    _promptedGroups.clear();
    _captainDeathPrompted.clear();
  }

  /**
   * Reset the prompted state for a specific group (e.g., after a morale roll).
   * @param {string} groupId
   */
  static resetPromptForGroup(groupId) {
    _promptedGroups.delete(groupId);
  }

  /**
   * Check if a captain death morale check has already been triggered for a group.
   * @param {string} groupId
   * @returns {boolean}
   */
  static hasCaptainDeathTriggered(groupId) {
    return _captainDeathPrompted.has(groupId);
  }

  /**
   * Mark a group as having triggered captain death morale.
   * Also marks as prompted to prevent double-firing with threshold morale.
   * @param {string} groupId
   */
  static markCaptainDeathTriggered(groupId) {
    _captainDeathPrompted.add(groupId);
    _promptedGroups.add(groupId);
  }

  /**
   * Send a captain death morale prompt to chat, then auto-roll morale.
   * @param {Combat} combat
   * @param {string} groupId
   * @param {string} captainName - Name of the fallen captain
   */
  static async handleCaptainDeath(combat, groupId, captainName) {
    const log = logger.fn("handleCaptainDeath");

    if (this.hasCaptainDeathTriggered(groupId)) return;
    this.markCaptainDeathTriggered(groupId);

    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const { groupName, safeGroupName, safeGroupColor, safeGroupImg } = getChatGroupFields(groupMeta);
    const safeCaptainName = escapeHtml(captainName);
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const content = `
      <div style="border: 2px solid ${safeGroupColor}; border-radius: 8px; overflow: hidden; font-size: 13px;">
        <div style="padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid ${safeGroupColor};">
          <img src="${safeGroupImg}" width="32" height="32" style="border: none; border-radius: 50%;">
          <div style="flex: 1;">
            <strong style="font-size: 15px; display: block;">The Captain Has Fallen!</strong>
            <span style="font-size: 12px; opacity: 0.7;">${safeGroupName}</span>
          </div>
        </div>
        <div style="padding: 10px;">
          <p style="margin: 0 0 8px;">
            <i class="fas fa-crown" style="color: gold;"></i> <strong>${safeCaptainName}</strong> has been incapacitated!
            <strong>${safeGroupName}</strong> must make a morale check.
          </p>
        </div>
      </div>`;

    await ChatMessage.create({ content, whisper: gmIds, blind: true });
    log.debug(`Captain death morale triggered for "${groupName}" (captain: ${captainName})`);

    await this._clearFallenCaptain(combat, groupId);

    // Auto-roll morale
    await this.rollMorale(combat, groupId);
  }

  static async _clearFallenCaptain(combat, groupId) {
    const log = logger.fn("_clearFallenCaptain");
    try {
      const { GroupManager } = await import("./class-objects.js");
      await GroupManager.removeCaptain(combat, groupId);
    } catch (err) {
      log.error("Failed to clear fallen captain", err);
    }
  }
}
