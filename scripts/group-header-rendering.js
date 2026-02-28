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
  calculateAverageInitiative,
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
      const flagGroups = foundry.utils.getProperty(combat, `flags.${MODULE_ID}.groups`) || {};
      const groups = GroupManager.getGroups(combat.turns, combat);

      const element = normalizeHtml(html);
      const list = element.querySelector("[data-application-part='tracker'] ol, .combat-tracker");

      if (!list) {
        log.trace("No tracker list found");
        return;
      }

      // Cleanup previous renders
      list.querySelectorAll("li.sci-combatant-group[data-group-key]").forEach((groupEl) => {
        const children = groupEl.querySelectorAll(".group-children > li.combatant");
        children.forEach((child) => list.appendChild(child));
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

        const groupCfg = flagGroups[groupId] || {};
        if (groupCfg.hidden && !canManageGroups()) continue;

        const groupName = groupCfg.name ?? groupData.name ?? "Unnamed Group";
        const canManage = canManageGroups();
        const combatants = groupData.members;
        const img = groupCfg.img || "icons/svg/combat.svg";
        const color = groupCfg.color || "#000000";
        const isExpanded = expandedGroups.has(groupId);

        // Calculate average initiative
        let avgInit = null;
        if (combatants.length > 0 && combatants.every((c) => Number.isFinite(c.initiative))) {
          avgInit = combat.getFlag(MODULE_ID, `groups.${groupId}`)?.initiative;
          if (!Number.isFinite(avgInit)) {
            avgInit = calculateAverageInitiative(combatants.map((c) => c.initiative));
          }
        }

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

        groupContainer.innerHTML = /*html*/ `
          <div class="group-header grid-layout">
            <div class="header-img">
              <img class="token-image" src="${img}" title="Group icon for ${groupName}">
            </div>
            ${canManage ? renderControlsHtml(groupCfg.hidden) : ""}
            <div class="header-name token-name">
              <strong class="name">${groupName}</strong>
              <div class="group-numbers">${countLabel}</div>
            </div>
            <div class="header-init group-initiative-value">
              ${Number.isFinite(avgInit) ? formatNumber(avgInit) : ""}
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

        // Inject members
        const selector = combatants.length > 0
          ? combatants.map((c) => `li.combatant[data-combatant-id="${c.id}"]`).join(", ")
          : null;

        const childrenElements = selector ? Array.from(list.querySelectorAll(selector)) : [];
        const targetOl = groupContainer.querySelector(".group-children");

        if (childrenElements.length) {
          childrenElements[0].before(groupContainer);
          targetOl.replaceChildren(...childrenElements);
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
    const li = this.element.querySelector(`li.combatant[data-combatant-id="${combatant.id}"]`);
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

function renderControlsHtml(isHidden) {
  let moraleBtn = "";
  try {
    if (game.settings.get(MODULE_ID, "moraleEnabled")) {
      moraleBtn = `<a class="combat-button group-morale" title="Roll Morale"><i class="fa-solid fa-flag"></i></a>`;
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
      <a class="combat-button group-delete" title="Delete Group"><i class="fa-solid fa-xmark"></i></a>
    </div>
  `;
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
  const groupColor = groupCfg.color || "#00ff00";

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