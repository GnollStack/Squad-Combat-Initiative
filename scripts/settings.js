/**
 * @file settings.js
 * @description Registers module settings with Foundry's configuration system.
 * @version V13 Only
 */

import { MODULE_ID, logger } from "./shared.js";

/**
 * Debug verbosity levels.
 * @readonly
 * @enum {string}
 */
export const DEBUG_LEVELS = Object.freeze({
  OFF: "off",
  NORMAL: "normal",
  VERBOSE: "verbose",
});

/**
 * Token highlight visibility options.
 * @readonly
 * @enum {string}
 */
export const HIGHLIGHT_VISIBILITY = Object.freeze({
  OFF: "off",
  GM_ONLY: "gm",
  EVERYONE: "everyone",
});

/**
 * Visibility sync mode options.
 * Controls how hiding/showing tokens is synchronized between the combat tracker and the canvas.
 * @readonly
 * @enum {string}
 */
export const VISIBILITY_SYNC_MODE = Object.freeze({
  BIDIRECTIONAL: "bidirectional",
  TRACKER_ONLY: "trackerOnly",
  NONE: "none",
});

/**
 * Registers all module settings.
 * Should be called on the "init" hook.
 */
export function registerSettings() {
  game.settings.register(MODULE_ID, "autoCollapseGroups", {
    name: "Auto Collapse Groups",
    hint: "When enabled, the active combatant's group will automatically expand on their turn, while others collapse (unless pinned).",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "defaultGroupPinned", {
    name: "Pin New Groups by Default",
    hint: "When enabled, newly created groups will be pinned (stay expanded during auto-collapse). You can still toggle pinning per group.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "visibilitySyncMode", {
    name: "Visibility Sync Mode",
    hint: "Bidirectional: hiding/showing a token on the canvas or combat tracker syncs both. Tracker Only: only the group toggle controls visibility (canvas tokens unaffected). None: systems are fully independent (legacy behavior).",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [VISIBILITY_SYNC_MODE.BIDIRECTIONAL]: "Bidirectional (Recommended)",
      [VISIBILITY_SYNC_MODE.TRACKER_ONLY]: "Tracker Only",
      [VISIBILITY_SYNC_MODE.NONE]: "None (Legacy)",
    },
    default: VISIBILITY_SYNC_MODE.BIDIRECTIONAL,
  });

  game.settings.register(MODULE_ID, "groupTokenHighlight", {
    name: "Group Token Highlight on Hover",
    hint: "When hovering over a group header, highlight all tokens belonging to that group on the canvas.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [HIGHLIGHT_VISIBILITY.OFF]: "Off",
      [HIGHLIGHT_VISIBILITY.GM_ONLY]: "GM Only",
      [HIGHLIGHT_VISIBILITY.EVERYONE]: "Everyone",
    },
    default: HIGHLIGHT_VISIBILITY.GM_ONLY,
  });

  game.settings.register(MODULE_ID, "debugLevel", {
    name: "Debug Logging Level",
    hint: "Off = No debug logs. Normal = Key operations only. Verbose = All details including render cycles and individual rolls.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [DEBUG_LEVELS.OFF]: "Off",
      [DEBUG_LEVELS.NORMAL]: "Normal",
      [DEBUG_LEVELS.VERBOSE]: "Verbose",
    },
    default: DEBUG_LEVELS.OFF,
    onChange: (value) => {
      logger.info(`Debug level changed to: ${value}`);
    },
  });

  // --- Morale System Settings ---

  game.settings.register(MODULE_ID, "moraleEnabled", {
    name: "Enable Morale System",
    hint: "Enables the squad morale system. When disabled, morale buttons and auto-prompts are hidden.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "moraleAutoPromptThreshold", {
    name: "Morale Auto-Prompt Threshold (%)",
    hint: "When a group's living members drop to this percentage of starting size, the GM is prompted to roll morale. Set to 0 to disable auto-prompts.",
    scope: "world",
    config: true,
    type: Number,
    default: 50,
    range: { min: 0, max: 100, step: 5 },
  });

  game.settings.register(MODULE_ID, "moraleStatusEffect", {
    name: "Morale Failure Status Effect",
    hint: "Which status effect to apply when a creature fails its morale check.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      frightened: "Frightened (dnd5e built-in)",
      fleeing: "Fleeing (custom effect)",
    },
    default: "frightened",
  });

  game.settings.register(MODULE_ID, "moraleMobConfidenceDivisor", {
    name: "Mob Confidence Divisor",
    hint: "Mob confidence bonus = +1 per this many living members. Default: +1 per 3 living members. Can be overridden per-group.",
    scope: "world",
    config: true,
    type: Number,
    default: 3,
    range: { min: 1, max: 10, step: 1 },
  });

  game.settings.register(MODULE_ID, "moraleEffectDuration", {
    name: "Morale Effect Duration (rounds)",
    hint: "How many rounds the morale failure effect lasts. Set to 0 for permanent (must be removed manually).",
    scope: "world",
    config: true,
    type: Number,
    default: 0,
    range: { min: 0, max: 100, step: 1 },
  });

  // Legacy setting migration - convert old boolean to new level
  game.settings.register(MODULE_ID, "enableLogging", {
    scope: "world",
    config: false, // Hidden
    type: Boolean,
    default: false,
  });

  logger.info("Module settings registered");
}