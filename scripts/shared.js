/**
 * @file shared.js
 * @description Core constants, utility functions, and shared state management for Squad Combat Initiative.
 * @version V13 Only
 */

/* ========================================================================== */
/*   TYPE DEFINITIONS                                                         */
/* ========================================================================== */

/**
 * @typedef {Object} GroupData
 * @property {string} name - The display name of the group
 * @property {number|null} [initiative] - The generic "group initiative" value (average)
 * @property {boolean} [pinned] - If true, this group stays expanded/pinned in the UI
 * @property {string} [img] - Path to the group icon/image
 * @property {string} [color] - Hex color code for the group styling
 * @property {boolean} [hidden] - Whether the group is hidden from players
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
 * Global constants used for calculations and UI timing.
 * Frozen to prevent accidental mutation.
 */
export const CONSTANTS = Object.freeze({
  STAGGER_INCREMENT: 0.01,
  SORT_BASE_OFFSET: -1000,
  SORT_INCREMENT: 100,
  COLLAPSE_ANIMATION_MS: 300,
  COLLAPSE_DELAY_MS: 310,
  RENDER_DEBOUNCE_MS: 50,
});

/**
 * WeakSet to track combatants that should skip the finalization hook.
 * @type {WeakSet<Combatant>}
 */
export const skipFinalizeSet = new WeakSet();

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
  #dedupeWindowMs = 100;

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
    
    if (lastTime && (now - lastTime) < this.#dedupeWindowMs) {
      return true;
    }
    
    this.#recentLogs.set(key, now);
    
    // Cleanup old entries
    if (this.#recentLogs.size > 50) {
      for (const [k, t] of this.#recentLogs) {
        if (now - t > 1000) this.#recentLogs.delete(k);
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