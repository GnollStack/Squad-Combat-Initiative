/**
 * @file carousel-squads.js
 * @description Squad cards in Carousel Combat Tracker. Other squads collapse to one card and the active
 *              squad expands beside its card, with the wheel moving through its members.
 * @version Foundry V14+
 * @requires lib-wrapper
 *
 * Carousel's portraits stay direct children of its list, because its ordering, animation and dragging need
 * that. Collapsing hides them with a class; its animator already skips children that are not displayed.
 * The layout only reads documents and writes this client's DOM.
 */

import { MODULE_ID, logger, canManageGroups, sanitizeColor, sanitizeImagePath, TEMPLATES } from "./shared.js";
import { PLAYER_MORALE_VISIBILITY } from "./settings.js";
import { UNGROUPED, GroupManager } from "./group-manager.js";
import { MoraleManager } from "./morale.js";
import { getSquadCardModel, highlightSquadTokens, clearAllTokenHighlights } from "./squad-card-renderer.js";

export const CAROUSEL_MODULE_ID = "combat-tracker-dock";
const REQUIRED_DOCK_METHODS = Object.freeze(["updateOrder", "autosize", "centerCurrentCombatant", "animateOrder"]);
const CARD_SLOT_WIDTH = 1.5;
const NUDGE_SLOT_WIDTH = 0.3;
const STACK_GAP = 4;

/** Per-dock layout state, local to this client. */
const dockStates = new WeakMap();
const boundContainers = new WeakSet();

function stateFor(dock) {
  if (!dockStates.has(dock)) dockStates.set(dock, { cards: new Map(), nudges: new Map(), windows: new Map(), overrides: new Map(), scrollable: new Set(), stacks: [], lastActive: null, lastActiveGroup: null, slots: null, failed: false });
  return dockStates.get(dock);
}

/**
 * Groups combatants into display units, each squad at its first member's place. Squads that have no
 * aggregate yet may not be contiguous in turn order, and collapsing still has to gather them.
 * @param {Combatant[]} combatants - Combatants in turn order
 * @param {(combatant: Combatant) => string|null} squadOf - The squad a combatant displays under
 * @returns {{groupId: string|null, members: Combatant[]}[]}
 */
export function buildCarouselUnits(combatants, squadOf) {
  const units = [];
  const squads = new Map();
  for (const combatant of combatants) {
    const groupId = squadOf(combatant);
    if (!groupId) { units.push({ groupId: null, members: [combatant] }); continue; }
    if (!squads.has(groupId)) {
      const unit = { groupId, members: [] };
      squads.set(groupId, unit);
      units.push(unit);
    }
    squads.get(groupId).members.push(combatant);
  }
  return units;
}

/**
 * Rotates units the way Carousel rotates portraits, but by unit, so a squad is never split across the ends.
 * @param {Object[]} units - Units in turn order
 * @param {number} activeIndex - The active unit's index, or -1
 * @param {{trueCarousel: boolean, leftAligned: boolean}} style
 * @returns {Object[]}
 */
export function orderCarouselUnits(units, activeIndex, { trueCarousel, leftAligned }) {
  if (!trueCarousel || !units.length) return [...units];
  const active = Math.max(activeIndex, 0);
  const lead = leftAligned ? 0 : Math.floor(units.length / 2);
  const start = (active - lead + units.length) % units.length;
  return [...units.slice(start), ...units.slice(0, start)];
}

/**
 * The first shown member of an expanded squad.
 * @param {number} count - Members available to show
 * @param {number} activeIndex - The active member's index among them, or -1
 * @param {number} start - The current first shown member
 * @param {number} limit - Members shown at once
 * @param {boolean} follow - Bring the active member into view
 * @returns {number}
 */
export function squadWindowStart(count, activeIndex, start, limit, follow) {
  const last = Math.max(0, count - limit);
  let next = Math.min(Math.max(0, start), last);
  if (follow && activeIndex >= 0) {
    if (activeIndex < next) next = activeIndex;
    else if (activeIndex >= next + limit) next = activeIndex - limit + 1;
  }
  return Math.min(next, last);
}

/**
 * The unit after the active one in turn order, wrapping at the end of the round. It looks past the rest of the
 * active squad, because the point is to show who is coming next.
 * @param {Object[]} units - Units in turn order
 * @param {number} activeIndex - The active unit's index, or -1
 * @param {(unit: Object) => boolean} takesTurn - Whether a unit will get a turn this user can see
 * @returns {number} The next unit's index, or -1
 */
export function nextUnitIndex(units, activeIndex, takesTurn) {
  if (activeIndex < 0) return -1;
  for (let step = 1; step < units.length; step += 1) {
    const index = (activeIndex + step) % units.length;
    if (takesTurn(units[index])) return index;
  }
  return -1;
}

/**
 * Total hit points across a squad.
 * @param {Combatant[]} members
 * @returns {{value: number, max: number, percent: number}|null} Null when no member has hit points
 */
export function squadHealth(members) {
  let value = 0;
  let max = 0;
  for (const member of members) {
    const hp = member.actor?.system?.attributes?.hp;
    const memberMax = hp?.effectiveMax ?? hp?.max;
    if (!Number.isFinite(memberMax) || memberMax <= 0) continue;
    max += memberMax;
    value += Math.min(Math.max(Number(hp.value) || 0, 0), memberMax);
  }
  return max ? { value, max, percent: Math.round((value / max) * 100) } : null;
}

/**
 * Whether a squad shows its members. This client's click wins, then the squad's turn, its pin and the setting.
 * @param {{active: boolean, pinned: boolean, keptOpen: boolean, override: boolean|undefined}} state
 * @returns {boolean}
 */
export function squadIsExpanded({ active, pinned, keptOpen, override }) {
  return override ?? (active || pinned || keptOpen);
}

/**
 * Rotates a squad so the current member comes first, those still to act follow, and those who have acted go last.
 * @param {Combatant[]} members - Members in turn order
 * @param {string|null} currentId
 * @returns {Combatant[]}
 */
export function currentFirstOrder(members, currentId) {
  const index = members.findIndex((member) => member.id === currentId);
  return index > 0 ? [...members.slice(index), ...members.slice(0, index)] : [...members];
}

/**
 * Why squad cards can or cannot run here.
 * @returns {"available"|"notInstalled"|"notEnabled"|"unsupported"}
 */
export function carouselAvailability() {
  const carousel = game.modules.get(CAROUSEL_MODULE_ID);
  if (!carousel) return "notInstalled";
  if (!carousel.active) return "notEnabled";
  const dock = CONFIG.combatTrackerDock?.CombatDock?.prototype;
  return REQUIRED_DOCK_METHODS.every((method) => typeof dock?.[method] === "function") ? "available" : "unsupported";
}

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function isDown(combatant) {
  const hp = combatant.actor?.system?.attributes?.hp?.value;
  return !!(combatant.isDefeated ?? combatant.defeated) || (Number.isFinite(hp) && hp <= 0);
}

function isFriendly(combatant) {
  return combatant.token?.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY;
}

/**
 * The fade for one shown member. Only a side with hidden members fades, and the current member never does.
 * @param {number} index - Position among the shown members
 * @param {number} count - Members shown
 * @param {boolean} hiddenBefore - Members are hidden before the first shown one
 * @param {boolean} hiddenAfter - Members are hidden after the last shown one
 * @param {boolean} current - This is the current member
 * @returns {"start"|"end"|"near"|null}
 */
export function memberFade(index, count, hiddenBefore, hiddenAfter, current) {
  if (current) return null;
  if (hiddenBefore && index === 0) return "start";
  if (hiddenAfter && index === count - 1) return "end";
  if ((hiddenBefore && index === 1) || (hiddenAfter && index === count - 2)) return "near";
  return null;
}

function setMemberState(portrait, { member = false, collapsed = false, dim = false, stacked = false, cycled = false, fade = null, fadeVertical = false, color = null } = {}) {
  const { classList, style } = portrait.element;
  classList.toggle("sci-carousel-member", member);
  classList.toggle("sci-carousel-collapsed", collapsed);
  classList.toggle("sci-carousel-dim", dim);
  classList.toggle("sci-carousel-stacked", stacked);
  classList.toggle("sci-carousel-cycled", cycled);
  if (!stacked) classList.remove("sci-fade-reversed");
  classList.toggle("sci-fade-start", fade === "start");
  classList.toggle("sci-fade-end", fade === "end");
  classList.toggle("sci-fade-near", fade === "near");
  classList.toggle("sci-fade-vertical", !!fade && fadeVertical);
  if (!stacked) {
    style.removeProperty("left");
    style.removeProperty("top");
  }
  if (color) style.setProperty("--sci-group-color", color);
  else style.removeProperty("--sci-group-color");
}

function clearLayout(dock, state) {
  for (const element of [...state.cards.values(), ...[...state.nudges.values()].flat()]) element.remove();
  state.cards.clear();
  state.nudges.clear();
  state.stacks = [];
  state.scrollable.clear();
  for (const portrait of dock.portraits ?? []) setMemberState(portrait);
  if (state.slots !== null) {
    state.slots = null;
    dock.autosize();
  }
}

function cardData(dock, model, members, portraits, { active, expanded, manager, activeIndex, cycle }) {
  const { group } = model;
  const moraleVisible = setting("moraleEnabled") === true && setting("carouselShowMorale") === true
    && (manager || setting("playerMoraleVisibility") === PLAYER_MORALE_VISIBILITY.VISIBLE_MEMBERS);
  const enemyHidden = !manager && game.settings.get(CAROUSEL_MODULE_ID, "hideEnemyInitiative") === true && !members.every(isFriendly);
  // Total hit points would tell players how hurt an enemy squad is, so this stays with those who manage squads.
  const health = manager && setting("carouselShowHealth") === true ? squadHealth(model.members) : null;
  const previews = expanded ? [] : members.slice(0, setting("carouselPreviewCount")).map((member) => {
    const portrait = portraits.get(member.id);
    return { src: sanitizeImagePath(portrait?.img, "icons/svg/mystery-man.svg"), name: portrait?.name ?? "" };
  });
  return {
    img: sanitizeImagePath(group.img, "icons/svg/combat.svg"),
    name: group.name,
    count: active
      ? game.i18n.format("SCI.Carousel.Acted", { acted: activeIndex, total: model.members.length })
      : game.i18n.format(model.members.length === 1 ? "SCI.Card.MemberCountOne" : "SCI.Card.MemberCount", { count: model.members.length }),
    showInitiative: setting("carouselShowInitiative") === true && !enemyHidden && model.initiative !== null,
    initiative: model.initiative,
    initiativeLabel: game.i18n.localize("SCI.Tracker.EditInitiative"),
    health: health && {
      percent: health.percent,
      tier: health.percent <= 25 ? "low" : health.percent <= 50 ? "mid" : "high",
      label: game.i18n.format("SCI.Carousel.Health", { value: health.value, max: health.max }),
    },
    canPin: manager,
    pinned: !!group.pinned,
    pinLabel: game.i18n.localize(group.pinned ? "SCI.Card.Unpin" : "SCI.Card.Pin"),
    showCaptain: setting("carouselShowCaptain") === true && !!model.captain,
    captainName: model.captain?.name ?? "",
    broken: moraleVisible ? model.broken : 0,
    brokenLabel: game.i18n.localize("SCI.Tracker.MoraleBroken"),
    previews,
    cycle: cycle && {
      ...cycle,
      previousLabel: game.i18n.localize("SCI.Carousel.Previous"),
      nextLabel: game.i18n.localize("SCI.Carousel.Next"),
    },
  };
}

function placeCard(dock, state, container, model, data, { active, expanded, cycling, upNext, order }) {
  const template = globalThis.Handlebars?.partials?.[TEMPLATES.CAROUSEL_SQUAD];
  if (typeof template !== "function") throw new Error("The carousel squad card template is not loaded.");
  let card = state.cards.get(model.groupId);
  if (!card) {
    card = document.createElement("div");
    card.className = "sci-carousel-squad";
    card.dataset.groupKey = model.groupId;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.addEventListener("mouseenter", () => {
      const current = getSquadCardModel(dock.combat, model.groupId);
      if (current) highlightSquadTokens(current);
    });
    card.addEventListener("mouseleave", clearAllTokenHighlights);
    state.cards.set(model.groupId, card);
  }
  card.innerHTML = template(data);
  card.classList.toggle("sci-active", active);
  card.classList.toggle("sci-expanded", expanded);
  card.setAttribute("aria-expanded", String(expanded));
  card.classList.toggle("sci-cycling", cycling);
  card.classList.toggle("sci-next", upNext);
  card.classList.toggle("sci-defeated", setting("carouselDimDefeated") === true && model.members.length > 0 && model.living === 0);
  if (upNext) card.title = game.i18n.localize("SCI.Carousel.UpNext");
  else card.removeAttribute("title");
  card.classList.toggle("sci-hidden", !!model.group.hidden);
  card.style.setProperty("--sci-group-color", sanitizeColor(model.group.color, "#7b68ee"));
  card.style.setProperty("order", order);
  if (card.parentElement !== container) container.append(card);
}

/**
 * How many members fit in a stack opening away from the bar. Foundry's window can be short, and a stack
 * running off the screen would hide the members the wheel is meant to reach.
 */
function stackLimit(dock, container, limit) {
  const root = getComputedStyle(document.documentElement);
  const size = parseFloat(root.getPropertyValue("--combatant-portrait-size")) || 70;
  const aspect = parseFloat(root.getPropertyValue("--combatant-portrait-aspect")) || 1.5;
  const rect = container.getBoundingClientRect();
  const fits = dock.isVertical
    ? Math.max(rect.left, window.innerWidth - rect.right) / (size + STACK_GAP)
    : Math.max(rect.top, window.innerHeight - rect.bottom) / (size * aspect + STACK_GAP);
  return Math.max(1, Math.min(limit, Math.floor(fits)));
}

/** Where left 0, top 0 lands for a fixed element in this list, which depends on what contains it. */
function fixedOrigin(container) {
  const probe = document.createElement("div");
  probe.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 0; visibility: hidden;";
  container.append(probe);
  const { left, top } = probe.getBoundingClientRect();
  probe.remove();
  return { left, top };
}

/**
 * A card's resting place on screen. Carousel slides everything in with a transform when combat starts, and a
 * stack placed from the moving position would stay wrong, so this reads layout offsets, which ignore transforms.
 */
function restingRect(card, container) {
  const list = container.getBoundingClientRect();
  const left = list.left + container.clientLeft - container.scrollLeft + card.offsetLeft;
  const top = list.top + container.clientTop - container.scrollTop + card.offsetTop;
  return { left, top, right: left + card.offsetWidth, bottom: top + card.offsetHeight, width: card.offsetWidth, height: card.offsetHeight };
}

/**
 * Lays a stack out from its card, so its first member is always nearest. A stack opening up or left runs
 * backward on screen, so its arrows and fades flip with it.
 * @returns {HTMLElement[]} The elements in screen order, top to bottom or left to right.
 */
export function orientStack(elements, reversed, [towardStart, towardEnd]) {
  for (const element of elements) {
    element.classList.toggle("sci-fade-reversed", reversed);
    const step = Number(element.dataset.step);
    if (step) element.firstElementChild.className = `fa-solid fa-chevron-${(step < 0) === reversed ? towardEnd : towardStart}`;
  }
  return reversed ? [...elements].reverse() : elements;
}

/**
 * Places each stack against its card. Stacks use fixed positioning to escape the clipping on Carousel's list,
 * and they follow the card when the list scrolls.
 */
function positionStacks(dock) {
  const state = stateFor(dock);
  if (!state.stacks.length || !dock.element) return;
  const container = dock.element.querySelector("#combatants");
  if (!container) return;
  const { left: originLeft, top: originTop } = fixedOrigin(container);

  for (const { groupId, elements } of state.stacks) {
    const card = state.cards.get(groupId);
    if (!card?.isConnected) continue;
    const rect = restingRect(card, container);
    if (dock.isVertical) {
      const total = elements.reduce((sum, element) => sum + element.offsetWidth + STACK_GAP, 0);
      const toLeft = game.settings.get(CAROUSEL_MODULE_ID, "alignment") === "right" || window.innerWidth - rect.right < total && rect.left > window.innerWidth - rect.right;
      let cursor = toLeft ? rect.left - total : rect.right + STACK_GAP;
      for (const element of orientStack(elements, toLeft, ["left", "right"])) {
        element.style.left = `${cursor - originLeft}px`;
        element.style.top = `${rect.top + (rect.height - element.offsetHeight) / 2 - originTop}px`;
        cursor += element.offsetWidth + STACK_GAP;
      }
      continue;
    }
    const total = elements.reduce((sum, element) => sum + element.offsetHeight + STACK_GAP, 0);
    const below = window.innerHeight - rect.bottom;
    const opensDown = below >= total || below >= rect.top;
    let cursor = opensDown ? rect.bottom + STACK_GAP : rect.top - total;
    for (const element of orientStack(elements, !opensDown, ["up", "down"])) {
      element.style.left = `${rect.left + (rect.width - element.offsetWidth) / 2 - originLeft}px`;
      element.style.top = `${cursor - originTop}px`;
      cursor += element.offsetHeight + STACK_GAP;
    }
  }
}

function placeNudges(state, container, groupId, overflow, orders, { stacked, vertical }) {
  let nudges = state.nudges.get(groupId);
  if (!overflow) {
    nudges?.forEach((nudge) => nudge.remove());
    state.nudges.delete(groupId);
    return;
  }
  if (!nudges) {
    nudges = [-1, 1].map((step) => {
      const nudge = document.createElement("button");
      nudge.type = "button";
      nudge.className = "sci-carousel-nudge";
      nudge.dataset.groupKey = groupId;
      nudge.dataset.step = step;
      nudge.setAttribute("aria-label", game.i18n.localize(step < 0 ? "SCI.Carousel.Previous" : "SCI.Carousel.Next"));
      nudge.innerHTML = `<i aria-hidden="true"></i>`;
      return nudge;
    });
    state.nudges.set(groupId, nudges);
  }
  nudges.forEach((nudge, index) => {
    const icon = vertical ? (index ? "down" : "up") : (index ? "right" : "left");
    nudge.firstElementChild.className = `fa-solid fa-chevron-${icon}`;
    nudge.classList.toggle("sci-carousel-stacked", stacked);
    nudge.classList.toggle("sci-carousel-nudge-vertical", vertical);
    nudge.style.setProperty("order", orders[index]);
    if (nudge.parentElement !== container) container.append(nudge);
  });
}

/** Rebuilds the squad layout after Carousel has set its own order. */
function applySquadLayout(dock) {
  const state = stateFor(dock);
  const container = dock.element?.querySelector("#combatants");
  if (!container || state.failed) return;
  if (setting("carouselSquadCards") !== true || !dock.combat) {
    clearLayout(dock, state);
    return;
  }

  bindContainer(dock, container);
  const { combat } = dock;
  const manager = canManageGroups();
  const portraits = new Map(dock.portraits.map((portrait) => [portrait.combatant.id, portrait]));
  const models = new Map();
  const squadOf = (combatant) => {
    const groupId = combatant.getFlag(MODULE_ID, "groupId");
    if (!groupId || groupId === UNGROUPED) return null;
    if (!models.has(groupId)) models.set(groupId, getSquadCardModel(combat, groupId, manager));
    return models.get(groupId) ? groupId : null;
  };

  const combatants = dock.portraits.map((portrait) => portrait.combatant).sort(combat._sortCombatants);
  const units = buildCarouselUnits(combatants, squadOf);
  const activeId = combat.started ? combat.combatant?.id ?? null : null;
  const activeIndex = units.findIndex((unit) => unit.members.some((member) => member.id === activeId));
  // A click lasts until the turn moves to another squad, so a bar can't quietly drift out of step with the fight.
  const activeGroup = units[activeIndex]?.groupId ?? null;
  if (state.lastActiveGroup !== activeGroup) state.overrides.clear();
  state.lastActiveGroup = activeGroup;
  const nextIndex = nextUnitIndex(units, activeIndex, (unit) => unit.members.some((member) =>
    (manager || (!member.hidden && member.visible !== false)) && !(combat.settings?.skipDefeated && isDown(member))));
  const nextGroup = setting("carouselShowNext") === true ? units[nextIndex]?.groupId ?? null : null;
  const ordered = orderCarouselUnits(units, activeIndex, { trueCarousel: dock.trueCarousel, leftAligned: dock.leftAligned });
  const direction = setting("carouselExpandDirection");
  const stacked = direction === "away";
  const cycling = direction === "cycle";
  const configuredLimit = Math.max(1, Number(setting("carouselMembersShown")) || 1);
  const limit = cycling ? 1 : stacked ? stackLimit(dock, container, configuredLimit) : configuredLimit;
  const stackVertical = stacked !== dock.isVertical;
  const fadeEdges = setting("carouselFadeEdges") === true && !cycling;
  // One at a time always shows the current member, so its order would only change what the arrows step through.
  const currentFirst = setting("carouselMemberOrder") === "current" && !cycling;
  // A saved window position means nothing in a different layout, so bring the current member back into view.
  const layoutKey = `${direction}|${currentFirst}|${limit}`;
  const follow = state.lastActive !== activeId || state.layoutKey !== layoutKey;
  state.layoutKey = layoutKey;
  const stacks = [];
  const scrollable = new Set();
  const defeated = setting("carouselDefeated");
  const keepFriendly = setting("carouselCollapse") === "hostile";
  const separator = container.querySelector(":scope > .separator");
  const listEnd = units.at(-1);
  const liveCards = new Set();
  let position = 0;
  let slots = 0;
  const nextOrder = () => position++ * 100;

  for (const unit of ordered) {
    if (!unit.groupId) {
      const portrait = portraits.get(unit.members[0].id);
      setMemberState(portrait);
      portrait.element.style.setProperty("order", nextOrder());
      slots += 1;
    } else {
      const model = models.get(unit.groupId);
      const shown = defeated === "dim" ? unit.members : unit.members.filter((member) => !isDown(member) || member.id === activeId);
      const active = unit.members.some((member) => member.id === activeId);
      const expanded = squadIsExpanded({ active, pinned: !!model.group.pinned, keptOpen: keepFriendly && unit.members.every(isFriendly), override: state.overrides.get(unit.groupId) });
      const sequence = currentFirst ? currentFirstOrder(shown, activeId) : shown;
      const shownActive = sequence.findIndex((member) => member.id === activeId);
      const start = squadWindowStart(sequence.length, shownActive, state.windows.get(unit.groupId) ?? 0, limit, follow && active);
      state.windows.set(unit.groupId, start);
      const shownMembers = expanded ? sequence.slice(start, start + limit) : [];
      const visible = new Set(shownMembers.map((member) => member.id));
      const canScroll = expanded && shown.length > limit;
      if (canScroll) scrollable.add(unit.groupId);
      const overflow = canScroll && !cycling;
      const hiddenBefore = start > 0;
      const hiddenAfter = start + limit < shown.length;
      const cycle = cycling && canScroll ? { position: start + 1, total: shown.length } : null;
      const color = sanitizeColor(model.group.color, "#7b68ee");
      const acted = model.members.findIndex((member) => member.id === activeId);

      liveCards.add(unit.groupId);
      placeCard(dock, state, container, model, cardData(dock, model, shown, portraits, { active, expanded, manager, activeIndex: Math.max(acted, 0), cycle }), { active, expanded, cycling: cycling && expanded, upNext: unit.groupId === nextGroup, order: nextOrder() });
      slots += CARD_SLOT_WIDTH;

      const previousOrder = overflow ? nextOrder() : null;
      const stackElements = [];
      for (const member of [...shownMembers, ...unit.members.filter((candidate) => !visible.has(candidate.id))]) {
        const portrait = portraits.get(member.id);
        const isVisible = visible.has(member.id);
        const fade = fadeEdges && isVisible ? memberFade(shownMembers.indexOf(member), shownMembers.length, hiddenBefore, hiddenAfter, member.id === activeId) : null;
        setMemberState(portrait, { member: true, collapsed: !isVisible, dim: defeated === "dim" && isDown(member), stacked: stacked && isVisible, cycled: cycling && isVisible, fade, fadeVertical: stackVertical, color });
        portrait.element.style.setProperty("order", isVisible ? nextOrder() : position * 100);
        if (isVisible) {
          stackElements.push(portrait.element);
          // A stack sits off the bar, so only members along the bar take up its width.
          if (!stacked) slots += 1;
        }
      }
      placeNudges(state, container, unit.groupId, overflow, [previousOrder, overflow ? nextOrder() : null], { stacked, vertical: stackVertical });
      if (overflow && !stacked) slots += NUDGE_SLOT_WIDTH * 2;
      if (stacked && stackElements.length) {
        const [previous, next] = state.nudges.get(unit.groupId) ?? [];
        stacks.push({ groupId: unit.groupId, elements: [...(previous ? [previous] : []), ...stackElements, ...(next ? [next] : [])] });
      }
    }
    if (unit === listEnd && separator) separator.style.setProperty("order", nextOrder());
  }

  for (const [groupId, card] of state.cards) {
    if (liveCards.has(groupId)) continue;
    card.remove();
    state.cards.delete(groupId);
    state.nudges.get(groupId)?.forEach((nudge) => nudge.remove());
    state.nudges.delete(groupId);
    state.windows.delete(groupId);
    state.overrides.delete(groupId);
  }
  state.lastActive = activeId;
  state.stacks = stacks;
  state.scrollable = scrollable;
  if (state.slots !== slots) {
    state.slots = slots;
    dock.autosize();
  }
  positionStacks(dock);
}

function safeLayout(dock) {
  try {
    applySquadLayout(dock);
  } catch (err) {
    // Fall back to plain Carousel for this dock rather than leaving a half-built bar.
    logger.error("Carousel squad cards failed; showing the normal carousel", err);
    const state = stateFor(dock);
    state.failed = true;
    try { clearLayout(dock, state); }
    catch (cleanupError) { logger.error("Could not clear the carousel squad cards", cleanupError); }
  }
}

function shiftWindow(dock, groupId, step) {
  const state = stateFor(dock);
  state.windows.set(groupId, (state.windows.get(groupId) ?? 0) + step);
  dock.animateOrder();
}

function selectSquadTokens(model) {
  canvas.tokens.releaseAll();
  for (const member of model.members) {
    const token = member.token?.object;
    if (token?.document?.parent?.id === canvas.scene?.id) token.control({ releaseOthers: false });
  }
}

function toggleSquad(dock, card) {
  stateFor(dock).overrides.set(card.dataset.groupKey, !card.classList.contains("sci-expanded"));
  dock.animateOrder();
}

async function togglePin(dock, groupId) {
  if (!canManageGroups()) return;
  const group = dock.combat?.getFlag(MODULE_ID, `groups.${groupId}`);
  if (!group) return;
  // Pinning is the deliberate choice, so it replaces an earlier click on this squad.
  stateFor(dock).overrides.delete(groupId);
  try { await GroupManager.editGroup(dock.combat, groupId, { pinned: !group.pinned }); }
  catch (err) { ui.notifications.error(err.message); }
}

function squadMenuItems(dock) {
  const modelOf = (target) => getSquadCardModel(dock.combat, target.dataset.groupKey);
  const run = (action) => async (_event, target) => {
    const model = modelOf(target);
    if (!model) return;
    try { await action(model); }
    catch (err) { ui.notifications.error(err.message); }
  };
  const manages = () => canManageGroups();
  const moraleOn = () => manages() && setting("moraleEnabled") === true;
  return [
    { label: "SCI.Card.Roll", icon: '<i class="fa-solid fa-dice-d20"></i>', visible: (target) => manages() && !!modelOf(target)?.unrolled, onClick: run((model) => GroupManager.rollGroupAndApplyInitiative(dock.combat, model.groupId)) },
    { label: "SCI.Card.Skip", icon: '<i class="fa-solid fa-forward-step"></i>', visible: (target) => manages() && !!modelOf(target)?.active, onClick: run((model) => GroupManager.skipGroupTurn(dock.combat, model.groupId)) },
    { label: "SCI.Card.Morale", icon: '<i class="fa-solid fa-flag"></i>', visible: (target) => moraleOn() && !!modelOf(target)?.living, onClick: run((model) => MoraleManager.rollMorale(dock.combat, model.groupId)) },
    { label: "SCI.Card.Rally", icon: '<i class="fa-solid fa-shield"></i>', visible: (target) => moraleOn() && !!modelOf(target)?.broken, onClick: run((model) => MoraleManager.rallyMorale(dock.combat, model.groupId)) },
    { label: "SCI.Card.Select", icon: '<i class="fa-solid fa-object-group"></i>', visible: manages, onClick: run(selectSquadTokens) },
    { label: "SCI.Carousel.ToggleVisibility", icon: '<i class="fa-solid fa-eye"></i>', visible: manages, onClick: run((model) => GroupManager.toggleGroupVisibility(dock.combat, model.groupId)) },
  ];
}

function bindContainer(dock, container) {
  if (boundContainers.has(container)) return;
  boundContainers.add(container);

  container.addEventListener("wheel", (event) => {
    const target = event.target.closest(".sci-carousel-squad.sci-expanded, .sci-carousel-nudge, .combatant-portrait.sci-carousel-member");
    if (!target) return;
    const groupId = target.dataset.groupKey ?? dock.combat?.combatants.get(target.dataset.combatantId)?.getFlag(MODULE_ID, "groupId");
    if (!groupId || !stateFor(dock).scrollable.has(groupId)) return;
    event.preventDefault();
    shiftWindow(dock, groupId, Math.sign(event.deltaY || event.deltaX));
  }, { passive: false });

  container.addEventListener("scroll", () => positionStacks(dock), { passive: true });

  container.addEventListener("click", (event) => {
    const nudge = event.target.closest(".sci-carousel-nudge");
    if (nudge) {
      event.stopPropagation();
      shiftWindow(dock, nudge.dataset.groupKey, Number(nudge.dataset.step));
      return;
    }
    const card = event.target.closest(".sci-carousel-squad");
    if (!card) return;
    event.stopPropagation();
    const cycleControl = event.target.closest("[data-sci-carousel-step]");
    if (cycleControl) {
      shiftWindow(dock, card.dataset.groupKey, Number(cycleControl.dataset.sciCarouselStep));
      return;
    }
    if (event.target.closest("[data-sci-carousel-pin]")) {
      togglePin(dock, card.dataset.groupKey);
      return;
    }
    toggleSquad(dock, card);
  });

  container.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key) || !event.target.classList.contains("sci-carousel-squad")) return;
    event.preventDefault();
    toggleSquad(dock, event.target);
  });

  // Carousel's drag rewrites initiative, which would pull a member out of its squad's order.
  container.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && event.target.closest(".combatant-portrait.sci-carousel-member")) event.stopPropagation();
  }, { capture: true });

  new foundry.applications.ux.ContextMenu.implementation(container, ".sci-carousel-squad", squadMenuItems(dock), { jQuery: false, fixed: true });
}

/**
 * Wraps Carousel's dock when its active version offers what the layout needs. Cards stay off until the world
 * setting turns them on, and any mismatch leaves Carousel untouched.
 * @returns {boolean} Whether the wrappers were registered.
 */
export function registerCarouselSquads() {
  if (!game.modules.get(CAROUSEL_MODULE_ID)?.active || !game.modules.get("lib-wrapper")?.active) return false;
  if (carouselAvailability() !== "available") {
    logger.warn("This Carousel Combat Tracker version is not supported; squad cards are off");
    return false;
  }

  const dockPath = "CONFIG.combatTrackerDock.CombatDock.prototype";
  libWrapper.register(MODULE_ID, `${dockPath}.updateOrder`, function (wrapped, ...args) {
    const result = wrapped(...args);
    safeLayout(this);
    return result;
  }, "WRAPPER");

  // Carousel centers by assuming every portrait is shown, so center on the real element instead.
  libWrapper.register(MODULE_ID, `${dockPath}.centerCurrentCombatant`, function (wrapped, ...args) {
    const result = wrapped(...args);
    if (this.element && setting("carouselSquadCards") === true && !stateFor(this).failed && !this.leftAligned) {
      const portrait = this.portraits.find((candidate) => candidate.combatant === this.combat?.combatant);
      // A stacked or collapsed member can't be scrolled to, so the list centers on its card instead.
      const offBar = portrait?.element.classList.contains("sci-carousel-stacked") || portrait?.element.classList.contains("sci-carousel-collapsed");
      const target = offBar ? stateFor(this).cards.get(portrait.combatant.getFlag(MODULE_ID, "groupId")) : portrait?.element;
      target?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }
    return result;
  }, "WRAPPER");

  // Carousel sizes portraits from its full portrait count, which would keep them tiny once squads collapse.
  libWrapper.register(MODULE_ID, `${dockPath}.autosize`, function (wrapped, ...args) {
    const result = wrapped(...args);
    const { slots, failed } = stateFor(this);
    if (slots && !failed && setting("carouselSquadCards") === true && this.autoFit) {
      const max = parseInt(game.settings.get(CAROUSEL_MODULE_ID, "portraitSize"));
      const aspect = game.settings.get(CAROUSEL_MODULE_ID, "portraitAspect");
      const floating = game.settings.get(CAROUSEL_MODULE_ID, "floatingSize") / 100;
      let size;
      if (this.isVertical) size = Math.min(max * aspect, Math.floor(window.innerHeight * floating / slots)) / aspect;
      else {
        const space = this.isDocked ? document.getElementById("ui-top").getBoundingClientRect().width * 0.9 : window.innerWidth * floating;
        size = Math.min(max, Math.floor(space / slots)) / 1.2;
      }
      document.documentElement.style.setProperty("--combatant-portrait-size", `${size}px`);
    }
    positionStacks(this);
    return result;
  }, "WRAPPER");

  const refresh = foundry.utils.debounce(() => {
    const dock = ui.combatDock;
    if (dock?.element && dock.portraits?.length) dock.animateOrder();
  }, 50);
  Hooks.on("updateCombat", (combat, changed) => { if (changed.flags?.[MODULE_ID]) refresh(); });
  Hooks.on("updateCombatant", refresh);
  Hooks.on("updateActor", refresh);
  // An unlinked token's hit points change through its delta.
  Hooks.on("updateToken", (_document, changed) => { if ("disposition" in changed || "delta" in changed) refresh(); });
  Hooks.on("updateSetting", (document) => { if (document.key?.startsWith(`${MODULE_ID}.carousel`)) refresh(); });
  return true;
}
