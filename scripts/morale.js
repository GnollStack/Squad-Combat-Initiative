/**
 * @file morale.js
 * @description Squad Morale System - rolling, tracking, status effect application, and chat output.
 * @version V13 Only
 */

import { MODULE_ID, logger, isGM } from "./shared.js";

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
 * Static class managing morale checks for groups.
 */
export class MoraleManager {

  /**
   * Get living members of a group (HP > 0).
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {Combatant[]}
   */
  static getLivingMembers(combat, groupId) {
    return combat.combatants.filter((c) => {
      if (c.getFlag(MODULE_ID, "groupId") !== groupId) return false;
      const hp = c.actor?.system?.attributes?.hp?.value;
      return hp != null && hp > 0;
    });
  }

  /**
   * Get dead members of a group (HP === 0).
   * @param {Combat} combat
   * @param {string} groupId
   * @returns {Combatant[]}
   */
  static getDeadMembers(combat, groupId) {
    return combat.combatants.filter((c) => {
      if (c.getFlag(MODULE_ID, "groupId") !== groupId) return false;
      const hp = c.actor?.system?.attributes?.hp?.value;
      return hp != null && hp <= 0;
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

    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const groupName = groupMeta.name ?? "Unnamed Group";
    const discipline = groupMeta.discipline ?? DISCIPLINE.STANDARD;

    // Fearless groups are immune
    if (discipline === DISCIPLINE.FEARLESS) {
      log.debug(`Group "${groupName}" is Fearless - morale check skipped`);
      await this._sendFearlessChat(combat, groupId);
      return { skipped: true, reason: "Fearless" };
    }

    const living = this.getLivingMembers(combat, groupId);
    if (!living.length) {
      ui.notifications.info(`Group "${groupName}" has no living members.`);
      return null;
    }

    const casualtyCount = this.getCasualtyCount(combat, groupId);
    const mobConfidenceDivisor = groupMeta.mobConfidenceDivisor
      ?? game.settings.get(MODULE_ID, "moraleMobConfidenceDivisor");
    const mobConfidence = this.getMobConfidence(living.length, mobConfidenceDivisor);
    const dc = 10 + casualtyCount;

    // Determine die expression from discipline
    const dieExpr = discipline === DISCIPLINE.EXPENDABLE ? "2d20kl"
      : discipline === DISCIPLINE.ELITE ? "2d20kh"
        : "1d20";

    log.groupStart(`Morale Check for "${groupName}"`, {
      discipline,
      dc,
      casualties: casualtyCount,
      living: living.length,
      mobConfidence,
    });

    const results = {
      passed: [],
      failed: [],
      dc,
      casualtyPenalty: casualtyCount,
      mobConfidence,
      mobConfidenceDivisor,
      discipline,
      dieExpr,
    };

    for (const combatant of living) {
      const actor = combatant.actor;
      if (!actor) continue;

      // In dnd5e v5.x, abilities.wis.mod is the ability modifier (number)
      // abilities.wis.save may be an object in some versions, so prefer .mod
      const wisMod = actor.system?.abilities?.wis?.mod;
      const wisSave = typeof wisMod === "number" ? wisMod : Number(wisMod) || 0;
      const crRaw = actor.system?.details?.cr;
      const cr = Math.floor(typeof crRaw === "number" ? crRaw : Number(crRaw) || 0);
      const totalMod = wisSave + cr + mobConfidence;

      log.trace(`${combatant.name} modifiers`, { wisSave, cr, mobConfidence, totalMod });

      // Ensure totalMod is a valid integer for the roll formula
      const safeMod = Number.isFinite(totalMod) ? totalMod : 0;
      const formula = safeMod >= 0 ? `${dieExpr} + ${safeMod}` : `${dieExpr} - ${Math.abs(safeMod)}`;
      const roll = new Roll(formula);
      await roll.evaluate();

      const entry = {
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

      if (entry.passed) {
        results.passed.push(entry);
      } else {
        results.failed.push(entry);
        await this.applyMoraleEffect(combatant);
      }

      log.trace(`${combatant.name}: rolled ${roll.total} vs DC ${dc} → ${entry.passed ? "PASS" : "FAIL"}`);
    }

    await this.sendMoraleChat(combat, groupId, results);

    // Mark as prompted so auto-prompt doesn't fire again
    _promptedGroups.add(groupId);

    log.groupEnd(`${results.passed.length} passed, ${results.failed.length} failed`);
    return results;
  }

  /**
   * Apply frightened/fleeing status effect to a combatant's token.
   * @param {Combatant} combatant
   */
  static async applyMoraleEffect(combatant) {
    const log = logger.fn("applyMoraleEffect");
    const statusId = game.settings.get(MODULE_ID, "moraleStatusEffect");
    const duration = game.settings.get(MODULE_ID, "moraleEffectDuration");
    const token = combatant.token;
    if (!token?.actor) return;

    try {
      if (statusId === "frightened") {
        await token.actor.toggleStatusEffect("frightened", { active: true });

        // Apply duration if configured
        if (duration > 0) {
          const effect = token.actor.effects.find((e) => e.statuses.has("frightened"));
          if (effect) {
            await effect.update({ "duration.rounds": duration });
          }
        }
      } else {
        // Custom "Fleeing" effect
        const existing = token.actor.effects.find((e) => e.name === "Fleeing");
        if (!existing) {
          const effectData = {
            name: "Fleeing",
            icon: "icons/svg/terror.svg",
            statuses: ["fleeing"],
            description: "This creature has broken morale and is fleeing combat.",
          };
          if (duration > 0) {
            effectData.duration = { rounds: duration };
          }
          await token.actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
        }
      }
      log.trace(`Applied ${statusId} effect to ${combatant.name}`);
    } catch (err) {
      log.error(`Failed to apply morale effect to ${combatant.name}`, err);
    }
  }

  /**
   * Record starting size for all groups when combat starts.
   * @param {Combat} combat
   */
  static async recordStartingSizes(combat) {
    if (!isGM()) return;
    const log = logger.fn("recordStartingSizes");

    const groups = foundry.utils.getProperty(combat, `flags.${MODULE_ID}.groups`) ?? {};

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
    const groupName = groupMeta.name ?? "Unnamed Group";
    const groupColor = groupMeta.color || "#7b68ee";
    const groupImg = groupMeta.img || "icons/svg/combat.svg";
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const living = this.getLivingMembers(combat, groupId);
    const startingSize = groupMeta.startingSize ?? "?";

    const content = `
      <div style="border: 2px solid ${groupColor}; border-radius: 8px; overflow: hidden; font-size: 13px;">
        <div style="padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid ${groupColor};">
          <img src="${groupImg}" width="32" height="32" style="border: none; border-radius: 50%;">
          <div style="flex: 1;">
            <strong style="font-size: 15px; display: block;">Morale Warning</strong>
            <span style="font-size: 12px; opacity: 0.7;">${groupName}</span>
          </div>
        </div>
        <div style="padding: 10px;">
          <p style="margin: 0 0 8px;">
            <strong>${groupName}</strong> has suffered heavy casualties!
          </p>
          <p style="margin: 0 0 10px; font-size: 12px; opacity: 0.8;">
            Living: <strong>${living.length}</strong> / Starting: <strong>${startingSize}</strong>
          </p>
          <button type="button" class="sci-morale-roll-btn" data-combat-id="${combat.id}" data-group-id="${groupId}">
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
    const groupName = groupMeta.name ?? "Unnamed Group";
    const groupColor = groupMeta.color || "#7b68ee";
    const groupImg = groupMeta.img || "icons/svg/combat.svg";
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const disciplineLabel = {
      [DISCIPLINE.EXPENDABLE]: "Expendable (Disadvantage)",
      [DISCIPLINE.STANDARD]: "Standard",
      [DISCIPLINE.ELITE]: "Elite (Advantage)",
      [DISCIPLINE.FEARLESS]: "Fearless (Immune)",
    }[results.discipline] ?? results.discipline;

    const formatMod = (v) => (v >= 0 ? `+${v}` : `${v}`);

    const buildRow = (entry, passed) => {
      const bgColor = passed ? "rgba(76, 175, 80, 0.08)" : "rgba(244, 67, 54, 0.08)";
      const icon = passed
        ? '<i class="fas fa-shield-alt" style="color: #4caf50;"></i>'
        : '<i class="fas fa-running" style="color: #f44336;"></i>';
      const img = entry.combatant.img || entry.combatant.token?.texture?.src || "";
      return `<tr style="background: ${bgColor};">
        <td style="padding: 4px 6px;">
          ${img ? `<img src="${img}" width="24" height="24" style="border: none; vertical-align: middle; margin-right: 4px; border-radius: 50%;">` : ""}
          ${entry.name}
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
      <div style="border: 2px solid ${groupColor}; border-radius: 8px; overflow: hidden; font-size: 13px;">
        <div style="padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid ${groupColor};">
          <img src="${groupImg}" width="32" height="32" style="border: none; border-radius: 50%;">
          <div style="flex: 1;">
            <strong style="font-size: 15px; display: block;">${groupName} - Morale Check</strong>
            <span style="font-size: 12px; opacity: 0.7;">
              DC <strong style="font-size: 14px; opacity: 1;">${results.dc}</strong>
              <span style="margin-left: 4px;">(10 + ${results.casualtyPenalty} casualties)</span>
            </span>
          </div>
        </div>
        <div style="padding: 6px 10px; display: flex; gap: 12px; flex-wrap: wrap; background: rgba(0,0,0,0.03); border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 12px;">
          <span title="Discipline Level"><i class="fas fa-shield-alt" style="opacity: 0.6;"></i> ${disciplineLabel}</span>
          <span title="Roll formula"><i class="fas fa-dice-d20" style="opacity: 0.6;"></i> ${results.dieExpr}</span>
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
   * Send a simple chat message when a Fearless group is checked.
   * @param {Combat} combat
   * @param {string} groupId
   */
  static async _sendFearlessChat(combat, groupId) {
    const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
    const groupName = groupMeta.name ?? "Unnamed Group";
    const groupColor = groupMeta.color || "#7b68ee";
    const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

    const content = `
      <div style="border: 2px solid ${groupColor}; border-radius: 8px; padding: 10px; font-size: 13px;">
        <strong>${groupName}</strong> is <strong>Fearless</strong> — morale check skipped.
      </div>`;

    await ChatMessage.create({ content, whisper: gmIds, blind: true });
  }

  /**
   * Clear prompted groups tracking. Call on combat deletion.
   */
  static clearPromptedGroups() {
    _promptedGroups.clear();
  }

  /**
   * Reset the prompted state for a specific group (e.g., after a morale roll).
   * @param {string} groupId
   */
  static resetPromptForGroup(groupId) {
    _promptedGroups.delete(groupId);
  }
}
