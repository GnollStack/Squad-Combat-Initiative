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

  // Legacy setting migration - convert old boolean to new level
  game.settings.register(MODULE_ID, "enableLogging", {
    scope: "world",
    config: false, // Hidden
    type: Boolean,
    default: false,
  });

  logger.info("Module settings registered");
}