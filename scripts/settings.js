/**
 * @file settings.js
 * @description Registers module settings with Foundry's configuration system.
 * @version Foundry V14+
 */

import { MODULE_ID, logger, INITIATIVE_MODE } from "./shared.js";

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
    name: "SCI.Settings.AutoCollapseGroups.Name",
    hint: "SCI.Settings.AutoCollapseGroups.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "defaultGroupPinned", {
    name: "SCI.Settings.DefaultGroupPinned.Name",
    hint: "SCI.Settings.DefaultGroupPinned.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "defaultInitiativeMode", {
    name: "SCI.Settings.DefaultInitiativeMode.Name",
    hint: "SCI.Settings.DefaultInitiativeMode.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [INITIATIVE_MODE.AVERAGE]: "SCI.InitiativeMode.Average",
      [INITIATIVE_MODE.HIGHEST]: "SCI.InitiativeMode.Highest",
      [INITIATIVE_MODE.LOWEST]: "SCI.InitiativeMode.Lowest",
      [INITIATIVE_MODE.MEDIAN]: "SCI.InitiativeMode.Median",
      [INITIATIVE_MODE.CAPTAIN]: "SCI.InitiativeMode.Captain",
    },
    default: INITIATIVE_MODE.AVERAGE,
  });

  game.settings.register(MODULE_ID, "visibilitySyncMode", {
    name: "SCI.Settings.VisibilitySyncMode.Name",
    hint: "SCI.Settings.VisibilitySyncMode.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [VISIBILITY_SYNC_MODE.BIDIRECTIONAL]: "SCI.Settings.VisibilitySyncMode.Choices.Bidirectional",
      [VISIBILITY_SYNC_MODE.TRACKER_ONLY]: "SCI.Settings.VisibilitySyncMode.Choices.TrackerOnly",
      [VISIBILITY_SYNC_MODE.NONE]: "SCI.Settings.VisibilitySyncMode.Choices.None",
    },
    default: VISIBILITY_SYNC_MODE.BIDIRECTIONAL,
  });

  game.settings.register(MODULE_ID, "groupTokenHighlight", {
    name: "SCI.Settings.GroupTokenHighlight.Name",
    hint: "SCI.Settings.GroupTokenHighlight.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [HIGHLIGHT_VISIBILITY.OFF]: "SCI.Settings.GroupTokenHighlight.Choices.Off",
      [HIGHLIGHT_VISIBILITY.GM_ONLY]: "SCI.Settings.GroupTokenHighlight.Choices.Gm",
      [HIGHLIGHT_VISIBILITY.EVERYONE]: "SCI.Settings.GroupTokenHighlight.Choices.Everyone",
    },
    default: HIGHLIGHT_VISIBILITY.GM_ONLY,
  });

  game.settings.register(MODULE_ID, "debugLevel", {
    name: "SCI.Settings.DebugLevel.Name",
    hint: "SCI.Settings.DebugLevel.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [DEBUG_LEVELS.OFF]: "SCI.Settings.DebugLevel.Choices.Off",
      [DEBUG_LEVELS.NORMAL]: "SCI.Settings.DebugLevel.Choices.Normal",
      [DEBUG_LEVELS.VERBOSE]: "SCI.Settings.DebugLevel.Choices.Verbose",
    },
    default: DEBUG_LEVELS.OFF,
    onChange: (value) => {
      logger.info(`Debug level changed to: ${value}`);
    },
  });

  game.settings.register(MODULE_ID, "enableMcpDiagnostics", {
    name: "SCI.Settings.EnableMcpDiagnostics.Name",
    hint: "SCI.Settings.EnableMcpDiagnostics.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "allowMutatingDiagnostics", {
    name: "SCI.Settings.AllowMutatingDiagnostics.Name",
    hint: "SCI.Settings.AllowMutatingDiagnostics.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // --- Morale System Settings ---

  game.settings.register(MODULE_ID, "moraleEnabled", {
    name: "SCI.Settings.MoraleEnabled.Name",
    hint: "SCI.Settings.MoraleEnabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "moraleAutoPromptThreshold", {
    name: "SCI.Settings.MoraleAutoPromptThreshold.Name",
    hint: "SCI.Settings.MoraleAutoPromptThreshold.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 50,
    range: { min: 0, max: 100, step: 5 },
  });

  game.settings.register(MODULE_ID, "moraleStatusEffect", {
    name: "SCI.Settings.MoraleStatusEffect.Name",
    hint: "SCI.Settings.MoraleStatusEffect.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      frightened: "SCI.Settings.MoraleStatusEffect.Choices.Frightened",
      prone: "SCI.Settings.MoraleStatusEffect.Choices.Prone",
      fleeing: "SCI.Settings.MoraleStatusEffect.Choices.Fleeing",
      none: "SCI.Settings.MoraleStatusEffect.Choices.None",
    },
    default: "frightened",
  });

  game.settings.register(MODULE_ID, "moraleMobConfidenceDivisor", {
    name: "SCI.Settings.MoraleMobConfidenceDivisor.Name",
    hint: "SCI.Settings.MoraleMobConfidenceDivisor.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 3,
    range: { min: 1, max: 10, step: 1 },
  });

  game.settings.register(MODULE_ID, "moraleEffectDuration", {
    name: "SCI.Settings.MoraleEffectDuration.Name",
    hint: "SCI.Settings.MoraleEffectDuration.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 0,
    range: { min: 0, max: 100, step: 1 },
  });

  // Saved group presets keyed by preset id; managed via GroupManager preset
  // methods and the create-group dialog, so no config UI is exposed.
  game.settings.register(MODULE_ID, "groupPresets", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
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

/** Migrate the retired boolean logging setting once on a GM client. */
export async function migrateLegacySettings() {
  if (!game.user?.isGM) return false;
  const legacyEnabled = game.settings.get(MODULE_ID, "enableLogging") === true;
  if (!legacyEnabled) return false;

  const currentLevel = game.settings.get(MODULE_ID, "debugLevel");
  if (currentLevel === DEBUG_LEVELS.OFF) {
    await game.settings.set(MODULE_ID, "debugLevel", DEBUG_LEVELS.NORMAL);
  }
  await game.settings.set(MODULE_ID, "enableLogging", false);
  logger.info("Migrated legacy logging setting to Debug Level");
  return true;
}
