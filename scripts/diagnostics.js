/**
 * @file diagnostics.js
 * @description MCP diagnostics and gated fixture automation for live Foundry validation.
 * @version Foundry V14+
 */

import {
  MODULE_ID,
  INITIATIVE_MODE,
  MORALE_TRIGGER,
  calculateAverageInitiative,
  calculateGroupInitiative,
  expandStore,
  sanitizeColor,
  sanitizeImagePath,
  visibilitySyncInProgress,
} from "./shared.js";
import { DEBUG_LEVELS, HIGHLIGHT_VISIBILITY, VISIBILITY_SYNC_MODE } from "./settings.js";
import { GroupManager, UNGROUPED } from "./class-objects.js";
import { DISCIPLINE } from "./morale.js";
import {
  FIXTURE_FLAG,
  FIXTURE_PREFIX,
  cleanupFixtures as runFixtureCleanup,
  getFixtureCounts,
  getWorldDocumentCounts,
  runAutomation as runFixtureAutomation,
} from "./diagnostics-automation.js";

const MCP_BRIDGE_ID = "foundry-mcp-bridge";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "diagnostics.collect.request";
const SOCKET_RESPONSE = "diagnostics.collect.response";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_ASSET_CHECKS = 100;

const SETTINGS_KEYS = Object.freeze([
  "autoCollapseGroups",
  "defaultGroupPinned",
  "defaultInitiativeMode",
  "visibilitySyncMode",
  "groupTokenHighlight",
  "debugLevel",
  "enableMcpDiagnostics",
  "allowMutatingDiagnostics",
  "moraleEnabled",
  "moraleAutoPromptThreshold",
  "moraleStatusEffect",
  "moraleMobConfidenceDivisor",
  "moraleEffectDuration",
  "enableLogging",
]);

const MODULE_ASSETS = Object.freeze([
  "module.json",
  "README.md",
  "scripts/main.js",
  "scripts/shared.js",
  "scripts/settings.js",
  "scripts/combat-tracker.js",
  "scripts/group-header-rendering.js",
  "scripts/class-objects.js",
  "scripts/rolling-overrides.js",
  "scripts/morale.js",
  "scripts/diagnostics.js",
  "scripts/diagnostics-automation.js",
  "styles/styles.css",
]);

const BUILT_IN_ASSETS = Object.freeze([
  "icons/svg/combat.svg",
  "icons/svg/mystery-man.svg",
  "icons/svg/skull.svg",
  "icons/svg/aura.svg",
  "icons/svg/terror.svg",
]);

/** @type {Map<string, {responses: Map<string, object>, expectedUserIds: Set<string>, resolve: Function}>} */
const pendingClientCollections = new Map();

let socketListenerRegistered = false;

/**
 * Attach diagnostics actions to the public module API.
 * @param {object} api
 * @returns {object}
 */
export function registerDiagnostics(api) {
  registerSocketListener();

  const diagnostics = Object.freeze({
    version: 1,
    socketChannel: SOCKET_CHANNEL,
    isEnabled: () => getAvailability().available,
    getAvailability,
    getMutationAvailability,
    actions: Object.freeze({
      getStatus,
      validateSettings,
      validateData,
      validateAssets,
      runSmokeTests,
      collectClientDiagnostics,
      refreshClient,
      runAutomation,
      cleanupFixtures,
    }),
  });

  api.diagnostics = diagnostics;
  return diagnostics;
}

function assertDiagnosticsAvailable() {
  const availability = getAvailability();

  if (!availability.gates.activeGMUser) {
    throw new Error("Access denied: diagnostics require a GM user.");
  }

  if (!availability.gates.debugLogging) {
    throw new Error("Diagnostics require Debug Logging Level to be Normal or Verbose.");
  }

  if (!availability.gates.enableMcpDiagnostics) {
    throw new Error("Diagnostics require the Enable MCP Diagnostics setting to be enabled.");
  }
}

function assertMutatingDiagnosticsAvailable(args = {}) {
  assertDiagnosticsAvailable();

  if (!getMutationAvailability().gates.allowMutatingDiagnostics) {
    throw new Error("Mutating diagnostics require the Allow Mutating MCP Diagnostics setting to be enabled.");
  }

  if (args.confirmMutation !== true) {
    throw new Error("Mutating diagnostics require confirmMutation: true.");
  }
}

function getAvailability() {
  const gates = getDiagnosticsGates();
  return {
    available: gates.activeGMUser && gates.debugLogging && gates.enableMcpDiagnostics,
    gates,
  };
}

function getMutationAvailability() {
  const availability = getAvailability();
  const allowMutatingDiagnostics = getSettingValue("allowMutatingDiagnostics") === true;
  const gates = {
    ...availability.gates,
    allowMutatingDiagnostics,
    mutationEnabled: availability.available && allowMutatingDiagnostics,
  };

  return {
    available: availability.available && allowMutatingDiagnostics,
    gates,
  };
}

function getDiagnosticsGates() {
  const debugLevel = getSettingValue("debugLevel");
  return {
    activeGMUser: !!game.user?.isGM && game.user?.active !== false,
    debugLogging: typeof debugLevel === "string" && debugLevel !== DEBUG_LEVELS.OFF,
    enableMcpDiagnostics: getSettingValue("enableMcpDiagnostics") === true,
  };
}

function areDiagnosticsSettingsEnabled() {
  const gates = getDiagnosticsGates();
  return gates.debugLogging && gates.enableMcpDiagnostics;
}

function getAvailableActions() {
  return [
    "cleanupFixtures",
    "collectClientDiagnostics",
    "getStatus",
    "refreshClient",
    "runAutomation",
    "runSmokeTests",
    "validateAssets",
    "validateData",
    "validateSettings",
  ];
}

function getReadOnlyActions() {
  return ["collectClientDiagnostics", "getStatus", "refreshClient", "runSmokeTests", "validateAssets", "validateData", "validateSettings"];
}

function getMutatingActions() {
  return ["cleanupFixtures", "runAutomation"];
}

function registerSocketListener() {
  if (socketListenerRegistered || !game.socket?.on) return;

  game.socket.on(SOCKET_CHANNEL, async (payload) => {
    if (!payload || payload.moduleId !== MODULE_ID) return;

    if (payload.type === SOCKET_REQUEST) {
      await handleClientDiagnosticsRequest(payload);
      return;
    }

    if (payload.type === SOCKET_RESPONSE) {
      handleClientDiagnosticsResponse(payload);
    }
  });

  socketListenerRegistered = true;
}

async function handleClientDiagnosticsRequest(payload) {
  if (!payload.requestId || !payload.requesterId || payload.requesterId === game.user?.id) return;
  if (!areDiagnosticsSettingsEnabled()) return;
  if (!game.users?.get?.(payload.requesterId)?.isGM) return;

  const snapshot = createClientSnapshot({
    includeDom: payload.includeDom === true,
    requestId: payload.requestId,
  });

  game.socket.emit(SOCKET_CHANNEL, {
    moduleId: MODULE_ID,
    type: SOCKET_RESPONSE,
    requestId: payload.requestId,
    requesterId: payload.requesterId,
    responderId: game.user?.id,
    snapshot,
  });
}

function handleClientDiagnosticsResponse(payload) {
  if (!payload.requestId || payload.requesterId !== game.user?.id) return;

  const pending = pendingClientCollections.get(payload.requestId);
  if (!pending || !payload.responderId || !pending.expectedUserIds.has(payload.responderId)) return;

  pending.responses.set(payload.responderId, toPlainObject(payload.snapshot));
  if (pending.responses.size >= pending.expectedUserIds.size) {
    pending.resolve();
  }
}

function toPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return JSON.parse(JSON.stringify(value));
}

function getSettingValue(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (err) {
    return { error: err.message };
  }
}

function getSettingsSnapshot() {
  const settings = {};
  for (const key of SETTINGS_KEYS) {
    settings[key] = getSettingValue(key);
  }
  return settings;
}

function summarizeModule() {
  const mod = game.modules.get(MODULE_ID);
  const manifest = mod?.manifest ?? {};

  return {
    id: MODULE_ID,
    title: mod?.title ?? manifest.title ?? MODULE_ID,
    active: !!mod?.active,
    version: mod?.version ?? manifest.version ?? null,
    compatibility: manifest.compatibility ?? null,
    esmodules: manifest.esmodules ?? ["scripts/main.js"],
    styles: manifest.styles ?? ["styles/styles.css"],
  };
}

function summarizeRuntime() {
  const combatTrackerPrototype = ui.combat?.constructor?.prototype;

  return {
    foundry: {
      version: game.version,
      generation: game.release?.generation ?? null,
      build: game.release?.build ?? null,
    },
    world: {
      id: game.world?.id ?? null,
      title: game.world?.title ?? null,
    },
    system: {
      id: game.system?.id ?? null,
      title: game.system?.title ?? null,
      version: game.system?.version ?? null,
    },
    user: summarizeUser(game.user),
    canvas: {
      ready: !!canvas?.ready,
      sceneId: canvas?.scene?.id ?? null,
      sceneName: canvas?.scene?.name ?? null,
      controlledTokens: canvas?.tokens?.controlled?.length ?? 0,
    },
    combatTracker: {
      available: !!ui.combat,
      renderGroupsPatched: typeof combatTrackerPrototype?.renderGroups === "function",
      hoverCombatantPatched: !!combatTrackerPrototype?._sciOriginalHoverCombatant,
      rendered: !!ui.combat?.rendered,
    },
    wrappers: {
      libWrapperActive: !!game.modules.get("lib-wrapper")?.active,
      libWrapperVersion: game.modules.get("lib-wrapper")?.version ?? null,
      registered: !!game.modules.get(MODULE_ID)?.__groupSortWrappersRegistered,
    },
    sockets: {
      channel: SOCKET_CHANNEL,
      listenerRegistered: socketListenerRegistered,
    },
  };
}

function summarizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    active: !!user.active,
    isGM: !!user.isGM,
    role: user.role ?? null,
  };
}

function summarizeCombat(combat) {
  if (!combat) return null;

  const groups = getGroupSummaries(combat);
  const groupedMemberIds = new Set(groups.flatMap((group) => group.memberIds));
  const ungroupedCount = combat.combatants.filter((combatant) => {
    const groupId = combatant.getFlag(MODULE_ID, "groupId");
    return !groupId || groupId === UNGROUPED || !groupedMemberIds.has(combatant.id);
  }).length;

  return {
    id: combat.id,
    name: combat.name ?? null,
    active: game.combat?.id === combat.id,
    round: combat.round ?? null,
    turn: combat.turn ?? null,
    combatantCount: combat.combatants.size ?? combat.combatants.length ?? 0,
    currentCombatantId: combat.combatant?.id ?? null,
    groupCount: groups.length,
    groupedCombatantCount: groupedMemberIds.size,
    ungroupedCombatantCount: ungroupedCount,
    groups,
  };
}

function getGroupSummaries(combat) {
  const groups = combat.getFlag(MODULE_ID, "groups") ?? {};

  return Object.entries(groups).map(([groupId, group]) => {
    const members = combat.combatants.filter((combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId);
    const memberIds = members.map((combatant) => combatant.id).sort();
    const captainId = group?.captainId ?? null;

    return {
      id: groupId,
      name: String(group?.name ?? "Unnamed Group"),
      memberIds,
      memberCount: members.length,
      hidden: group?.hidden === true,
      pinned: group?.pinned === true,
      initiative: Number.isFinite(group?.initiative) ? group.initiative : null,
      initiativeMode: group?.initiativeMode ?? INITIATIVE_MODE.AVERAGE,
      captainId,
      captainValid: !captainId || memberIds.includes(captainId),
      discipline: group?.discipline ?? DISCIPLINE.STANDARD,
      moraleTrigger: group?.moraleTrigger ?? MORALE_TRIGGER.BOTH,
      startingSize: Number.isFinite(group?.startingSize) ? group.startingSize : null,
      deletedCount: Number.isFinite(group?.deletedCount) ? group.deletedCount : 0,
      morale: {
        passed: members.filter((combatant) => combatant.getFlag(MODULE_ID, "moraleStatus") === "passed").length,
        failed: members.filter((combatant) => combatant.getFlag(MODULE_ID, "moraleStatus") === "failed").length,
      },
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function resolveCombats(args = {}) {
  if (args.includeAllCombats === true) {
    return Array.from(game.combats?.values?.() ?? []);
  }

  if (typeof args.combatId === "string" && args.combatId.trim()) {
    const combatId = args.combatId.trim();
    if (!ID_PATTERN.test(combatId)) throw new Error("combatId contains unsupported characters.");
    const combat = game.combats.get(combatId);
    return combat ? [combat] : [];
  }

  return game.combat ? [game.combat] : [];
}

async function getStatus(_args = {}) {
  assertDiagnosticsAvailable();

  const api = game.modules.get(MODULE_ID)?.api ?? {};
  const availability = getAvailability();
  const mutationAvailability = getMutationAvailability();

  return {
    success: true,
    module: summarizeModule(),
    diagnostics: {
      version: 1,
      available: availability.available,
      gates: availability.gates,
      gate: availability.gates,
      availableActions: getAvailableActions(),
      readOnlyActions: getReadOnlyActions(),
      mutatingActions: getMutatingActions(),
      bridge: "call-module-debug-action",
      fixturePrefix: FIXTURE_PREFIX,
      fixtureFlag: FIXTURE_FLAG,
      mutation: {
        confirmMutationRequired: true,
        available: mutationAvailability.available,
        gates: mutationAvailability.gates,
      },
      refresh: {
        moduleAction: "refreshClient",
        bridgeTool: "reload-foundry-client",
        gatedByDiagnostics: true,
      },
    },
    runtime: summarizeRuntime(),
    settings: getSettingsSnapshot(),
    activeCombat: summarizeCombat(game.combat),
    fixtures: getFixtureCounts(canvas?.scene ?? null),
    publicApiKeys: Object.keys(api).sort(),
  };
}

async function validateData(args = {}) {
  assertDiagnosticsAvailable();

  const combats = resolveCombats(args);
  const errors = [];
  const warnings = [];
  const checkedCombats = [];

  for (const combat of combats) {
    const result = validateCombatData(combat);
    checkedCombats.push(result.summary);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    success: errors.length === 0,
    checked: {
      combats: checkedCombats.length,
      groups: checkedCombats.reduce((sum, combat) => sum + combat.groupCount, 0),
      combatants: checkedCombats.reduce((sum, combat) => sum + combat.combatantCount, 0),
    },
    errors,
    warnings,
    combats: checkedCombats,
  };
}

async function validateSettings(_args = {}) {
  assertDiagnosticsAvailable();

  const settings = getSettingsSnapshot();
  const errors = [];
  const warnings = [];

  validateBooleanSetting(settings, "autoCollapseGroups", errors);
  validateBooleanSetting(settings, "defaultGroupPinned", errors);
  validateBooleanSetting(settings, "enableMcpDiagnostics", errors);
  validateBooleanSetting(settings, "allowMutatingDiagnostics", errors);
  validateBooleanSetting(settings, "moraleEnabled", errors);
  validateBooleanSetting(settings, "enableLogging", errors);
  validateChoiceSetting(settings, "defaultInitiativeMode", Object.values(INITIATIVE_MODE), errors);
  validateChoiceSetting(settings, "visibilitySyncMode", Object.values(VISIBILITY_SYNC_MODE), errors);
  validateChoiceSetting(settings, "groupTokenHighlight", Object.values(HIGHLIGHT_VISIBILITY), errors);
  validateChoiceSetting(settings, "debugLevel", Object.values(DEBUG_LEVELS), errors);
  validateChoiceSetting(settings, "moraleStatusEffect", ["frightened", "prone", "fleeing", "none"], errors);
  validateNumberSetting(settings, "moraleAutoPromptThreshold", 0, 100, errors);
  validateNumberSetting(settings, "moraleMobConfidenceDivisor", 1, 10, errors);
  validateNumberSetting(settings, "moraleEffectDuration", 0, 100, errors);

  if (settings.allowMutatingDiagnostics === true) {
    warnings.push(settingIssue(
      "allowMutatingDiagnostics",
      "mutating-diagnostics-enabled",
      "Mutating MCP diagnostics are enabled; leave this disabled outside active testing.",
      settings.allowMutatingDiagnostics
    ));
  }

  return {
    success: errors.length === 0,
    checked: Object.keys(settings).length,
    errors,
    warnings,
    settings,
  };
}

function validateBooleanSetting(settings, key, errors) {
  const value = settings[key];
  if (value && typeof value === "object" && "error" in value) {
    errors.push(settingIssue(key, "setting-read-error", value.error, value));
    return;
  }
  if (typeof value !== "boolean") {
    errors.push(settingIssue(key, "invalid-boolean-setting", "Setting must be a boolean.", value));
  }
}

function validateChoiceSetting(settings, key, choices, errors) {
  const value = settings[key];
  if (value && typeof value === "object" && "error" in value) {
    errors.push(settingIssue(key, "setting-read-error", value.error, value));
    return;
  }
  if (!choices.includes(value)) {
    errors.push(settingIssue(key, "invalid-choice-setting", `Setting must be one of: ${choices.join(", ")}.`, value));
  }
}

function validateNumberSetting(settings, key, min, max, errors) {
  const value = settings[key];
  if (value && typeof value === "object" && "error" in value) {
    errors.push(settingIssue(key, "setting-read-error", value.error, value));
    return;
  }
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push(settingIssue(key, "invalid-number-setting", `Setting must be a finite number from ${min} to ${max}.`, value));
  }
}

function settingIssue(key, code, message, value) {
  return {
    key,
    code,
    message,
    value,
  };
}

function validateCombatData(combat) {
  const errors = [];
  const warnings = [];
  const groups = combat.getFlag(MODULE_ID, "groups") ?? {};
  const groupIds = new Set(Object.keys(groups));

  if (groups && (typeof groups !== "object" || Array.isArray(groups))) {
    errors.push(issue(combat, null, "invalid-groups-container", "Combat group flags must be an object."));
  }

  for (const [groupId, group] of Object.entries(groups)) {
    validateGroupData(combat, groupId, group, errors, warnings);
  }

  for (const combatant of combat.combatants) {
    const groupId = combatant.getFlag(MODULE_ID, "groupId");
    const moraleStatus = combatant.getFlag(MODULE_ID, "moraleStatus");

    if (!groupId) {
      warnings.push(issue(combat, null, "combatant-missing-group-id", `Combatant "${combatant.name}" has no groupId flag.`, combatant.id));
    } else if (groupId !== UNGROUPED && !groupIds.has(groupId)) {
      errors.push(issue(combat, groupId, "combatant-references-missing-group", `Combatant "${combatant.name}" references a missing group.`, combatant.id));
    }

    if (moraleStatus && !["passed", "failed"].includes(moraleStatus)) {
      errors.push(issue(combat, groupId ?? null, "invalid-morale-status", `Combatant "${combatant.name}" has invalid moraleStatus "${moraleStatus}".`, combatant.id));
    }

    validateMoraleEffects(combat, combatant, errors);
  }

  const skipFinalize = combat.getFlag(MODULE_ID, "skipFinalize") ?? {};
  if (skipFinalize && Object.keys(skipFinalize).length) {
    warnings.push(issue(combat, null, "skip-finalize-leftover", "Combat has non-empty skipFinalize flags; this should be temporary."));
  }

  return {
    summary: summarizeCombat(combat),
    errors,
    warnings,
  };
}

function validateGroupData(combat, groupId, group, errors, warnings) {
  const members = combat.combatants.filter((combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId);

  if (!ID_PATTERN.test(groupId)) {
    errors.push(issue(combat, groupId, "invalid-group-id", "Group id contains unsupported characters."));
  }

  if (!group || typeof group !== "object" || Array.isArray(group)) {
    errors.push(issue(combat, groupId, "invalid-group-data", "Group metadata must be an object."));
    return;
  }

  if (typeof group.name !== "string" || !group.name.trim()) {
    errors.push(issue(combat, groupId, "invalid-group-name", "Group name must be a non-empty string."));
  }

  if (group.color !== undefined && sanitizeColor(group.color, null) === null) {
    warnings.push(issue(combat, groupId, "invalid-group-color", "Group color is not a valid hex color."));
  }

  if (group.img !== undefined && sanitizeImagePath(group.img, null) === null) {
    warnings.push(issue(combat, groupId, "invalid-group-image", "Group image path is empty or unsafe."));
  }

  if (group.initiative !== null && group.initiative !== undefined && !Number.isFinite(group.initiative)) {
    errors.push(issue(combat, groupId, "invalid-group-initiative", "Group initiative must be a finite number or null."));
  }

  if (group.initiativeMode !== undefined && !Object.values(INITIATIVE_MODE).includes(group.initiativeMode)) {
    errors.push(issue(combat, groupId, "invalid-initiative-mode", `Unknown initiative mode "${group.initiativeMode}".`));
  }

  if (group.moraleTrigger !== undefined && !Object.values(MORALE_TRIGGER).includes(group.moraleTrigger)) {
    errors.push(issue(combat, groupId, "invalid-morale-trigger", `Unknown morale trigger "${group.moraleTrigger}".`));
  }

  if (group.discipline !== undefined && !Object.values(DISCIPLINE).includes(group.discipline)) {
    errors.push(issue(combat, groupId, "invalid-discipline", `Unknown discipline "${group.discipline}".`));
  }

  if (group.deletedCount !== undefined && (!Number.isFinite(group.deletedCount) || group.deletedCount < 0)) {
    errors.push(issue(combat, groupId, "invalid-deleted-count", "deletedCount must be a non-negative number."));
  }

  if (group.startingSize !== null && group.startingSize !== undefined && (!Number.isFinite(group.startingSize) || group.startingSize < 0)) {
    errors.push(issue(combat, groupId, "invalid-starting-size", "startingSize must be null or a non-negative number."));
  }

  if (group.captainId && !members.some((combatant) => combatant.id === group.captainId)) {
    warnings.push(issue(combat, groupId, "captain-not-in-group", "Captain id does not match a current group member."));
  }

  if (group.initiativeMode === INITIATIVE_MODE.CAPTAIN && !group.captainId) {
    warnings.push(issue(combat, groupId, "captain-mode-without-captain", "Captain initiative mode is active without a captain."));
  }
}

function validateMoraleEffects(combat, combatant, errors) {
  const effects = combatant.token?.actor?.effects ?? combatant.actor?.effects ?? [];
  for (const effect of effects) {
    const marker = effect.getFlag?.(MODULE_ID, "moraleEffect");
    if (!marker) continue;

    const status = effect.getFlag?.(MODULE_ID, "moraleEffectStatus");
    if (!["frightened", "prone", "fleeing"].includes(status)) {
      errors.push(issue(combat, combatant.getFlag(MODULE_ID, "groupId") ?? null, "invalid-morale-effect-status", `Module-owned morale effect on "${combatant.name}" has invalid status "${status}".`, combatant.id));
    }
  }
}

function issue(combat, groupId, code, message, combatantId = null) {
  return {
    combatId: combat.id,
    combatName: combat.name ?? null,
    groupId,
    combatantId,
    code,
    message,
  };
}

async function validateAssets(args = {}) {
  assertDiagnosticsAvailable();

  const candidates = collectAssetCandidates(args);
  const checked = [];
  const skipped = [];

  for (const candidate of candidates.slice(0, MAX_ASSET_CHECKS)) {
    const normalized = normalizeAssetCandidate(candidate);
    if (normalized.skip) {
      skipped.push({ ...candidate, reason: normalized.reason });
      continue;
    }

    checked.push(await fetchAsset(normalized.url, candidate));
  }

  const failures = checked.filter((asset) => !asset.ok);

  return {
    success: failures.length === 0,
    checked: checked.length,
    skipped: skipped.length,
    truncated: Math.max(0, candidates.length - MAX_ASSET_CHECKS),
    failures,
    assets: checked,
    skippedAssets: skipped,
  };
}

function collectAssetCandidates(args) {
  const candidates = [];
  for (const path of MODULE_ASSETS) {
    candidates.push({ kind: "module", path, moduleRelative: true });
  }
  for (const path of BUILT_IN_ASSETS) {
    candidates.push({ kind: "foundry", path, moduleRelative: false });
  }

  const combats = resolveCombats(args);
  for (const combat of combats) {
    const groups = combat.getFlag(MODULE_ID, "groups") ?? {};
    for (const [groupId, group] of Object.entries(groups)) {
      if (group?.img) {
        candidates.push({ kind: "group-image", path: group.img, groupId, combatId: combat.id, moduleRelative: false });
      }
    }
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.path}:${candidate.groupId ?? ""}:${candidate.combatId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeAssetCandidate(candidate) {
  const raw = String(candidate.path ?? "").trim();
  if (!raw) return { skip: true, reason: "empty path" };
  if (/^(?:javascript|vbscript|data):/i.test(raw)) return { skip: true, reason: "unsafe or inline URL" };
  if (/^https?:\/\//i.test(raw)) return { skip: true, reason: "external URL" };

  const path = raw.replace(/^\/+/, "");
  const url = candidate.moduleRelative ? `modules/${MODULE_ID}/${path}` : path;
  return { skip: false, url };
}

async function fetchAsset(url, candidate) {
  if (typeof fetch !== "function") {
    return { ...candidate, url, ok: false, status: null, error: "fetch is not available" };
  }

  try {
    const response = await fetch(url, { cache: "no-store" });
    return {
      ...candidate,
      url,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
    };
  } catch (err) {
    return {
      ...candidate,
      url,
      ok: false,
      status: null,
      error: err.message,
    };
  }
}

async function runSmokeTests(args = {}) {
  assertDiagnosticsAvailable();

  const beforeCounts = getWorldDocumentCounts(canvas?.scene ?? null);
  const tests = [];
  const addTest = (name, fn) => {
    try {
      const details = fn();
      const pass = details === true || details?.pass === true;
      tests.push({ name, pass, details: details === true ? null : details });
    } catch (err) {
      tests.push({ name, pass: false, error: err.message });
    }
  };

  addTest("average initiative math", () => ({
    pass: calculateAverageInitiative([10, 11, 12]) === 11 && calculateAverageInitiative([]) === null,
  }));

  addTest("initiative modes", () => ({
    pass:
      calculateGroupInitiative([5, 12, 9], INITIATIVE_MODE.HIGHEST) === 12
      && calculateGroupInitiative([5, 12, 9], INITIATIVE_MODE.LOWEST) === 5
      && calculateGroupInitiative([5, 12, 9], INITIATIVE_MODE.MEDIAN) === 9
      && calculateGroupInitiative([5, 12, 9, 20], INITIATIVE_MODE.MEDIAN) === 11
      && calculateGroupInitiative([5, 12, 9], INITIATIVE_MODE.CAPTAIN, 7) === 7
      && calculateGroupInitiative([5, 12, 9], INITIATIVE_MODE.CAPTAIN, null) === 9,
  }));

  addTest("sanitizers reject unsafe values", () => ({
    pass:
      sanitizeColor("#abcdef", "#000000") === "#abcdef"
      && sanitizeColor("not-a-color", "#000000") === "#000000"
      && sanitizeImagePath("javascript:alert(1)", "icons/svg/combat.svg") === "icons/svg/combat.svg",
  }));

  addTest("required libWrapper is active", () => ({
    pass: !!game.modules.get("lib-wrapper")?.active,
    active: !!game.modules.get("lib-wrapper")?.active,
    version: game.modules.get("lib-wrapper")?.version ?? null,
  }));

  addTest("combat tracker patch is present", () => ({
    pass: typeof ui.combat?.constructor?.prototype?.renderGroups === "function",
  }));

  addTest("roll wrappers registered", () => ({
    pass: !!game.modules.get(MODULE_ID)?.__groupSortWrappersRegistered,
  }));

  addTest("group sort helper is deterministic", () => {
    const mock = [
      { init: 12, dex: 10, combatant: { id: "b" } },
      { init: 12, dex: 14, combatant: { id: "a" } },
      { init: 9, dex: 18, combatant: { id: "c" } },
    ];
    GroupManager._sortOrderList(mock);
    return { pass: mock.map((entry) => entry.combatant.id).join(",") === "a,b,c" };
  });

  const settingsValidation = await validateSettings();
  tests.push({
    name: "settings validation has no errors",
    pass: settingsValidation.errors.length === 0,
    details: {
      errors: settingsValidation.errors.length,
      warnings: settingsValidation.warnings.length,
    },
  });

  if (game.combat) {
    const validation = await validateData(args);
    tests.push({
      name: "active combat data validation has no errors",
      pass: validation.errors.length === 0,
      details: {
        errors: validation.errors.length,
        warnings: validation.warnings.length,
      },
    });
  } else {
    tests.push({
      name: "active combat data validation has no errors",
      pass: true,
      details: { skipped: true, reason: "No active combat." },
    });
  }

  const afterCounts = getWorldDocumentCounts(canvas?.scene ?? null);
  const worldDocumentCountsStable = JSON.stringify(beforeCounts) === JSON.stringify(afterCounts);
  tests.push({
    name: "read-only smoke tests did not change world document counts",
    pass: worldDocumentCountsStable,
    details: { beforeCounts, afterCounts },
  });

  const failures = tests.filter((test) => !test.pass);
  return {
    success: failures.length === 0,
    passed: tests.length - failures.length,
    failed: failures.length,
    beforeCounts,
    afterCounts,
    worldDocumentCountsStable,
    tests,
  };
}

async function collectClientDiagnostics(args = {}) {
  assertDiagnosticsAvailable();

  const expectedNonGMClients = normalizeCount(args.expectedNonGMClients, 0);
  const timeoutMs = Math.max(250, Math.min(normalizeCount(args.timeoutMs, 1500), 5000));
  const includeDom = args.includeDom === true;
  const activeNonGMUsers = game.users.filter((user) => user.active && !user.isGM);

  const gmSnapshot = createClientSnapshot({ includeDom, requestId: null });

  if (activeNonGMUsers.length < expectedNonGMClients) {
    return {
      success: false,
      status: "failed",
      reason: "insufficient-active-non-gm-clients",
      expectedNonGMClients,
      activeNonGMClients: activeNonGMUsers.map(summarizeUser),
      gmSnapshot,
      assertions: [{
        name: "expected non-GM clients active",
        status: "failed",
        details: `Expected ${expectedNonGMClients}, found ${activeNonGMUsers.length}.`,
      }],
    };
  }

  if (!activeNonGMUsers.length) {
    return {
      success: true,
      status: "inconclusive",
      reason: "no-active-non-gm-clients",
      expectedNonGMClients,
      activeNonGMClients: [],
      gmSnapshot,
      clientSnapshots: [],
      assertions: [{
        name: "client comparison",
        status: "inconclusive",
        details: "No active non-GM clients were available to compare.",
      }],
    };
  }

  const requestId = foundry.utils.randomID();
  const expectedUserIds = new Set(activeNonGMUsers.map((user) => user.id));
  const responses = new Map();

  await new Promise((resolve) => {
    pendingClientCollections.set(requestId, { responses, expectedUserIds, resolve });
    game.socket.emit(SOCKET_CHANNEL, {
      moduleId: MODULE_ID,
      type: SOCKET_REQUEST,
      requestId,
      requesterId: game.user.id,
      includeDom,
    });
    window.setTimeout(resolve, timeoutMs);
  });

  pendingClientCollections.delete(requestId);

  const clientSnapshots = Array.from(responses.values());
  const respondedIds = new Set(clientSnapshots.map((snapshot) => snapshot.user?.id).filter(Boolean));
  const missingClients = activeNonGMUsers
    .filter((user) => !respondedIds.has(user.id))
    .map(summarizeUser);

  const assertions = compareClientSnapshots(gmSnapshot, clientSnapshots);
  if (missingClients.length) {
    assertions.push({
      name: "all active non-GM clients responded",
      status: "inconclusive",
      details: `${missingClients.length} active non-GM client(s) did not respond before timeout.`,
    });
  }

  const failed = assertions.some((assertion) => assertion.status === "failed");
  const inconclusive = assertions.some((assertion) => assertion.status === "inconclusive");

  return {
    success: !failed && !missingClients.length,
    status: failed ? "failed" : inconclusive || missingClients.length ? "inconclusive" : "passed",
    expectedNonGMClients,
    activeNonGMClients: activeNonGMUsers.map(summarizeUser),
    missingClients,
    gmSnapshot,
    clientSnapshots,
    assertions,
  };
}

async function refreshClient(args = {}) {
  assertDiagnosticsAvailable();

  const delayMs = Math.max(0, Math.min(Number(args.delayMs) || 250, 5000));
  window.setTimeout(() => window.location.reload(), delayMs);
  return { success: true, initiated: true, delayMs };
}

async function runAutomation(args = {}) {
  assertMutatingDiagnosticsAvailable(args);
  return runFixtureAutomation(args, { validateData });
}

async function cleanupFixtures(args = {}) {
  assertMutatingDiagnosticsAvailable(args);
  return runFixtureCleanup(args);
}
function normalizeCount(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function createClientSnapshot({ includeDom = false, requestId = null } = {}) {
  const combat = game.combat;
  const groups = combat ? getGroupSummaries(combat) : [];

  return {
    requestId,
    capturedAt: new Date().toISOString(),
    user: summarizeUser(game.user),
    scene: {
      id: canvas?.scene?.id ?? null,
      name: canvas?.scene?.name ?? null,
      ready: !!canvas?.ready,
    },
    combat: combat ? {
      id: combat.id,
      round: combat.round ?? null,
      turn: combat.turn ?? null,
      currentCombatantId: combat.combatant?.id ?? null,
      groupSignature: buildGroupSignature(groups),
      groups,
    } : null,
    localUi: {
      combatTrackerRendered: !!ui.combat?.rendered,
      expandedGroupIds: combat ? Array.from(expandStore.load(combat.id)).sort() : [],
      visibilitySyncGuardSize: visibilitySyncInProgress.size,
      groupRowsInDom: includeDom ? countGroupRowsInDom() : null,
    },
    runtime: {
      moduleVersion: game.modules.get(MODULE_ID)?.version ?? null,
      renderGroupsPatched: typeof ui.combat?.constructor?.prototype?.renderGroups === "function",
      wrappersRegistered: !!game.modules.get(MODULE_ID)?.__groupSortWrappersRegistered,
      settings: {
        visibilitySyncMode: getSettingValue("visibilitySyncMode"),
        autoCollapseGroups: getSettingValue("autoCollapseGroups"),
        groupTokenHighlight: getSettingValue("groupTokenHighlight"),
        moraleEnabled: getSettingValue("moraleEnabled"),
        allowMutatingDiagnostics: getSettingValue("allowMutatingDiagnostics"),
      },
    },
  };
}

function countGroupRowsInDom() {
  try {
    return ui.combat?.element?.querySelectorAll?.("li.sci-combatant-group[data-group-key]")?.length ?? 0;
  } catch {
    return null;
  }
}

function buildGroupSignature(groups) {
  return JSON.stringify(groups.map((group) => ({
    id: group.id,
    hidden: group.hidden,
    initiative: group.initiative,
    captainId: group.captainId,
    memberIds: group.memberIds,
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

function compareClientSnapshots(gmSnapshot, clientSnapshots) {
  const assertions = [];

  for (const snapshot of clientSnapshots) {
    const label = snapshot.user?.name ?? snapshot.user?.id ?? "unknown client";

    assertions.push(compareValue(`${label}: active scene matches GM`, gmSnapshot.scene?.id, snapshot.scene?.id));

    if (!gmSnapshot.combat && !snapshot.combat) {
      assertions.push({ name: `${label}: active combat`, status: "passed", details: "No active combat on either client." });
      continue;
    }

    if (!gmSnapshot.combat || !snapshot.combat) {
      assertions.push({
        name: `${label}: active combat matches GM`,
        status: "inconclusive",
        details: "One client lacks an active combat.",
      });
      continue;
    }

    assertions.push(compareValue(`${label}: active combat id matches GM`, gmSnapshot.combat.id, snapshot.combat.id));
    assertions.push(compareValue(`${label}: combat round matches GM`, gmSnapshot.combat.round, snapshot.combat.round));
    assertions.push(compareValue(`${label}: combat turn matches GM`, gmSnapshot.combat.turn, snapshot.combat.turn));
    assertions.push(compareValue(`${label}: group document signature matches GM`, gmSnapshot.combat.groupSignature, snapshot.combat.groupSignature));

    assertions.push({
      name: `${label}: expanded group state is client-local`,
      status: "inconclusive",
      details: {
        gmExpanded: gmSnapshot.localUi.expandedGroupIds,
        clientExpanded: snapshot.localUi.expandedGroupIds,
      },
    });
  }

  return assertions;
}

function compareValue(name, expected, actual) {
  return {
    name,
    status: expected === actual ? "passed" : "failed",
    expected,
    actual,
  };
}

export const DIAGNOSTICS_CONSTANTS = Object.freeze({
  MCP_BRIDGE_ID,
  SOCKET_CHANNEL,
  SOCKET_REQUEST,
  SOCKET_RESPONSE,
  SETTINGS_KEYS,
  FIXTURE_PREFIX,
  FIXTURE_FLAG,
  DEBUG_LEVELS,
  HIGHLIGHT_VISIBILITY,
  VISIBILITY_SYNC_MODE,
});
