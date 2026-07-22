/**
 * @file shared.js
 * @description Core constants, utility functions, and shared state management for Squad Combat Initiative.
 * @version Foundry V14+
 */

/* ========================================================================== */
/*   STATE ARCHITECTURE                                                       */
/* ========================================================================== */

/**
 * This module uses a three-layer state model:
 *
 * 1. **Foundry Flags** (source of truth): Group data, membership, and initiative
 *    values. Synced across all clients via Foundry's document system.
 *    - `combat.flags.squad-combat-initiative.groups.{groupId}` — group metadata
 *    - `combatant.flags.squad-combat-initiative.groupId` — group membership
 *
 * 2. **localStorage** (UI state only): Expanded/collapsed group state per combat.
 *    Client-local, not shared between users. Handles stale/missing data gracefully
 *    via {@link expandStore}.
 *
 * 3. **In-memory** (transient): per-combat initiative queues,
 *    `visibilitySyncInProgress`, `_isRenderingGroups`. Session-scoped, reset on page reload. Used to prevent
 *    recursive or redundant operations during batch updates.
 */

/* ========================================================================== */
/*   TYPE DEFINITIONS                                                         */
/* ========================================================================== */

/**
 * @typedef {Object} GroupData
 * @property {string} name - The display name of the group
 * @property {number|null} [initiative] - The calculated group initiative value
 * @property {boolean} [pinned] - If true, this group stays expanded/pinned in the UI
 * @property {string} [img] - Path to the group icon/image
 * @property {string} [color] - Hex color code for the group styling
 * @property {boolean} [hidden] - Whether the group is hidden from players
 * @property {string} [initiativeMode] - One of INITIATIVE_MODE values (default: "average")
 * @property {string|null} [captainId] - Combatant ID of the group captain
 */

/**
 * @typedef {Object} GroupMemberData
 * @property {string} name - Combatant name
 * @property {number} init - Combatant initiative
 * @property {number} dex - Combatant dexterity score (for tie-breaking)
 * @property {Combatant} combatant - The actual Foundry Combatant document
 */

/* ========================================================================== */
/*   CONSTANTS & IDENTIFIERS                                                  */
/* ========================================================================== */

/**
 * Unique identifier for the module.
 * @type {string}
 */
export const MODULE_ID = "squad-combat-initiative";

/**
 * Handlebars template paths used for dialogs and chat cards.
 * Preloaded during `ready` via {@link preloadTemplates}.
 * @readonly
 * @enum {string}
 */
export const TEMPLATES = Object.freeze({
  GROUP_FORM: `modules/${MODULE_ID}/templates/dialogs/group-form.hbs`,
  AUTO_GROUP: `modules/${MODULE_ID}/templates/dialogs/auto-group.hbs`,
  TEXT_PROMPT: `modules/${MODULE_ID}/templates/dialogs/text-prompt.hbs`,
  CHAT_INITIATIVE_SUMMARY: `modules/${MODULE_ID}/templates/chat/initiative-summary.hbs`,
  CHAT_MORALE_CHECK: `modules/${MODULE_ID}/templates/chat/morale-check.hbs`,
  CHAT_MORALE_SINGLE: `modules/${MODULE_ID}/templates/chat/morale-single.hbs`,
  CHAT_RALLY: `modules/${MODULE_ID}/templates/chat/rally.hbs`,
  CHAT_MORALE_PROMPT: `modules/${MODULE_ID}/templates/chat/morale-prompt.hbs`,
  CHAT_CAPTAIN_DEATH: `modules/${MODULE_ID}/templates/chat/captain-death.hbs`,
  CHAT_FEARLESS: `modules/${MODULE_ID}/templates/chat/fearless.hbs`,
});

/**
 * Render a module Handlebars template.
 * @param {string} template - One of {@link TEMPLATES}
 * @param {Object} data - Template context
 * @returns {Promise<string>}
 */
export function renderModuleTemplate(template, data) {
  return foundry.applications.handlebars.renderTemplate(template, data);
}

/**
 * Preload all module templates so chat/dialog rendering is fast.
 * @returns {Promise<Function[]>}
 */
export function preloadTemplates() {
  return foundry.applications.handlebars.loadTemplates(Object.values(TEMPLATES));
}

/**
 * Format a numeric modifier with an explicit sign (e.g. +3, -1).
 * @param {number} value
 * @returns {string}
 */
export function formatModifier(value) {
  return value >= 0 ? `+${value}` : `${value}`;
}

/**
 * Localize an enum value against a key prefix, e.g.
 * `localizeEnumValue("SCI.MoraleTrigger", "captainDeath")` → `SCI.MoraleTrigger.CaptainDeath`.
 * @param {string} prefix - Localization key prefix without trailing dot
 * @param {string} value - Enum value (first letter is uppercased)
 * @returns {string}
 */
export function localizeEnumValue(prefix, value) {
  const key = String(value ?? "");
  return game.i18n.localize(`${prefix}.${key.charAt(0).toUpperCase()}${key.slice(1)}`);
}

/**
 * Localized fallback name for groups with no stored name.
 * @returns {string}
 */
export function unnamedGroup() {
  return game.i18n.localize("SCI.UnnamedGroup");
}

/**
 * Build localized initiative-mode `<select>` options for the group form template.
 * @param {string} selected - Currently selected INITIATIVE_MODE value
 * @returns {{value: string, label: string, selected: boolean}[]}
 */
export function buildInitiativeModeOptions(selected) {
  return Object.values(INITIATIVE_MODE).map((value) => ({
    value,
    label: localizeEnumValue("SCI.InitiativeModeLong", value),
    selected: value === selected,
  }));
}

/**
 * Build localized morale-trigger `<select>` options for the group form template.
 * @param {string} selected - Currently selected MORALE_TRIGGER value
 * @returns {{value: string, label: string, selected: boolean}[]}
 */
export function buildMoraleTriggerOptions(selected) {
  return Object.values(MORALE_TRIGGER).map((value) => ({
    value,
    label: localizeEnumValue("SCI.MoraleTrigger", value),
    selected: value === selected,
  }));
}

/**
 * Build localized discipline `<select>` options for the group form template.
 * @param {string} selected - Currently selected discipline value
 * @returns {{value: string, label: string, selected: boolean}[]}
 */
export function buildDisciplineOptions(selected) {
  return ["standard", "expendable", "elite", "fearless"].map((value) => ({
    value,
    label: localizeEnumValue("SCI.Discipline", value),
    selected: value === selected,
  }));
}

/**
 * Initiative calculation mode options for groups.
 * @readonly
 * @enum {string}
 */
export const INITIATIVE_MODE = Object.freeze({
  AVERAGE: "average",
  HIGHEST: "highest",
  LOWEST: "lowest",
  MEDIAN: "median",
  CAPTAIN: "captain",
});

/**
 * Per-group morale trigger mode options.
 * @readonly
 * @enum {string}
 */
export const MORALE_TRIGGER = Object.freeze({
  MANUAL: "manual",
  THRESHOLD: "threshold",
  CAPTAIN_DEATH: "captainDeath",
  BOTH: "both",
});

/**
 * Global constants used for calculations and UI timing.
 * Frozen to prevent accidental mutation.
 */
export const CONSTANTS = Object.freeze({
  // Deprecated ordering constants retained for API compatibility. Initiative
  // ordering no longer rewrites document values with fractional offsets.
  STAGGER_INCREMENT: 0.01,
  SORT_INCREMENT: 100,
  COLLAPSE_ANIMATION_MS: 300,
  COLLAPSE_DELAY_MS: 310,
  RENDER_DEBOUNCE_MS: 50,
  GROUP_RANK_OFFSET: 0.1,
  BULK_ROLL_DELAY_MS: 100,
  TOKEN_HIGHLIGHT_LINE_WIDTH: 4,
  TOKEN_HIGHLIGHT_PADDING: 2,
  TOKEN_HIGHLIGHT_GLOW_EXTRA: 2,
  TOKEN_HIGHLIGHT_GLOW_ALPHA: 0.3,
  TOKEN_HIGHLIGHT_MAIN_ALPHA: 0.9,
  LOG_DEDUP_WINDOW_MS: 100,
  LOG_CACHE_MAX: 50,
  LOG_CACHE_EXPIRY_MS: 1000,
});


/**
 * Guards against infinite loops between the updateToken ↔ updateCombatant sync hooks.
 * Holds combatant IDs currently being synced. Cleared in finally blocks.
 * @type {Set<string>}
 */
export const visibilitySyncInProgress = new Set();

/* ========================================================================== */
/*   LOGGING SYSTEM                                                           */
/* ========================================================================== */

/**
 * @typedef {'off'|'normal'|'verbose'} DebugLevel
 */

/**
 * @typedef {Object} LogContext
 * @property {string} [fn] - Function name
 * @property {Object} [data] - Structured data to log
 */

/**
 * Logger class for structured, readable console output.
 * Supports multiple verbosity levels for debugging.
 */
class Logger {
  /** @type {Map<string, number>} */
  #recentLogs = new Map();

  /** Log level icons for visual scanning */
  static ICONS = Object.freeze({
    debug: "🔍",
    trace: "📋",
    info: "ℹ️",
    warn: "⚠️",
    error: "❌",
    success: "✅",
    start: "▶️",
    end: "⏹️",
  });

  /** Console styling */
  static STYLES = Object.freeze({
    module: "color: #7b68ee; font-weight: bold",
    fn: "color: #4a9eff",
    data: "color: #888",
    success: "color: #4caf50",
    warn: "color: #ff9800",
    error: "color: #f44336",
    trace: "color: #aaa",
  });

  /**
   * Get current debug level from settings.
   * @returns {DebugLevel}
   */
  get level() {
    try {
      return game.settings.get(MODULE_ID, "debugLevel") || "off";
    } catch {
      return "off";
    }
  }

  /**
   * Check if normal debug logging is enabled.
   * @returns {boolean}
   */
  get enabled() {
    return this.level !== "off";
  }

  /**
   * Check if verbose logging is enabled.
   * @returns {boolean}
   */
  get verbose() {
    return this.level === "verbose";
  }

  /**
   * Format context into a readable prefix.
   * @param {LogContext} [ctx]
   * @returns {string}
   */
  #formatContext(ctx) {
    if (!ctx?.fn) return "";
    return `[${ctx.fn}]`;
  }

  /**
   * Format data for structured output.
   * @param {any} data
   * @returns {string}
   */
  #formatData(data) {
    if (data === undefined || data === null) return "";
    if (typeof data === "string") return data;
    try {
      return JSON.stringify(data, this.#replacer.bind(this), 2);
    } catch {
      return String(data);
    }
  }

  /**
   * JSON replacer to handle special types and summarize Foundry objects.
   * @param {string} key
   * @param {any} value
   * @returns {any}
   */
  #replacer(key, value) {
    // Handle Map
    if (value instanceof Map) {
      const summary = {};
      for (const [k, v] of value.entries()) {
        if (v?.members) {
          summary[k] = {
            name: v.name,
            memberCount: v.members.length,
            members: v.members.map(m => m.name || m.id).slice(0, 5),
            ...(v.members.length > 5 ? { _more: v.members.length - 5 } : {}),
          };
        } else {
          summary[k] = v;
        }
      }
      return { _type: "Map", ...summary };
    }
    
    // Handle Set
    if (value instanceof Set) {
      const arr = Array.from(value);
      return arr.length <= 5 
        ? arr 
        : [...arr.slice(0, 5), `+${arr.length - 5} more`];
    }
    
    // Handle Combatant
    if (value?.constructor?.name === "Combatant") {
      return `👤 ${value.name || "Unknown"}${value.initiative != null ? ` (${value.initiative})` : ""}`;
    }
    
    // Handle Combat
    if (value?.constructor?.name === "Combat") {
      return `⚔️ Combat[r${value.round}, ${value.combatants?.size ?? 0} combatants]`;
    }
    
    // Handle Actor
    if (value?.constructor?.name?.includes("Actor")) {
      return `🎭 ${value.name || value.id}`;
    }
    
    // Handle Token
    if (value?.constructor?.name?.includes("Token")) {
      return `🎯 ${value.name || value.id}`;
    }
    
    // Handle arrays of Combatants
    if (Array.isArray(value) && value.length > 0 && value[0]?.constructor?.name === "Combatant") {
      return value.length <= 3
        ? value.map(c => `👤 ${c.name}`)
        : [`${value.length} combatants:`, ...value.slice(0, 3).map(c => c.name), `+${value.length - 3} more`];
    }
    
    // Skip noisy internal properties
    if (["_stats", "system", "prototypeToken", "effects", "items", "folder", "flags"].includes(key)) {
      return undefined;
    }
    
    return value;
  }

  /**
   * Check for duplicate log within time window.
   * @param {string} key
   * @returns {boolean} True if duplicate
   */
  #isDuplicate(key) {
    const now = Date.now();
    const lastTime = this.#recentLogs.get(key);
    
    if (lastTime && (now - lastTime) < CONSTANTS.LOG_DEDUP_WINDOW_MS) {
      return true;
    }
    
    this.#recentLogs.set(key, now);
    
    // Cleanup old entries
    if (this.#recentLogs.size > CONSTANTS.LOG_CACHE_MAX) {
      for (const [k, t] of this.#recentLogs) {
        if (now - t > CONSTANTS.LOG_CACHE_EXPIRY_MS) this.#recentLogs.delete(k);
      }
    }
    
    return false;
  }

  /**
   * Core logging method.
   * @param {'debug'|'trace'|'info'|'warn'|'error'} level
   * @param {string} message
   * @param {LogContext} [ctx]
   */
  #log(level, message, ctx) {
    const icon = Logger.ICONS[level] || "";
    const context = this.#formatContext(ctx);
    const prefix = `${icon} [${MODULE_ID}]${context}`;
    
    const consoleFn = level === "error" ? console.error 
                    : level === "warn" ? console.warn 
                    : console.log;

    const style = level === "error" ? Logger.STYLES.error 
                : level === "warn" ? Logger.STYLES.warn 
                : level === "trace" ? Logger.STYLES.trace
                : "";

    consoleFn(`%c${prefix}%c ${message}`, Logger.STYLES.module, style);

    if (ctx?.data !== undefined) {
      const formatted = this.#formatData(ctx.data);
      if (formatted) {
        consoleFn(`%c    ↳ ${formatted}`, Logger.STYLES.data);
      }
    }
  }

  /**
   * Trace log - only in verbose mode, for granular details.
   * @param {string} message
   * @param {LogContext} [ctx]
   */
  trace(message, ctx) {
    if (!this.verbose) return;
    
    const key = `${ctx?.fn || ""}:${message}`;
    if (this.#isDuplicate(key)) return;
    
    this.#log("trace", message, ctx);
  }

  /**
   * Debug log - normal mode and above.
   * @param {string} message
   * @param {LogContext} [ctx]
   */
  debug(message, ctx) {
    if (!this.enabled) return;
    
    const key = `${ctx?.fn || ""}:${message}`;
    if (this.#isDuplicate(key)) return;
    
    this.#log("debug", message, ctx);
  }

  /**
   * Info log - always shown when logging enabled.
   * @param {string} message
   * @param {LogContext} [ctx]
   */
  info(message, ctx) {
    if (!this.enabled) return;
    this.#log("info", message, ctx);
  }

  /**
   * Warning log - always shown.
   * @param {string} message
   * @param {LogContext} [ctx]
   */
  warn(message, ctx) {
    this.#log("warn", message, ctx);
  }

  /**
   * Error log - always shown.
   * @param {string} message
   * @param {Error} [error]
   * @param {LogContext} [ctx]
   */
  error(message, error, ctx) {
    this.#log("error", message, ctx);
    if (error?.stack) {
      console.error(`%c    ↳ ${error.stack}`, Logger.STYLES.data);
    }
  }

  /**
   * Success log - shown in normal mode and above.
   * @param {string} message
   * @param {LogContext} [ctx]
   */
  success(message, ctx) {
    if (!this.enabled) return;
    const icon = Logger.ICONS.success;
    const context = this.#formatContext(ctx);
    console.log(
      `%c${icon} [${MODULE_ID}]${context}%c ${message}`,
      Logger.STYLES.module,
      Logger.STYLES.success
    );
  }

  /**
   * Start a grouped operation.
   * @param {string} operation
   * @param {LogContext} [ctx]
   */
  groupStart(operation, ctx) {
    if (!this.enabled) return;
    const icon = Logger.ICONS.start;
    const context = this.#formatContext(ctx);
    console.group(`%c${icon} [${MODULE_ID}]${context}%c ${operation}`, Logger.STYLES.module, "");
    if (ctx?.data !== undefined) {
      console.log(`%c    ↳ ${this.#formatData(ctx.data)}`, Logger.STYLES.data);
    }
  }

  /**
   * End a grouped operation.
   * @param {string} [result]
   */
  groupEnd(result) {
    if (!this.enabled) return;
    if (result) {
      console.log(
        `%c${Logger.ICONS.end} [${MODULE_ID}]%c → ${result}`,
        Logger.STYLES.module,
        Logger.STYLES.success
      );
    }
    console.groupEnd();
  }

  /**
   * Log and show UI notification for errors.
   * @param {string} message
   * @param {Error} [error]
   * @param {LogContext} [ctx]
   */
  errorNotify(message, error, ctx) {
    this.error(message, error, ctx);
    ui.notifications?.error(`${MODULE_ID}: ${message}`);
  }

  /**
   * Create a scoped logger with preset function context.
   * @param {string} fnName
   * @returns {ScopedLogger}
   */
  fn(fnName) {
    return new ScopedLogger(this, fnName);
  }
}

/**
 * Scoped logger with preset function context.
 */
class ScopedLogger {
  #logger;
  #fnName;

  constructor(logger, fnName) {
    this.#logger = logger;
    this.#fnName = fnName;
  }

  get verbose() { return this.#logger.verbose; }
  
  trace(msg, data) { this.#logger.trace(msg, { fn: this.#fnName, data }); }
  debug(msg, data) { this.#logger.debug(msg, { fn: this.#fnName, data }); }
  info(msg, data) { this.#logger.info(msg, { fn: this.#fnName, data }); }
  warn(msg, data) { this.#logger.warn(msg, { fn: this.#fnName, data }); }
  error(msg, err, data) { this.#logger.error(msg, err, { fn: this.#fnName, data }); }
  errorNotify(msg, err, data) { this.#logger.errorNotify(msg, err, { fn: this.#fnName, data }); }
  success(msg, data) { this.#logger.success(msg, { fn: this.#fnName, data }); }
  groupStart(op, data) { this.#logger.groupStart(op, { fn: this.#fnName, data }); }
  groupEnd(result) { this.#logger.groupEnd(result); }
}

/** Singleton logger instance */
export const logger = new Logger();

/* ========================================================================== */
/*   UTILITIES                                                                */
/* ========================================================================== */

/**
 * Generates a unique ID for a new group.
 * @returns {string}
 */
export function generateGroupId() {
  return "gr-" + foundry.utils.randomID();
}

/**
 * Checks if the current user has GM permissions.
 * @returns {boolean}
 */
export function isGM() {
  return !!game.user?.isGM;
}

/**
 * Checks if the current user can manage groups (GM or Assistant).
 * @returns {boolean}
 */
export function canManageGroups() {
  return game.user?.isGM || game.user?.role >= CONST.USER_ROLES.ASSISTANT;
}

/**
 * Normalize HTML parameter from render hooks to native HTMLElement.
 * @param {HTMLElement} html
 * @returns {HTMLElement}
 */
export function normalizeHtml(html) {
  if (!(html instanceof HTMLElement)) {
    logger.warn("normalizeHtml received non-HTMLElement", { data: typeof html });
  }
  return html;
}

/**
 * Escape a value for direct HTML text insertion.
 * @param {any} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

/**
 * Escape a value for HTML attribute insertion.
 * @param {any} value
 * @returns {string}
 */
export function escapeAttribute(value) {
  return escapeHtml(value);
}

/**
 * Restrict user-controlled color values before placing them in inline styles.
 * @param {any} value
 * @param {string} [fallback="#7b68ee"]
 * @returns {string}
 */
export function sanitizeColor(value, fallback = "#7b68ee") {
  const raw = String(value ?? "").trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw) ? raw : fallback;
}

/**
 * Reject script-like or control-character image paths before placing them in src attributes.
 * @param {any} value
 * @param {string} [fallback="icons/svg/combat.svg"]
 * @returns {string}
 */
export function sanitizeImagePath(value, fallback = "icons/svg/combat.svg") {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  if (/[\u0000-\u001F\u007F]/.test(raw)) return fallback;
  if (/^(?:javascript|vbscript):/i.test(raw)) return fallback;
  return raw;
}

/**
 * Calculates the average initiative for a group of combatants.
 * Uses Math.round for fair rounding (e.g., 14.5 -> 15, 14.4 -> 14).
 * @param {number[]} initiatives - Array of initiative values
 * @returns {number|null} The rounded average, or null if array is empty
 */
export function calculateAverageInitiative(initiatives) {
  if (!initiatives || initiatives.length === 0) return null;
  const sum = initiatives.reduce((a, b) => a + b, 0);
  return Math.round(sum / initiatives.length);
}

/**
 * Calculates group initiative using the specified mode.
 * @param {number[]} initiatives - Array of initiative values
 * @param {string} [mode="average"] - One of INITIATIVE_MODE values
 * @param {number|null} [captainInitiative=null] - Captain's initiative (for captain mode)
 * @returns {number|null} The calculated initiative, or null if array is empty
 */
export function calculateGroupInitiative(initiatives, mode = INITIATIVE_MODE.AVERAGE, captainInitiative = null) {
  if (!initiatives || initiatives.length === 0) return null;

  switch (mode) {
    case INITIATIVE_MODE.HIGHEST:
      return Math.max(...initiatives);
    case INITIATIVE_MODE.LOWEST:
      return Math.min(...initiatives);
    case INITIATIVE_MODE.MEDIAN: {
      const sorted = [...initiatives].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 !== 0
        ? sorted[mid]
        : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }
    case INITIATIVE_MODE.CAPTAIN:
      if (captainInitiative != null && Number.isFinite(captainInitiative)) {
        return captainInitiative;
      }
      return calculateAverageInitiative(initiatives);
    case INITIATIVE_MODE.AVERAGE:
    default:
      return calculateAverageInitiative(initiatives);
  }
}

/* ========================================================================== */
/*   STATE MANAGEMENT                                                         */
/* ========================================================================== */

/**
 * Manages expanded/collapsed group states in localStorage.
 */
export const expandStore = {
  /**
   * @param {string} combatId
   * @returns {Set<string>}
   */
  load(combatId) {
    try {
      const key = `${MODULE_ID}.expanded.${combatId}`;
      const data = localStorage.getItem(key);
      if (!data) return new Set();
      return new Set(JSON.parse(data));
    } catch (err) {
      logger.warn("Failed to load expand state", { data: err.message });
      return new Set();
    }
  },

  /**
   * @param {string} combatId
   * @param {Set<string>} set
   */
  save(combatId, set) {
    try {
      const key = `${MODULE_ID}.expanded.${combatId}`;
      localStorage.setItem(key, JSON.stringify([...set]));
    } catch (err) {
      logger.warn("Failed to save expand state", { data: err.message });
    }
  },

  /**
   * @param {string} combatId
   */
  remove(combatId) {
    try {
      localStorage.removeItem(`${MODULE_ID}.expanded.${combatId}`);
    } catch (err) {
      logger.warn("Failed to remove expand state", { data: err.message });
    }
  },

  /**
   * Remove expand-state entries for combats that no longer exist.
   * Combats deleted outside normal hooks (e.g. by other clients while this
   * client was offline) would otherwise leave stale localStorage keys forever.
   */
  sweep() {
    try {
      const prefix = `${MODULE_ID}.expanded.`;
      const stale = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const combatId = key.slice(prefix.length);
        if (!game.combats?.has(combatId)) stale.push(key);
      }
      for (const key of stale) localStorage.removeItem(key);
      if (stale.length) {
        logger.debug(`Swept ${stale.length} stale expand-state entries`, { fn: "expandStore.sweep" });
      }
    } catch (err) {
      logger.warn("Failed to sweep expand state", { data: err.message });
    }
  },
};

/**
 * Render batching utility for renderGroups.
 */
export const renderBatcher = {
  /** @type {number|null} */
  _pending: null,
  /** @type {Application|null} */
  _app: null,
  /** @type {HTMLElement|null} */
  _html: null,

  /**
   * @param {Application} app
   * @param {HTMLElement} html
   */
  schedule(app, html) {
    this._app = app;
    this._html = html;

    if (this._pending) clearTimeout(this._pending);

    this._pending = setTimeout(() => {
      this._pending = null;
      const currentApp = this._app;
      const currentHtml = this._html;

      this._app = null;
      this._html = null;

      if (currentApp && currentHtml && typeof currentApp["renderGroups"] === "function") {
        try {
          currentApp.renderGroups(currentHtml);
        } catch (err) {
          logger.error("Error in batched renderGroups", err);
        }
      }
    }, CONSTANTS.RENDER_DEBOUNCE_MS);
  },

  cancel() {
    if (this._pending) {
      clearTimeout(this._pending);
      this._pending = null;
    }
    this._app = null;
    this._html = null;
  },
};
