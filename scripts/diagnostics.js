/**
 * @file diagnostics.js
 * @description MCP diagnostics and gated fixture automation for live Foundry validation.
 * @version V13 Only
 */

import {
  MODULE_ID,
  INITIATIVE_MODE,
  MORALE_TRIGGER,
  calculateAverageInitiative,
  calculateGroupInitiative,
  expandStore,
  isGM,
  sanitizeColor,
  sanitizeImagePath,
  visibilitySyncInProgress,
} from "./shared.js";
import { DEBUG_LEVELS, HIGHLIGHT_VISIBILITY, VISIBILITY_SYNC_MODE } from "./settings.js";
import { GroupManager, UNGROUPED } from "./class-objects.js";
import { DISCIPLINE, MoraleManager } from "./morale.js";

const MCP_BRIDGE_ID = "foundry-mcp-bridge";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const SOCKET_REQUEST = "diagnostics.collect.request";
const SOCKET_RESPONSE = "diagnostics.collect.response";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_ASSET_CHECKS = 100;
const FIXTURE_PREFIX = "SCI-MCP-FIXTURE";
const FIXTURE_FLAG = "diagnosticsFixture";

const SETTINGS_KEYS = Object.freeze([
  "autoCollapseGroups",
  "defaultGroupPinned",
  "defaultInitiativeMode",
  "visibilitySyncMode",
  "groupTokenHighlight",
  "debugLevel",
  "allowMutatingDiagnostics",
  "moraleEnabled",
  "moraleAutoPromptThreshold",
  "moraleStatusEffect",
  "moraleMobConfidenceDivisor",
  "moraleEffectDuration",
  "enableLogging",
]);

const MUTATION_SETTING_KEYS = Object.freeze([
  "autoCollapseGroups",
  "defaultGroupPinned",
  "defaultInitiativeMode",
  "visibilitySyncMode",
  "moraleEnabled",
  "moraleStatusEffect",
  "moraleMobConfidenceDivisor",
  "moraleEffectDuration",
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
    isEnabled: isDiagnosticsGateOpen,
    actions: Object.freeze({
      getStatus,
      validateSettings,
      validateData,
      validateAssets,
      runSmokeTests,
      collectClientDiagnostics,
      runAutomation,
      cleanupFixtures,
    }),
  });

  api.diagnostics = diagnostics;
  return diagnostics;
}

function assertDiagnosticsAvailable() {
  if (!isGM()) {
    throw new Error("Access denied: diagnostics require a GM user.");
  }

  if (!isDiagnosticsGateOpen()) {
    throw new Error("Diagnostics require Foundry MCP Bridge developer tools to be enabled.");
  }
}

function isDiagnosticsGateOpen() {
  try {
    return !!game.settings.get(MCP_BRIDGE_ID, "enableDeveloperTools");
  } catch {
    return false;
  }
}

function getDiagnosticsGate() {
  const allowMutatingDiagnostics = getSettingValue("allowMutatingDiagnostics") === true;

  return {
    gmUser: !!game.user?.isGM,
    mcpBridgeActive: !!game.modules.get(MCP_BRIDGE_ID)?.active,
    mcpDeveloperTools: isDiagnosticsGateOpen(),
    allowMutatingDiagnostics,
    enabled: !!game.user?.isGM && isDiagnosticsGateOpen(),
    mutationEnabled: !!game.user?.isGM && isDiagnosticsGateOpen() && allowMutatingDiagnostics,
  };
}

function getAvailableActions() {
  return [
    "cleanupFixtures",
    "collectClientDiagnostics",
    "getStatus",
    "runAutomation",
    "runSmokeTests",
    "validateAssets",
    "validateData",
    "validateSettings",
  ];
}

function getReadOnlyActions() {
  return ["collectClientDiagnostics", "getStatus", "runSmokeTests", "validateAssets", "validateData", "validateSettings"];
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
  if (!isDiagnosticsGateOpen()) return;

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

  return {
    success: true,
    module: summarizeModule(),
    diagnostics: {
      version: 1,
      gate: getDiagnosticsGate(),
      availableActions: getAvailableActions(),
      readOnlyActions: getReadOnlyActions(),
      mutatingActions: getMutatingActions(),
      fixturePrefix: FIXTURE_PREFIX,
      fixtureFlag: FIXTURE_FLAG,
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
      "Mutating diagnostics are enabled; disable this outside active MCP fixture testing.",
      true
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

  const failures = tests.filter((test) => !test.pass);
  return {
    success: failures.length === 0,
    passed: tests.length - failures.length,
    failed: failures.length,
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

async function runAutomation(args = {}) {
  assertMutatingDiagnosticsAvailable(args);
  assertActiveSceneReady();

  const runId = normalizeRunId(args.runId) ?? foundry.utils.randomID(8);
  const marker = createFixtureMarker(runId, "runAutomation");
  const scene = canvas.scene;
  const cleanupAfter = args.cleanupAfter !== false;
  const cleanupBefore = args.cleanupBefore !== false;
  const previousCombatId = game.combat?.id ?? null;
  const previousSettings = captureSettings(MUTATION_SETTING_KEYS);
  const beforeCounts = getWorldDocumentCounts(scene);
  const steps = [];
  const state = {
    runId,
    marker,
    scene,
    actors: [],
    tokens: [],
    combat: null,
    combatants: [],
    groups: [],
  };

  let chatHook = null;
  let cleanupBeforeResult = null;
  let cleanupAfterResult = null;
  let restoreError = null;
  let failure = null;

  try {
    chatHook = installFixtureChatMarker(marker);

    if (cleanupBefore) {
      cleanupBeforeResult = await cleanupFixturesInternal({ scene, runId: null });
    }

    await runAutomationStep(steps, "configure automation settings", async () => {
      await applyAutomationSettings();
      return { settings: captureSettings(MUTATION_SETTING_KEYS) };
    });

    await runAutomationStep(steps, "create fixture actors and tokens", async () => {
      state.actors = await createFixtureActors(marker);
      state.tokens = await createFixtureTokens(scene, state.actors, marker);
      return {
        actors: state.actors.map((actor) => actor.id),
        tokens: state.tokens.map((token) => token.id),
      };
    });

    await runAutomationStep(steps, "create and activate fixture combat", async () => {
      state.combat = await createFixtureCombat(scene, state.tokens, marker);
      state.combatants = Array.from(state.combat.combatants);
      await state.combat.activate();
      return {
        combatId: state.combat.id,
        combatants: state.combatants.map((combatant) => combatant.id),
        previousCombatId,
      };
    });

    await runAutomationStep(steps, "create group and assign combatants", async () => {
      const groupId = await GroupManager.createGroup(state.combat, {
        name: fixtureName(runId, "Alpha"),
        img: "icons/svg/combat.svg",
        color: "#33aaff",
        pinned: false,
        hidden: false,
        initiativeMode: INITIATIVE_MODE.AVERAGE,
        moraleTrigger: MORALE_TRIGGER.BOTH,
        discipline: DISCIPLINE.STANDARD,
      }, []);
      await markFixtureGroup(state.combat, groupId, marker);
      state.groups.push(groupId);
      await GroupManager.addCombatantsToGroup(
        state.combat,
        groupId,
        state.combatants.slice(0, 2).map((combatant) => combatant.id)
      );
      return { groupId, memberCount: 2 };
    });

    await runAutomationStep(steps, "edit group and set remove and restore captain", async () => {
      const groupId = state.groups[0];
      const captainId = state.combatants[0].id;
      await GroupManager.editGroup(state.combat, groupId, {
        name: fixtureName(runId, "Alpha Edited"),
        color: "#44cc88",
        initiativeMode: INITIATIVE_MODE.HIGHEST,
        moraleTrigger: MORALE_TRIGGER.BOTH,
        discipline: DISCIPLINE.STANDARD,
      });
      await markFixtureGroup(state.combat, groupId, marker);
      await GroupManager.setCaptain(state.combat, groupId, captainId);
      await GroupManager.removeCaptain(state.combat, groupId);
      const removedCaptain = state.combat.getFlag(MODULE_ID, `groups.${groupId}.captainId`);
      assertAutomationCondition(removedCaptain === null, "Captain was not removed from the fixture group.", { removedCaptain });
      await GroupManager.setCaptain(state.combat, groupId, captainId);
      const restoredCaptain = state.combat.getFlag(MODULE_ID, `groups.${groupId}.captainId`);
      assertAutomationCondition(restoredCaptain === captainId, "Captain was not restored on the fixture group.", { restoredCaptain, captainId });
      return { groupId, captainId, removedCaptain, restoredCaptain };
    });

    await runAutomationStep(steps, "set reset and roll group initiative modes", async () => {
      const groupId = state.groups[0];
      await GroupManager.setGroupInitiative(state.combat, groupId, 14);
      const results = [];
      for (const mode of ["normal", "advantage", "disadvantage"]) {
        await GroupManager.resetGroupInitiative(state.combat, groupId);
        await GroupManager.rollGroupAndApplyInitiative(state.combat, groupId, { mode });
        const group = state.combat.getFlag(MODULE_ID, `groups.${groupId}`);
        assertAutomationCondition(Number.isFinite(group?.initiative), "Group initiative roll did not produce a finite initiative.", { mode, initiative: group?.initiative ?? null });
        results.push({ mode, initiative: group.initiative });
      }
      return { groupId, results };
    });

    await runAutomationStep(steps, "toggle visibility in all sync modes", async () => {
      const groupId = state.groups[0];
      const results = [];
      for (const [mode, expectTokenSync] of [
        [VISIBILITY_SYNC_MODE.BIDIRECTIONAL, true],
        [VISIBILITY_SYNC_MODE.TRACKER_ONLY, false],
        [VISIBILITY_SYNC_MODE.NONE, false],
      ]) {
        await game.settings.set(MODULE_ID, "visibilitySyncMode", mode);
        const before = getGroupTokenHiddenStates(state.scene, state.combat, groupId);
        assertTokenHiddenStates(before, false, `Fixture tokens should be visible before ${mode} visibility toggle.`);

        const hidden = await GroupManager.toggleGroupVisibility(state.combat, groupId);
        const afterHide = getGroupTokenHiddenStates(state.scene, state.combat, groupId);
        assertAutomationCondition(hidden === true, "Group visibility toggle did not hide the group.", { mode, hidden });
        assertTokenHiddenStates(afterHide, expectTokenSync, `Unexpected token hidden state after ${mode} hide toggle.`);

        const visible = await GroupManager.toggleGroupVisibility(state.combat, groupId);
        const afterShow = getGroupTokenHiddenStates(state.scene, state.combat, groupId);
        assertAutomationCondition(visible === false, "Group visibility toggle did not show the group.", { mode, visible });
        assertTokenHiddenStates(afterShow, false, `Fixture tokens should be visible after ${mode} show toggle.`);

        results.push({ mode, tokenSyncExpected: expectTokenSync, hiddenResult: hidden, visibleResult: visible });
      }
      await game.settings.set(MODULE_ID, "visibilitySyncMode", VISIBILITY_SYNC_MODE.BIDIRECTIONAL);
      return { groupId, results };
    });

    await runAutomationStep(steps, "remove combatant and delete a fixture group", async () => {
      const groupId = state.groups[0];
      const transientCombatantId = state.combatants[2].id;
      await GroupManager.addCombatantsToGroup(state.combat, groupId, [transientCombatantId]);
      await GroupManager.removeCombatantFromGroup(state.combat, transientCombatantId);

      const deleteGroupId = await GroupManager.createGroup(state.combat, {
        name: fixtureName(runId, "Delete Me"),
        img: "icons/svg/skull.svg",
        color: "#dd5555",
        pinned: false,
        hidden: false,
      }, []);
      await markFixtureGroup(state.combat, deleteGroupId, marker);
      await GroupManager.addCombatantsToGroup(state.combat, deleteGroupId, [transientCombatantId]);
      const deleted = await GroupManager.deleteGroup(state.combat, deleteGroupId, { confirm: false });
      return { groupId, transientCombatantId, deleteGroupId, deleted };
    });

    await runAutomationStep(steps, "auto-group remaining fixture combatants", async () => {
      const result = await GroupManager.autoGroupCombatants(state.combat, {
        combatants: state.combatants.slice(2),
        groupBy: "disposition",
        includeGrouped: false,
        includeSingletons: true,
      });

      let index = 1;
      for (const groupId of result.groupIds) {
        await GroupManager.editGroup(state.combat, groupId, {
          name: fixtureName(runId, `Auto ${index}`),
          color: "#aa77ff",
        });
        await markFixtureGroup(state.combat, groupId, marker);
        state.groups.push(groupId);
        index += 1;
      }

      return result;
    });

    await runAutomationStep(steps, "roll morale rally and clear morale", async () => {
      const groupId = state.groups[0];
      await MoraleManager.rollMorale(state.combat, groupId);
      const target = state.combat.combatants.get(state.combatants[0].id);
      await target.setFlag(MODULE_ID, "moraleStatus", "failed");
      await MoraleManager.applyMoraleEffect(target);
      const rallyResult = await MoraleManager.rallyMorale(state.combat, groupId, target.id);
      await MoraleManager.clearMorale(state.combat, groupId);
      return {
        groupId,
        targetId: target.id,
        rallyAttempted: !!rallyResult,
      };
    });

    await runAutomationStep(steps, "validate fixture combat data", async () => {
      const validation = await validateData({ combatId: state.combat.id });
      if (validation.errors.length) {
        throw new Error(`Fixture validation failed with ${validation.errors.length} error(s).`);
      }
      return validation.checked;
    });
  } catch (err) {
    failure = serializeError(err);
  } finally {
    if (chatHook) Hooks.off("preCreateChatMessage", chatHook);

    try {
      await restoreSettings(previousSettings);
      await restorePreviousCombat(previousCombatId, state.combat);
    } catch (err) {
      restoreError = serializeError(err);
    }

    if (cleanupAfter) {
      try {
        cleanupAfterResult = await cleanupFixturesInternal({ scene, runId: null });
      } catch (err) {
        cleanupAfterResult = {
          success: false,
          error: serializeError(err),
        };
      }
    }
  }

  const afterCounts = getWorldDocumentCounts(scene);
  const remainingFixtures = getFixtureCounts(scene);
  const documentCountDelta = getDocumentCountDelta(beforeCounts, afterCounts);
  const cleanupVerified = !cleanupAfter || Object.values(remainingFixtures).every((count) => count === 0);
  const restoredSettings = captureSettings(MUTATION_SETTING_KEYS);
  const settingsRestored = settingsMatch(previousSettings, restoredSettings);
  const previousCombatRestored = previousCombatId
    ? game.combat?.id === previousCombatId
    : game.combat?.id !== state.combat?.id;
  const failedSteps = steps.filter((step) => !step.pass);
  const success = !failure
    && !restoreError
    && !failedSteps.length
    && cleanupAfterResult?.success !== false
    && cleanupVerified
    && settingsRestored
    && previousCombatRestored;

  return {
    success,
    runId,
    fixturePrefix: FIXTURE_PREFIX,
    beforeCounts,
    afterCounts,
    documentCountDelta,
    cleanupBefore: cleanupBeforeResult,
    cleanupAfter: cleanupAfterResult,
    cleanupVerified,
    remainingFixtures,
    restored: {
      settings: !restoreError && settingsRestored,
      previousCombatId,
      previousCombat: previousCombatRestored,
    },
    failure,
    restoreError,
    steps,
  };
}

async function cleanupFixtures(args = {}) {
  assertMutatingDiagnosticsAvailable(args);
  assertActiveSceneReady();

  const scene = canvas?.scene ?? null;
  const runId = normalizeRunId(args.runId);
  return cleanupFixturesInternal({ scene, runId });
}

function assertMutatingDiagnosticsAvailable(args = {}) {
  assertDiagnosticsAvailable();

  if (getSettingValue("allowMutatingDiagnostics") !== true) {
    throw new Error("Mutating diagnostics are disabled. Enable the Allow Mutating MCP Diagnostics setting first.");
  }

  if (args.confirmMutation !== true) {
    throw new Error("Mutating diagnostics require confirmMutation: true.");
  }
}

function assertActiveSceneReady() {
  if (!canvas?.scene) {
    throw new Error("Mutating diagnostics require an active scene.");
  }

  if (!canvas.ready) {
    throw new Error("Mutating diagnostics require the active canvas to be ready.");
  }
}

async function runAutomationStep(steps, name, fn) {
  const startedAt = Date.now();
  try {
    const details = await fn();
    steps.push({
      name,
      pass: true,
      durationMs: Date.now() - startedAt,
      details: details ?? null,
    });
  } catch (err) {
    steps.push({
      name,
      pass: false,
      durationMs: Date.now() - startedAt,
      error: serializeError(err),
    });
    throw err;
  }
}

function assertAutomationCondition(condition, message, details = null) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

function getGroupTokenHiddenStates(scene, combat, groupId) {
  const members = combat.combatants.filter((combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId);
  return members.map((combatant) => {
    const token = scene?.tokens?.get?.(combatant.tokenId) ?? null;
    return {
      combatantId: combatant.id,
      tokenId: combatant.tokenId,
      hidden: token?.hidden ?? null,
    };
  });
}

function assertTokenHiddenStates(states, expectedHidden, message) {
  const mismatches = states.filter((state) => state.hidden !== expectedHidden);
  assertAutomationCondition(states.length > 0 && mismatches.length === 0, message, {
    expectedHidden,
    states,
    mismatches,
  });
}

function normalizeRunId(value) {
  if (value === undefined || value === null || value === "") return null;
  const runId = String(value).trim();
  if (!ID_PATTERN.test(runId)) {
    throw new Error("runId contains unsupported characters.");
  }
  return runId;
}

function fixtureName(runId, label) {
  return `${FIXTURE_PREFIX} ${runId} ${label}`;
}

function createFixtureMarker(runId, action) {
  return {
    runId,
    action,
    fixtureName: fixtureName(runId, action),
    worldId: game.world?.id ?? null,
    sceneId: canvas?.scene?.id ?? null,
    createdAt: new Date().toISOString(),
  };
}

function withFixtureFlag(data, marker) {
  return foundry.utils.mergeObject(data, {
    flags: {
      [MODULE_ID]: {
        [FIXTURE_FLAG]: marker,
      },
    },
  }, { inplace: false });
}

function captureSettings(keys) {
  const settings = {};
  for (const key of keys) {
    settings[key] = getSettingValue(key);
  }
  return settings;
}

async function applyAutomationSettings() {
  const updates = {
    autoCollapseGroups: true,
    defaultGroupPinned: false,
    defaultInitiativeMode: INITIATIVE_MODE.AVERAGE,
    visibilitySyncMode: VISIBILITY_SYNC_MODE.BIDIRECTIONAL,
    moraleEnabled: true,
    moraleStatusEffect: "frightened",
    moraleMobConfidenceDivisor: 1,
    moraleEffectDuration: 1,
  };

  for (const [key, value] of Object.entries(updates)) {
    await game.settings.set(MODULE_ID, key, value);
  }
}

async function restoreSettings(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value && typeof value === "object" && "error" in value) continue;
    await game.settings.set(MODULE_ID, key, value);
  }
}

function settingsMatch(expected, actual) {
  return Object.entries(expected).every(([key, value]) => {
    if (value && typeof value === "object" && "error" in value) return true;
    return actual[key] === value;
  });
}

function getDocumentCountDelta(beforeCounts, afterCounts) {
  const delta = {};
  for (const key of Object.keys(beforeCounts)) {
    delta[key] = (afterCounts[key] ?? 0) - (beforeCounts[key] ?? 0);
  }
  return delta;
}

function installFixtureChatMarker(marker) {
  const hook = (message, data = {}) => {
    const searchable = [
      data.content,
      data.flavor,
      data.speaker?.alias,
      message?.content,
      message?.flavor,
      message?.speaker?.alias,
    ].filter(Boolean).join(" ");

    if (!searchable.includes(FIXTURE_PREFIX)) return;
    message.updateSource({
      [`flags.${MODULE_ID}.${FIXTURE_FLAG}`]: marker,
    });
  };

  Hooks.on("preCreateChatMessage", hook);
  return hook;
}

async function createFixtureActors(marker) {
  const actorData = [
    { label: "Alpha", dex: 14, wis: 10, hp: 12, cr: 0.25 },
    { label: "Bravo", dex: 12, wis: 12, hp: 11, cr: 0.25 },
    { label: "Charlie", dex: 10, wis: 8, hp: 10, cr: 0.125 },
    { label: "Delta", dex: 16, wis: 10, hp: 9, cr: 0.125 },
  ].map((entry) => withFixtureFlag({
    name: fixtureName(marker.runId, entry.label),
    type: "npc",
    img: "icons/svg/mystery-man.svg",
    system: {
      abilities: {
        dex: { value: entry.dex },
        wis: { value: entry.wis },
      },
      attributes: {
        hp: { value: entry.hp, max: entry.hp },
      },
      details: {
        cr: entry.cr,
      },
    },
  }, marker));

  return Actor.createDocuments(actorData);
}

async function createFixtureTokens(scene, actors, marker) {
  const tokenData = actors.map((actor, index) => withFixtureFlag({
    name: actor.name,
    actorId: actor.id,
    actorLink: false,
    x: 100 + (index * 110),
    y: 100,
    width: 1,
    height: 1,
    disposition: CONST.TOKEN_DISPOSITIONS.HOSTILE,
    texture: { src: actor.img },
  }, marker));

  return scene.createEmbeddedDocuments("Token", tokenData);
}

async function createFixtureCombat(scene, tokens, marker) {
  const combat = await game.combats.documentClass.create(withFixtureFlag({
    scene: scene.id,
    active: false,
  }, marker));

  await combat.createEmbeddedDocuments("Combatant", tokens.map((token, index) => {
    const data = withFixtureFlag({
      tokenId: token.id,
      actorId: token.actorId,
      sceneId: scene.id,
      hidden: false,
      sort: (index + 1) * 100,
    }, marker);
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.groupId`, UNGROUPED);
    return data;
  }));

  return combat;
}

async function markFixtureGroup(combat, groupId, marker) {
  if (!combat || !groupId) return;
  await combat.setFlag(MODULE_ID, `groups.${groupId}.${FIXTURE_FLAG}`, marker);
}

async function restorePreviousCombat(previousCombatId, fixtureCombat) {
  const previousCombat = previousCombatId ? game.combats.get(previousCombatId) : null;
  if (previousCombat) {
    await previousCombat.activate();
    return;
  }

  if (fixtureCombat && game.combat?.id === fixtureCombat.id && typeof fixtureCombat.update === "function") {
    await fixtureCombat.update({ active: false });
  }
}

async function cleanupFixturesInternal({ scene = canvas?.scene ?? null, runId = null } = {}) {
  const sceneId = scene?.id ?? null;
  const beforeCounts = getWorldDocumentCounts(scene);
  const deleted = {
    chatMessages: 0,
    groupFlags: 0,
    combats: 0,
    tokens: 0,
    actors: 0,
  };
  const warnings = [];

  const messages = Array.from(game.messages ?? []).filter((message) => isFixtureDocument(message, runId, sceneId));
  for (const message of messages) {
    await message.delete();
    deleted.chatMessages += 1;
  }

  const sceneCombats = getSceneCombats(scene);
  for (const combat of sceneCombats.filter((candidate) => !isFixtureDocument(candidate, runId, sceneId))) {
    const groups = combat.getFlag(MODULE_ID, "groups") ?? {};
    const updateData = {};
    const combatantUpdates = [];

    for (const [groupId, group] of Object.entries(groups)) {
      if (!isFixtureGroup(group, runId, sceneId)) continue;
      updateData[`flags.${MODULE_ID}.groups.-=${groupId}`] = null;
      deleted.groupFlags += 1;

      for (const combatant of combat.combatants.filter((candidate) => candidate.getFlag(MODULE_ID, "groupId") === groupId)) {
        if (isFixtureDocument(combatant, runId, sceneId)) {
          combatantUpdates.push({ _id: combatant.id, [`flags.${MODULE_ID}.-=groupId`]: null });
        } else {
          warnings.push(`Skipped non-fixture combatant "${combatant.name}" in fixture group "${groupId}".`);
        }
      }
    }

    if (Object.keys(updateData).length) await combat.update(updateData);
    if (combatantUpdates.length) await combat.updateEmbeddedDocuments("Combatant", combatantUpdates);
  }

  const combats = sceneCombats.filter((combat) => isFixtureDocument(combat, runId, sceneId));
  for (const combat of combats) {
    await combat.delete();
    deleted.combats += 1;
  }

  if (scene) {
    const tokenIds = Array.from(scene.tokens ?? [])
      .filter((token) => isFixtureDocument(token, runId, sceneId))
      .map((token) => token.id);
    if (tokenIds.length) {
      await scene.deleteEmbeddedDocuments("Token", tokenIds);
      deleted.tokens += tokenIds.length;
    }
  }

  const actors = Array.from(game.actors ?? []).filter((actor) => isFixtureDocument(actor, runId, sceneId));
  for (const actor of actors) {
    await actor.delete();
    deleted.actors += 1;
  }

  const afterCounts = getWorldDocumentCounts(scene);

  return {
    success: true,
    runId,
    fixturePrefix: FIXTURE_PREFIX,
    beforeCounts,
    afterCounts,
    deleted,
    warnings,
    remainingFixtures: getFixtureCounts(scene, runId),
  };
}

function getWorldDocumentCounts(scene = canvas?.scene ?? null) {
  return {
    actors: game.actors?.size ?? 0,
    scenes: game.scenes?.size ?? 0,
    combats: game.combats?.size ?? 0,
    activeSceneTokens: scene?.tokens?.size ?? 0,
    chatMessages: game.messages?.size ?? 0,
  };
}

function getFixtureCounts(scene = canvas?.scene ?? null, runId = null) {
  if (!scene) {
    return {
      actors: 0,
      activeSceneTokens: 0,
      activeSceneCombats: 0,
      chatMessages: 0,
      groupFlags: 0,
    };
  }

  const sceneId = scene.id;
  const sceneCombats = getSceneCombats(scene);

  return {
    actors: Array.from(game.actors ?? []).filter((actor) => isFixtureDocument(actor, runId, sceneId)).length,
    activeSceneTokens: Array.from(scene.tokens ?? []).filter((token) => isFixtureDocument(token, runId, sceneId)).length,
    activeSceneCombats: sceneCombats.filter((combat) => isFixtureDocument(combat, runId, sceneId)).length,
    chatMessages: Array.from(game.messages ?? []).filter((message) => isFixtureDocument(message, runId, sceneId)).length,
    groupFlags: sceneCombats.reduce((count, combat) => {
      const groups = combat.getFlag(MODULE_ID, "groups") ?? {};
      return count + Object.values(groups).filter((group) => isFixtureGroup(group, runId, sceneId)).length;
    }, 0),
  };
}

function getSceneCombats(scene) {
  if (!scene) return [];
  return Array.from(game.combats?.values?.() ?? []).filter((combat) => {
    const sceneId = combat.scene?.id ?? combat.sceneId ?? combat.scene;
    return sceneId === scene.id;
  });
}

function getFixtureMarker(document) {
  return document?.getFlag?.(MODULE_ID, FIXTURE_FLAG) ?? null;
}

function isFixtureDocument(document, runId = null, sceneId = null) {
  const marker = getFixtureMarker(document);
  if (!isFixtureMarker(marker, runId, sceneId)) return false;
  return hasFixturePrefix(document, marker);
}

function isFixtureGroup(group, runId = null, sceneId = null) {
  const marker = group?.[FIXTURE_FLAG] ?? null;
  if (!isFixtureMarker(marker, runId, sceneId)) return false;
  return String(group?.name ?? "").startsWith(FIXTURE_PREFIX)
    && String(marker.fixtureName ?? "").startsWith(FIXTURE_PREFIX);
}

function isFixtureMarker(marker, runId = null, sceneId = null) {
  if (!marker || typeof marker !== "object") return false;
  if (runId && marker.runId !== runId) return false;
  if (sceneId && marker.sceneId !== sceneId) return false;
  return marker.worldId === (game.world?.id ?? null)
    && String(marker.fixtureName ?? "").startsWith(FIXTURE_PREFIX);
}

function hasFixturePrefix(document, marker) {
  const name = String(document?.name ?? "");
  const content = String(document?.content ?? "");
  const flavor = String(document?.flavor ?? "");
  const alias = String(document?.speaker?.alias ?? "");
  const markerName = String(marker?.fixtureName ?? "");

  return name.startsWith(FIXTURE_PREFIX)
    || markerName.startsWith(FIXTURE_PREFIX)
    || content.includes(FIXTURE_PREFIX)
    || flavor.includes(FIXTURE_PREFIX)
    || alias.includes(FIXTURE_PREFIX);
}

function serializeError(err) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      details: err.details ?? null,
      stack: err.stack?.split("\n").slice(0, 6).join("\n"),
    };
  }
  return { message: String(err) };
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
