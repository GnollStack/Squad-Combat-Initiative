import test from "node:test";
import assert from "node:assert/strict";
import { environment } from "./fixtures.js";
environment();
const { buildCarouselUnits, orderCarouselUnits, squadWindowStart, memberFade, currentFirstOrder, squadIsExpanded, nextUnitIndex, squadHealth, orientStack, carouselAvailability, registerCarouselSquads } = await import("../scripts/carousel-squads.js");

const ids = units => units.map(unit => unit.groupId ?? unit.members[0].id);

test("units gather a squad at its first member even when its members are not contiguous", () => {
  const squads = { a: "x", b: null, c: "x", d: "y" };
  const units = buildCarouselUnits(["a", "b", "c", "d"].map(id => ({ id })), member => squads[member.id]);
  assert.deepEqual(ids(units), ["x", "b", "y"]);
  assert.deepEqual(units[0].members.map(member => member.id), ["a", "c"]);
});

test("rotation centers or leads with the active unit and leaves basic mode in turn order", () => {
  const units = ["a", "b", "c", "d", "e"].map(groupId => ({ groupId, members: [] }));
  assert.deepEqual(ids(orderCarouselUnits(units, 0, { trueCarousel: true, leftAligned: false })), ["d", "e", "a", "b", "c"]);
  assert.deepEqual(ids(orderCarouselUnits(units, 3, { trueCarousel: true, leftAligned: false })), ["b", "c", "d", "e", "a"]);
  assert.deepEqual(ids(orderCarouselUnits(units, 3, { trueCarousel: true, leftAligned: true })), ["d", "e", "a", "b", "c"]);
  assert.deepEqual(ids(orderCarouselUnits(units, 3, { trueCarousel: false, leftAligned: false })), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids(orderCarouselUnits(units, -1, { trueCarousel: true, leftAligned: true })), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(orderCarouselUnits([], -1, { trueCarousel: true, leftAligned: false }), []);
});

test("the member window clamps to the list and follows the active member only when asked", () => {
  assert.equal(squadWindowStart(10, 7, 0, 5, true), 3);
  assert.equal(squadWindowStart(10, 2, 6, 5, true), 2);
  assert.equal(squadWindowStart(10, 7, 0, 5, false), 0);
  assert.equal(squadWindowStart(10, -1, 99, 5, true), 5);
  assert.equal(squadWindowStart(10, 3, -4, 5, false), 0);
  assert.equal(squadWindowStart(3, 2, 1, 5, true), 0);
});

test("up next looks past the active unit, wraps, and skips units with no turn", () => {
  const units = ["a", "b", "c", "d"].map(groupId => ({ groupId }));
  const all = () => true;
  assert.equal(nextUnitIndex(units, 0, all), 1);
  assert.equal(nextUnitIndex(units, 3, all), 0);
  assert.equal(nextUnitIndex(units, 0, unit => unit.groupId === "c"), 2);
  assert.equal(nextUnitIndex(units, 0, () => false), -1);
  assert.equal(nextUnitIndex(units, -1, all), -1);
  assert.equal(nextUnitIndex([units[0]], 0, all), -1);
});

test("squad health totals members and ignores those without hit points", () => {
  const member = hp => ({ actor: { system: { attributes: { hp } } } });
  assert.deepEqual(squadHealth([member({ value: 5, max: 10 }), member({ value: 10, max: 10 })]), { value: 15, max: 20, percent: 75 });
  assert.deepEqual(squadHealth([member({ value: 5, max: 10, effectiveMax: 20 })]), { value: 5, max: 20, percent: 25 });
  assert.deepEqual(squadHealth([member({ value: 99, max: 10 }), member({ value: -5, max: 10 })]), { value: 10, max: 20, percent: 50 });
  assert.deepEqual(squadHealth([member({ value: 3, max: 0 }), {}, member({ value: 1, max: 2 })]), { value: 1, max: 2, percent: 50 });
  assert.equal(squadHealth([{}]), null);
  assert.equal(squadHealth([]), null);
});

test("a stack opening backward keeps its first member by the card and flips its arrows and fades", () => {
  const classes = () => { const set = new Set(); return { toggle: (name, on) => (on ? set.add(name) : set.delete(name)), has: name => set.has(name) }; };
  const element = (id, step) => ({ id, classList: classes(), dataset: step ? { step: String(step) } : {}, firstElementChild: {} });
  const stack = () => [element("previous", -1), element("first"), element("second"), element("next", 1)];

  const down = stack();
  assert.deepEqual(orientStack(down, false, ["up", "down"]).map(item => item.id), ["previous", "first", "second", "next"]);
  assert.match(down[0].firstElementChild.className, /chevron-up/);
  assert.match(down[3].firstElementChild.className, /chevron-down/);
  assert.equal(down[1].classList.has("sci-fade-reversed"), false);

  const up = stack();
  assert.deepEqual(orientStack(up, true, ["up", "down"]).map(item => item.id), ["next", "second", "first", "previous"]);
  assert.match(up[0].firstElementChild.className, /chevron-down/);
  assert.match(up[3].firstElementChild.className, /chevron-up/);
  assert.equal(up[1].classList.has("sci-fade-reversed"), true);

  const left = stack();
  orientStack(left, true, ["left", "right"]);
  assert.match(left[0].firstElementChild.className, /chevron-right/);
  assert.match(left[3].firstElementChild.className, /chevron-left/);
});

test("a click wins, then the squad's turn, its pin and the setting", () => {
  const expanded = (state = {}) => squadIsExpanded({ active: false, pinned: false, keptOpen: false, override: undefined, ...state });
  assert.equal(expanded(), false);
  assert.equal(expanded({ active: true }), true);
  assert.equal(expanded({ pinned: true }), true);
  assert.equal(expanded({ keptOpen: true }), true);
  assert.equal(expanded({ override: true }), true);
  assert.equal(expanded({ active: true, override: false }), false);
  assert.equal(expanded({ pinned: true, override: false }), false);
});

test("current member first rotates those who acted to the end", () => {
  const members = ["a", "b", "c", "d"].map(id => ({ id }));
  const order = current => currentFirstOrder(members, current).map(member => member.id);
  assert.deepEqual(order("a"), ["a", "b", "c", "d"]);
  assert.deepEqual(order("c"), ["c", "d", "a", "b"]);
  assert.deepEqual(order("d"), ["d", "a", "b", "c"]);
  assert.deepEqual(order("elsewhere"), ["a", "b", "c", "d"]);
  assert.deepEqual(order(null), ["a", "b", "c", "d"]);
});

test("only a side with hidden members fades, and never the current member", () => {
  const fades = (count, before, after, current = -1) => Array.from({ length: count }, (_, index) => memberFade(index, count, before, after, index === current));
  assert.deepEqual(fades(5, false, false), [null, null, null, null, null]);
  assert.deepEqual(fades(5, false, true), [null, null, null, "near", "end"]);
  assert.deepEqual(fades(5, true, false), ["start", "near", null, null, null]);
  assert.deepEqual(fades(5, true, true), ["start", "near", null, "near", "end"]);
  assert.deepEqual(fades(5, true, true, 0), [null, "near", null, "near", "end"]);
  assert.deepEqual(fades(5, false, true, 4), [null, null, null, "near", null]);
  assert.deepEqual(fades(1, true, true), ["start"]);
});

test("availability separates not installed, not enabled and unsupported versions", () => {
  environment();
  const modules = new Map();
  game.modules = modules;
  assert.equal(carouselAvailability(), "notInstalled");
  modules.set("combat-tracker-dock", { active: false });
  assert.equal(carouselAvailability(), "notEnabled");
  modules.set("combat-tracker-dock", { active: true });
  assert.equal(carouselAvailability(), "unsupported");
  const method = () => {};
  CONFIG.combatTrackerDock = { CombatDock: { prototype: { updateOrder: method, autosize: method, centerCurrentCombatant: method } } };
  assert.equal(carouselAvailability(), "unsupported");
  CONFIG.combatTrackerDock.CombatDock.prototype.animateOrder = method;
  assert.equal(carouselAvailability(), "available");
});

test("nothing registers without an active Carousel, or with an unsupported one", () => {
  environment();
  const modules = new Map([["lib-wrapper", { active: true }]]);
  game.modules = modules;
  let registered = 0;
  globalThis.libWrapper = { register: () => { registered += 1; } };
  assert.equal(registerCarouselSquads(), false);
  modules.set("combat-tracker-dock", { active: true });
  assert.equal(registerCarouselSquads(), false);
  assert.equal(registered, 0);
  delete globalThis.libWrapper;
});
