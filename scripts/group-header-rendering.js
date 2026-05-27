/**
 * @file group-header-rendering.js
 * @description Injects custom, collapsible "group headers" into the Combat Tracker.
 * @version V13 Only
 */

import {
  MODULE_ID,
  logger,
  expandStore,
  isGM,
  canManageGroups,
  normalizeHtml,
  CONSTANTS,
  INITIATIVE_MODE,
  calculateAverageInitiative,
  escapeHtml,
  escapeAttribute,
  sanitizeColor,
  sanitizeImagePath,
} from "./shared.js";
import { getPluralRules, formatNumber } from "./rolling-overrides.js";
import { GroupManager } from "./class-objects.js";
import { attachContextMenu } from "./combat-tracker.js";

/**
 * Main entry point - patches the CombatTracker to support grouping.
 */
export async function groupHeaderRendering() {
  const log = logger.fn("groupHeaderRendering");

  const CT = ui.combat?.constructor;
  if (!CT) {
    log.warn("Could not locate CombatTracker class. Grouping will not work.");
    return;
  }

  CT.prototype._isRenderingGroups = false;

  /**
   * The patched render function.
   * @this {CombatTracker}
   * @param {HTMLElement} html
   */
  CT.prototype.renderGroups = function (html) {
    if (this._isRenderingGroups) return;
    this._isRenderingGroups = true;

    const log = logger.fn("renderGroups");

    try {
      const combat = this.viewed;
      if (!combat) return;

      const expandedGroups = expandStore.load(combat.id);
      const flagGroups = combat.getFlag(MODULE_ID, "groups") || {};
      const groups = GroupManager.getGroups(combat.turns, combat);

      const element = normalizeHtml(html);
      const list = element.querySelector("[data-application-part='tracker'] ol, .combat-tracker");

      if (!list) {
        log.trace("No tracker list found");
        return;
      }

      // Cleanup previous renders - re-insert children at group's position to preserve order
      list.querySelectorAll("li.sci-combatant-group[data-group-key]").forEach((groupEl) => {
        const children = groupEl.querySelectorAll(".group-children > li.combatant");
        children.forEach((child) => groupEl.before(child));
        groupEl.remove();
      });

      // Count non-empty groups for logging
      const activeGroups = [...groups.entries()].filter(([k, v]) => k !== "ungrouped" && v.members.length > 0);

      if (activeGroups.length > 0) {
        log.trace("Rendering groups", {
          count: activeGroups.length,
          groups: activeGroups.map(([, g]) => `${g.name} (${g.members.length})`),
        });
      }

      // Render & inject headers
      for (const [groupId, groupData] of groups.entries()) {
        if (groupId === "ungrouped") continue;

        const canManage = canManageGroups();
        const combatants = groupData.members;
        const groupCfg = flagGroups[groupId] || {};
        if (groupCfg.hidden && !canManage) {
          removeCombatantRows(list, combatants);
          continue;
        }

        const groupName = groupCfg.name ?? groupData.name ?? "Unnamed Group";
        const safeGroupName = escapeHtml(groupName);
        const safeGroupTitle = escapeAttribute(groupName);
        const safeImg = escapeAttribute(sanitizeImagePath(groupCfg.img, "icons/svg/combat.svg"));
        const color = sanitizeColor(groupCfg.color, "#000000");
        const isExpanded = expandedGroups.has(groupId);

        // Calculate average initiative
        let avgInit = null;
        if (combatants.length > 0 && combatants.every((c) => Number.isFinite(c.initiative))) {
          avgInit = combat.getFlag(MODULE_ID, `groups.${groupId}`)?.initiative;
          if (!Number.isFinite(avgInit)) {
            avgInit = calculateAverageInitiative(combatants.map((c) => c.initiative));
          }
        }

        // Initiative mode and captain info
        const initMode = Object.values(INITIATIVE_MODE).includes(groupCfg.initiativeMode)
          ? groupCfg.initiativeMode
          : INITIATIVE_MODE.AVERAGE;
        const initModeLabel = `${initMode[0].toUpperCase()}${initMode.slice(1)}`;
        const captainId = groupCfg.captainId || null;
        const captainCombatant = captainId ? combatants.find(c => c.id === captainId) : null;
        const captainName = captainCombatant?.name ?? null;
        const captainDead = captainCombatant?.isDefeated ?? captainCombatant?.defeated ?? false;
        const captainMissing = initMode === INITIATIVE_MODE.CAPTAIN && !captainCombatant;
        const captainHtml = captainName
          ? `<span class="sci-captain-label${captainDead ? " sci-captain-dead" : ""}" title="Captain${captainDead ? " (Dead)" : ""}"><i class="fas fa-crown"></i> ${escapeHtml(captainName)}</span>`
          : captainMissing
            ? `<span class="sci-captain-label sci-captain-missing" title="Captain mode needs a captain"><i class="fas fa-triangle-exclamation"></i> No Captain</span>`
            : "";

        // Build DOM element
        const groupContainer = document.createElement("li");
        groupContainer.classList.add("sci-combatant-group", "collapsible", "dnd5e2-collapsible");
        if (!isExpanded) groupContainer.classList.add("collapsed");
        if (groupCfg.hidden) groupContainer.classList.add("sci-hidden");

        groupContainer.dataset.groupKey = groupId;
        groupContainer.dataset.groupColor = color;
        groupContainer.style.setProperty("--group-color", color);

        const visibleMembers = combatants.filter((c) => !c.hidden);
        const countLabel = getCountLabel(combatants.length, visibleMembers.length, canManage);
        const isActiveGroup = combat.combatant && combatants.some(c => c.id === combat.combatant.id);

        groupContainer.innerHTML = /*html*/ `
          <div class="group-header grid-layout">
            <div class="header-img">
              <img class="token-image" src="${safeImg}" title="Group icon for ${safeGroupTitle}">
            </div>
            ${canManage ? renderControlsHtml(groupCfg.hidden) : ""}
            <div class="header-name token-name">
              <strong class="name">${safeGroupName}</strong>${captainHtml}
              <div class="group-numbers">${countLabel}</div>
            </div>
            ${canManage ? `<a class="combat-button group-skip-turn${isActiveGroup ? "" : " inactive"}" title="${isActiveGroup ? "Skip Group Turn" : "Skip Group Turn (active group only)"}" aria-disabled="${isActiveGroup ? "false" : "true"}"><i class="fa-solid fa-forward-step"></i></a>` : ""}
            <div class="header-init group-initiative-value">
              ${Number.isFinite(avgInit) ? formatNumber(avgInit) : ""}${initMode !== INITIATIVE_MODE.AVERAGE ? `<span class="sci-init-mode-badge" title="${initModeLabel} mode"><i class="fas ${getModeBadgeIcon(initMode)}"></i></span>` : ""}
            </div>
            <div class="collapse-toggle header-toggle">
              <i class="fa-solid fa-chevron-down"></i>
            </div>
          </div>
          <div class="collapsible-content">
            <div class="wrapper">
              <ol class="group-children"></ol>
            </div>
          </div>
        `;

        // Mark group as active if it contains the current combatant
        if (isActiveGroup) {
          groupContainer.classList.add("sci-active-group");
        }

        // Inject members
        const selector = combatants.length > 0
          ? combatants.map((c) => getCombatantSelector(c.id)).join(", ")
          : null;

        const childrenElements = selector ? Array.from(list.querySelectorAll(selector)) : [];
        const targetOl = groupContainer.querySelector(".group-children");

        if (childrenElements.length) {
          childrenElements[0].before(groupContainer);
          targetOl.replaceChildren(...childrenElements);

          // Mark captain combatant
          if (captainId) {
            const captainLi = targetOl.querySelector(getCombatantSelector(captainId));
            if (captainLi) {
              captainLi.classList.add("sci-captain");
              if (captainDead) captainLi.classList.add("sci-captain-dead");
            }
          }

          // Inject morale status icons and per-combatant roll buttons for all group members
          let moraleEnabled = false;
          try { moraleEnabled = game.settings.get(MODULE_ID, "moraleEnabled"); } catch { /* ignore */ }

          for (const c of combatants) {
            const li = targetOl.querySelector(getCombatantSelector(c.id));
            if (!li) continue;
            const controls = li.querySelector(".combatant-controls");
            if (!controls) continue;

            if (canManage && !controls.querySelector(".sci-captain-toggle")) {
              const captainBtn = document.createElement("a");
              const isCaptain = c.id === captainId;
              captainBtn.className = `sci-captain-toggle${isCaptain ? " active" : ""}`;
              captainBtn.title = isCaptain ? "Remove Captain" : "Set as Captain";
              captainBtn.innerHTML = '<i class="fas fa-crown"></i>';
              controls.prepend(captainBtn);
            }

            // Morale status icon
            const moraleStatus = c.getFlag(MODULE_ID, "moraleStatus");
            if (moraleStatus && !controls.querySelector(".sci-morale-icon")) {
              const icon = document.createElement("i");
              icon.className = moraleStatus === "passed"
                ? "fas fa-shield-alt sci-morale-icon sci-morale-passed"
                : "fas fa-person-running sci-morale-icon sci-morale-failed";
              icon.title = moraleStatus === "passed" ? "Morale: Holding" : "Morale: Broken";
              controls.prepend(icon);
            }

            // Per-combatant morale roll button (GM only, morale enabled)
            if (moraleEnabled && isGM() && !controls.querySelector(".sci-morale-roll-single")) {
              const rollBtn = document.createElement("a");
              rollBtn.className = "sci-morale-roll-single";
              rollBtn.title = "Roll Morale";
              rollBtn.innerHTML = '<i class="fas fa-dice-d20"></i>';
              controls.prepend(rollBtn);
            }
          }
        } else {
          targetOl.innerHTML = '<li class="no-members">No members</li>';
          list.insertBefore(groupContainer, list.firstChild);
        }

        attachGroupListeners(groupContainer, combat, groupId, groupName, groupCfg, groupData, canManage);
      }

      if (isGM()) attachContextMenu(element);

    } catch (err) {
      log.error("Error in renderGroups", err);
    } finally {
      this._isRenderingGroups = false;
    }
  };

  log.success("renderGroups injected and CombatTracker patched");
  bindGlobalRollHover();
  patchHoverCombatant();
}

/**
 * Patches CombatTracker5e.hoverCombatant to work with nested group structure.
 */
function patchHoverCombatant() {
  const log = logger.fn("patchHoverCombatant");

  const CT = ui.combat?.constructor;
  if (!CT) return;

  // Store original if not already patched
  if (!CT.prototype._sciOriginalHoverCombatant) {
    CT.prototype._sciOriginalHoverCombatant = CT.prototype.hoverCombatant;
  }

  CT.prototype.hoverCombatant = function (combatant, hover) {
    // Guard against missing element (can happen during render cycles)
    if (!this.element) return;

    // Find combatant li - works whether nested in groups or not
    const li = this.element.querySelector(getCombatantSelector(combatant.id));
    if (!li) return;

    // Toggle hover class
    li.classList.toggle("hover", hover);

    // If the combatant is inside a collapsed group, temporarily expand it on hover
    if (hover) {
      const group = li.closest(".sci-combatant-group.collapsed");
      if (group) {
        group.classList.add("sci-hover-expanded");
      }
    } else {
      // Remove hover expansion from all groups
      this.element.querySelectorAll(".sci-hover-expanded").forEach(g => {
        g.classList.remove("sci-hover-expanded");
      });
    }
  };

  log.trace("Patched hoverCombatant for group compatibility");
}

/* ------------------------------------------------------------------ */
/*  Helper Functions                                                  */
/* ------------------------------------------------------------------ */

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(String(value ?? ""));
  return String(value ?? "").replace(/["\\]/g, "\\$&");
}

function getCombatantSelector(combatantId) {
  return `li.combatant[data-combatant-id="${cssEscape(combatantId)}"]`;
}

function removeCombatantRows(list, combatants) {
  for (const combatant of combatants) {
    list.querySelector(getCombatantSelector(combatant.id))?.remove();
  }
}

function renderControlsHtml(isHidden) {
  let moraleBtn = "";
  let moraleRallyBtn = "";
  let moraleClearBtn = "";
  try {
    if (game.settings.get(MODULE_ID, "moraleEnabled")) {
      moraleBtn = `<a class="combat-button group-morale" title="Roll Morale"><i class="fa-solid fa-flag"></i></a>`;
      moraleRallyBtn = `<a class="combat-button group-morale-rally" title="Rally Broken Morale"><i class="fa-solid fa-hand-fist"></i></a>`;
      moraleClearBtn = `<a class="combat-button group-morale-clear" title="Clear Morale"><i class="fa-solid fa-broom"></i></a>`;
    }
  } catch { /* settings not ready yet */ }

  return `
    <div class="header-buttons group-controls">
      <a class="combat-button group-pin" title="Pin Group"><i class="fas fa-thumbtack"></i></a>
      <a class="combat-button group-reset" title="Reset Initiative"><i class="fas fa-undo"></i></a>
      <a class="combat-button group-roll" title="Roll Initiative"><i class="fa-solid fa-dice-d20"></i></a>
      <a class="combat-button group-select-tokens" title="Select All Tokens"><i class="fas fa-object-group"></i></a>
      <a class="combat-button group-toggle-visibility" title="${isHidden ? "Show Group" : "Hide Group"}">
        <i class="fas ${isHidden ? "fa-eye-slash" : "fa-eye"}"></i>
      </a>
      ${moraleBtn}
      ${moraleRallyBtn}
      ${moraleClearBtn}
      <a class="combat-button group-delete" title="Delete Group"><i class="fa-solid fa-xmark"></i></a>
    </div>
  `;
}

function getModeBadgeIcon(mode) {
  switch (mode) {
    case INITIATIVE_MODE.HIGHEST: return "fa-arrow-up";
    case INITIATIVE_MODE.LOWEST: return "fa-arrow-down";
    case INITIATIVE_MODE.MEDIAN: return "fa-grip-lines";
    case INITIATIVE_MODE.CAPTAIN: return "fa-crown";
    default: return "";
  }
}

function getCountLabel(total, visible, isPrivileged) {
  try {
    const count = isPrivileged ? total : visible;
    const rule = getPluralRules().select(count);
    return game.i18n.format(`DND5E.COMBATANT.Counted.${rule}`, { number: formatNumber(count) });
  } catch {
    const count = isPrivileged ? total : visible;
    return `${count} combatant${count !== 1 ? "s" : ""}`;
  }
}

function attachGroupListeners(element, combat, groupId, groupName, groupCfg, groupData, canManage) {
  const expandedGroups = expandStore.load(combat.id);
  const log = logger.fn("groupListeners");

  // Collapse/Expand
  element.addEventListener("click", (event) => {
    if (
      event.target.closest(".group-controls") ||
      event.target.closest(".group-initiative-value") ||
      event.target.closest(".group-initiative-edit") ||
      event.target.closest(".collapsible-content")
    ) return;

    const isCollapsed = element.classList.toggle("collapsed");

    setTimeout(() => {
      if (isCollapsed) expandedGroups.delete(groupId);
      else expandedGroups.add(groupId);
      expandStore.save(combat.id, expandedGroups);
    }, CONSTANTS.COLLAPSE_DELAY_MS);
  });

  // Token Highlight on Hover (respects setting)
  const groupHeader = element.querySelector(".group-header");
  const groupColor = sanitizeColor(groupCfg.color, "#00ff00");

  groupHeader?.addEventListener("mouseenter", () => {
    const highlightSetting = game.settings.get(MODULE_ID, "groupTokenHighlight");
    if (highlightSetting === "off") return;
    if (highlightSetting === "gm" && !isGM()) return;

    const tokens = groupData.members
      .map((c) => c.token?.object)
      .filter(Boolean);

    tokens.forEach((token) => {
      highlightToken(token, groupColor);
    });
  });

  groupHeader?.addEventListener("mouseleave", () => {
    const tokens = groupData.members
      .map((c) => c.token?.object)
      .filter(Boolean);

    tokens.forEach((token) => {
      clearTokenHighlight(token);
    });
  });

  if (!canManage) return;

  // Pin
  const pinBtn = element.querySelector(".group-pin");
  if (groupCfg.pinned) {
    pinBtn.classList.add("pinned");
    pinBtn.setAttribute("title", "Unpin Group");
  }
  pinBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const newState = !groupCfg.pinned;
    if (isGM()) {
      await combat.setFlag(MODULE_ID, `groups.${groupId}.pinned`, newState);
      log.trace(`${newState ? "Pinned" : "Unpinned"} group "${groupName}"`);
    }
  });

  // Roll
  element.querySelector(".group-roll").addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const mode = ev.altKey ? "advantage" : ev.ctrlKey || ev.metaKey ? "disadvantage" : "normal";
    await GroupManager.rollGroupAndApplyInitiative(combat, groupId, { mode });
  });

  // Skip all remaining turns in this group
  element.querySelector(".group-skip-turn")?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.currentTarget.classList.contains("inactive")) return;

    try {
      await skipGroupTurn(combat, groupId);
    } catch (err) {
      log.error("Skip group turn error", err);
    }
  });

  // Reset
  element.querySelector(".group-reset")?.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: `Reset Initiative for "${groupName}"` },
      content: "<p>Clear initiative for all members of this group?</p>",
    });
    if (!confirmed) return;

    try {
      await GroupManager.resetGroupInitiative(combat, groupId);
      ui.notifications.info(`Initiative cleared for group "${groupName}".`);
    } catch (err) {
      log.error("Error resetting group", err);
    }
  });

  // Delete
  element.querySelector(".group-delete")?.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    await GroupManager.deleteGroup(combat, groupId, { confirm: true, groupName });
  });

  // Select All Tokens
  element.querySelector(".group-select-tokens")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const tokens = groupData.members
      .map((c) => c.token?.object)
      .filter(Boolean);

    if (tokens.length) {
      canvas.tokens.releaseAll();
      tokens.forEach((t) => t.control({ releaseOthers: false }));
      log.trace(`Selected ${tokens.length} tokens for "${groupName}"`);
    } else {
      ui.notifications.info(`No tokens found for group "${groupName}".`);
    }
  });

  // Visibility
  const toggleBtn = element.querySelector(".group-toggle-visibility");
  toggleBtn?.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    try {
      const newHidden = await GroupManager.toggleGroupVisibility(combat, groupId);
      if (newHidden !== null) {
        toggleBtn.querySelector("i").className = `fas ${newHidden ? "fa-eye-slash" : "fa-eye"}`;
      }
    } catch (err) {
      log.error("Visibility toggle error", err);
    }
  });

  // Morale Roll
  const moraleBtn = element.querySelector(".group-morale");
  if (moraleBtn) {
    moraleBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        const { MoraleManager } = await import("./morale.js");
        await MoraleManager.rollMorale(combat, groupId);
      } catch (err) {
        log.error("Morale roll error", err);
      }
    });
  }

  // Rally Broken Morale
  const moraleRallyBtn = element.querySelector(".group-morale-rally");
  if (moraleRallyBtn) {
    moraleRallyBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        const { MoraleManager } = await import("./morale.js");
        await MoraleManager.rallyMorale(combat, groupId);
        ui.combat.render();
      } catch (err) {
        log.error("Morale rally error", err);
      }
    });
  }

  // Clear Morale (group-wide)
  const moraleClearBtn = element.querySelector(".group-morale-clear");
  if (moraleClearBtn) {
    moraleClearBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        const { MoraleManager } = await import("./morale.js");
        await MoraleManager.clearMorale(combat, groupId);
        ui.combat.render();
      } catch (err) {
        log.error("Morale clear error", err);
      }
    });
  }

  // Per-combatant morale roll (delegated)
  element.addEventListener("click", async (ev) => {
    const rollBtn = ev.target.closest(".sci-morale-roll-single");
    if (!rollBtn) return;
    ev.stopPropagation();
    const combatantLi = rollBtn.closest("li.combatant");
    const combatantId = combatantLi?.dataset?.combatantId;
    if (!combatantId) return;
    try {
      const { MoraleManager } = await import("./morale.js");
      await MoraleManager.rollMoraleSingle(combat, groupId, combatantId);
    } catch (err) {
      log.error("Single morale roll error", err);
    }
  });

  // Per-combatant captain toggle (delegated)
  element.addEventListener("click", async (ev) => {
    const captainBtn = ev.target.closest(".sci-captain-toggle");
    if (!captainBtn) return;
    ev.preventDefault();
    ev.stopPropagation();

    const combatantLi = captainBtn.closest("li.combatant");
    const combatantId = combatantLi?.dataset?.combatantId;
    if (!combatantId) return;

    try {
      if (groupCfg.captainId === combatantId) {
        await GroupManager.removeCaptain(combat, groupId);
      } else {
        await GroupManager.setCaptain(combat, groupId, combatantId);
      }
      ui.combat.render();
    } catch (err) {
      log.error("Captain toggle error", err);
    }
  });

  // Inline initiative edit
  const initDisplay = element.querySelector(".group-initiative-value");
  initDisplay.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    const currentVal = parseFloat(initDisplay.textContent.trim());
    if (isNaN(currentVal)) return;

    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = currentVal;
    input.classList.add("group-initiative-edit");

    initDisplay.replaceWith(input);
    input.focus();

    const apply = async () => {
      const newVal = parseFloat(input.value);
      if (isNaN(newVal)) {
        ui.notifications.warn("Please enter a valid number for initiative.");
        ui.combat.render();
        return;
      }

      try {
        await GroupManager.setGroupInitiative(combat, groupId, newVal);
      } catch (err) {
        log.error("Init update failed", err);
      }
    };

    input.addEventListener("blur", apply);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") ui.combat.render();
    });
  });
}

async function skipGroupTurn(combat, groupId) {
  if (!isGM()) return;

  const turns = combat.turns ?? [];
  if (!turns.length || !Number.isInteger(combat.turn)) return;

  const active = combat.combatant;
  const activeGroupId = active?.getFlag(MODULE_ID, "groupId");
  if (!active || activeGroupId !== groupId) {
    ui.notifications.info("Skip Group Turn is only available for the active group.");
    return;
  }

  const totalTurns = turns.length;
  for (let step = 1; step <= totalTurns; step += 1) {
    const nextTurn = (combat.turn + step) % totalTurns;
    const nextCombatant = turns[nextTurn];
    if (!nextCombatant || nextCombatant.getFlag(MODULE_ID, "groupId") === groupId) continue;

    const roundDelta = nextTurn <= combat.turn ? 1 : 0;
    await combat.update({
      round: Math.max(1, (combat.round ?? 1) + roundDelta),
      turn: nextTurn,
    });
    return;
  }

  ui.notifications.info("No combatant outside this group is available to skip to.");
}

function bindGlobalRollHover() {
  if (bindGlobalRollHover.bound) return;
  bindGlobalRollHover.bound = true;

  const setClasses = (ev) => {
    document.body.classList.toggle("sci-alt-key", ev.altKey && !ev.ctrlKey && !ev.metaKey);
    document.body.classList.toggle("sci-ctrl-key", (ev.ctrlKey || ev.metaKey) && !ev.altKey);
  };

  const clearClasses = () => {
    document.body.classList.remove("sci-alt-key", "sci-ctrl-key");
  };

  document.addEventListener("keydown", setClasses);
  document.addEventListener("keyup", setClasses);
  window.addEventListener("blur", clearClasses);
  document.addEventListener("mouseup", clearClasses);
}

/* ------------------------------------------------------------------ */
/*  Token Highlight Functions                                         */
/* ------------------------------------------------------------------ */

/**
 * Clears all group highlights from all tokens on the current canvas.
 */
export function clearAllTokenHighlights() {
  if (!canvas?.tokens?.placeables) return;
  for (const token of canvas.tokens.placeables) {
    clearTokenHighlight(token);
  }
}

/**
 * Highlights a token with a colored border ring.
 * @param {Token} token - The token placeable object
 * @param {string} color - Hex color code for the highlight
 */
function highlightToken(token, color) {
  if (!token || !token.mesh) return;

  // Remove existing highlight if present
  clearTokenHighlight(token);

  // Parse hex color to number
  const colorNum = parseInt(color.replace("#", ""), 16);

  // Create highlight graphics
  const highlight = new PIXI.Graphics();
  const size = Math.max(token.document.width, token.document.height) * canvas.grid.size;
  const lineWidth = CONSTANTS.TOKEN_HIGHLIGHT_LINE_WIDTH;
  const padding = CONSTANTS.TOKEN_HIGHLIGHT_PADDING;

  // Draw outer glow/border
  highlight.lineStyle(lineWidth + CONSTANTS.TOKEN_HIGHLIGHT_GLOW_EXTRA, colorNum, CONSTANTS.TOKEN_HIGHLIGHT_GLOW_ALPHA);
  highlight.drawCircle(size / 2, size / 2, size / 2 + padding + lineWidth);

  // Draw main border
  highlight.lineStyle(lineWidth, colorNum, CONSTANTS.TOKEN_HIGHLIGHT_MAIN_ALPHA);
  highlight.drawCircle(size / 2, size / 2, size / 2 + padding);

  // Store reference and add to token
  token._sciGroupHighlight = highlight;
  token.addChild(highlight);
}

/**
 * Removes the group highlight from a token.
 * @param {Token} token - The token placeable object
 */
function clearTokenHighlight(token) {
  if (!token) return;

  if (token._sciGroupHighlight) {
    token.removeChild(token._sciGroupHighlight);
    token._sciGroupHighlight.destroy();
    token._sciGroupHighlight = null;
  }
}
