import test from "node:test";
import assert from "node:assert/strict";
import { environment } from "./fixtures.js";
environment();
const { rectOnScreen, fitFloatingDock, waitForStillDock } = await import("../scripts/diagnostics-automation.js");

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

test("a rectangle counts as on screen only inside the window, with a pixel of rounding", () => {
  assert.equal(rectOnScreen(rect(0, 0, 70, 105), [2752, 1130]), true);
  assert.equal(rectOnScreen(rect(-0.5, 1025.5, 70, 105), [2752, 1130]), true);
  // The 2026-11-05 vertical stack: a dock saved low on a 1130-high window put its members below the bottom.
  assert.equal(rectOnScreen(rect(884, 1101, 70, 105), [2752, 1130]), false);
  assert.equal(rectOnScreen(rect(-30, 200, 70, 105), [2752, 1130]), false);
  assert.equal(rectOnScreen(rect(2700, 200, 70, 105), [2752, 1130]), false);
});

function dockElement({ connected = true, box = rect(540, 452, 136, 678) } = {}) {
  return { isConnected: connected, getBoundingClientRect: () => box };
}

test("a floating dock is positioned again so Foundry fits it to the window, and a docked bar is left alone", () => {
  const calls = [];
  const floating = { isDocked: false, element: dockElement(), setPosition: (position) => calls.push(position) };
  assert.deepEqual(fitFloatingDock(floating), { left: 540, top: 452, width: 136, height: 678 });
  assert.deepEqual(calls, [{}]);

  const docked = { isDocked: true, element: dockElement(), setPosition: (position) => calls.push(position) };
  assert.equal(fitFloatingDock(docked), null);
  const closed = { isDocked: false, element: dockElement({ connected: false }), setPosition: (position) => calls.push(position) };
  assert.equal(fitFloatingDock(closed), null);
  assert.equal(fitFloatingDock(null), null);
  assert.equal(calls.length, 1);
});

function animation({ id = "", className = "sci-carousel-squad", iterations = 1, delay = 0, currentTime = 0, playState = "running" } = {}) {
  return { id, playState, currentTime, effect: { target: { className }, getTiming: () => ({ iterations, delay }) } };
}

test("waiting for a still dock reports nothing once its animations end", async () => {
  const running = [animation({ id: "combat-dock-flip" })];
  const list = { isConnected: true, getAnimations: () => running };
  setTimeout(() => { running[0].playState = "finished"; }, 30);
  assert.deepEqual(await waitForStillDock(list, 1000), []);
});

test("waiting for a still dock ignores endless animations and reports what never stopped", async () => {
  const intro = animation({ className: "combatant-portrait sci-carousel-member", delay: 2250, currentTime: 1656 });
  const blink = animation({ className: "combatant-portrait active", iterations: Infinity });
  const list = { isConnected: true, getAnimations: () => [intro, blink] };
  const still = await waitForStillDock(list, 60);
  assert.deepEqual(still, [{ id: null, target: "combatant-portrait sci-carousel-member", currentTime: 1656, delay: 2250 }]);

  const gone = { isConnected: false, getAnimations: () => [intro] };
  assert.deepEqual(await waitForStillDock(gone, 60), []);
});
