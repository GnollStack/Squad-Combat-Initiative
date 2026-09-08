/** Foundry lifecycle adapter for SCI ordering; every client installs the adapter. */
import { MODULE_ID } from "./shared.js";
import { assertMutationAuthority } from "./mutation-authority.js";

export const INTERNAL_UPDATE = "sciGroupInitiative";

export function refreshCombatOrder(combat, activeId = combat.current?.combatantId ?? combat.combatant?.id) {
  if (typeof combat.setupTurns !== "function") return;
  const round = combat.round;
  const oldTurn = combat.turn;
  combat.setupTurns();
  restoreActiveMember(combat, activeId, round, oldTurn);
}

function restoreActiveMember(combat, activeId, round, oldTurn) {
  const index = combat.turns.findIndex(c => c.id === activeId);
  if (oldTurn === null) combat.turn = null;
  else if (index >= 0) combat.turn = index;
  else combat.turn = combat.turns.length ? Math.min(Math.max(oldTurn ?? 0, 0), combat.turns.length - 1) : null;
  combat.round = round;
  combat.turns.forEach((c, i) => { c.turnNumber = i; });
  if (combat.current) Object.assign(combat.current, {
    round: combat.round, turn: combat.turn, combatantId: combat.combatant?.id ?? null,
    tokenId: combat.combatant?.tokenId ?? null,
  });
}

/** Persist group flags, then publish the corrected active index without turn events. */
export async function updateCombatState(combat, changes, options = {}) {
  assertMutationAuthority();
  const activeId = options.sciActiveCombatantId ?? combat.current?.combatantId ?? combat.combatant?.id;
  await combat.update(changes, { ...options, [INTERNAL_UPDATE]: true, turnEvents: false, sciActiveCombatantId: activeId });
  const persistedTurn = combat._source?.turn ?? combat.turn;
  refreshCombatOrder(combat, activeId);
  if (combat.turn !== persistedTurn) {
    assertMutationAuthority();
    await combat.update({ turn: combat.turn }, { [INTERNAL_UPDATE]: true, turnEvents: false });
  }
  return combat;
}

export async function updateMembers(combat, changes, options = {}) {
  assertMutationAuthority();
  const activeId = combat.current?.combatantId ?? combat.combatant?.id;
  const result = await combat.updateEmbeddedDocuments("Combatant", changes, {
    ...options, [INTERNAL_UPDATE]: true, turnEvents: false, sciActiveCombatantId: activeId,
  });
  refreshCombatOrder(combat, activeId);
  if (combat._source && combat.turn !== combat._source.turn) {
    assertMutationAuthority();
    await combat.update({ turn: combat.turn }, { [INTERNAL_UPDATE]: true, turnEvents: false });
  }
  return result;
}

export function setCombatFlag(combat, key, value) {
  return updateCombatState(combat, { [`flags.${MODULE_ID}.${key}`]: value });
}

/** Run before core _onUpdate uses the turn array, preserving core history bookkeeping. */
export function beforeCombatUpdate(combat, changed, options) {
  const groupChange = changed.flags?.[MODULE_ID]?.groups !== undefined
    || Object.keys(changed).some(key => key.startsWith(`flags.${MODULE_ID}.groups`));
  if (!groupChange) return;
  const previous = combat.current ? { ...combat.current } : null;
  refreshCombatOrder(combat, options.sciActiveCombatantId ?? previous?.combatantId);
  if (previous) combat.current = previous;
}

export function registerCombatStateWrappers(combatPath) {
  // Core sorts inside its private descendant handler. Restore the ID before
  // that handler records history, on every connected client.
  libWrapper.register(MODULE_ID, `${combatPath}.prototype.setupTurns`, function (wrapped, ...args) {
    const state = this._sciPreserveTurn;
    const result = wrapped(...args);
    if (state) restoreActiveMember(this, state.id, state.round, state.turn);
    return result;
  }, "WRAPPER");
  for (const method of ["_onCreateDescendantDocuments", "_onUpdateDescendantDocuments", "_onDeleteDescendantDocuments"]) {
    libWrapper.register(MODULE_ID, `${combatPath}.prototype.${method}`, function (wrapped, parent, collection, documents, data, options, userId) {
      const previous = this._sciPreserveTurn;
      const nativeGroupChange = collection === "groups" && Object.keys(this.getFlag(MODULE_ID, "groups") ?? {}).length > 0;
      const activeId = this.current?.combatantId;
      if (collection === "combatants" && options?.[INTERNAL_UPDATE]) {
        this._sciPreserveTurn = { id: options.sciActiveCombatantId ?? this.current?.combatantId, round: this.round, turn: this.turn };
      }
      try {
        const result = wrapped(parent, collection, documents, data, options, userId);
        // dnd5e rebuilds after native group updates only on the initiating client.
        // Every client must observe the same order when SCI and native groups coexist.
        if (nativeGroupChange) refreshCombatOrder(this, activeId);
        return result;
      }
      finally { this._sciPreserveTurn = previous; }
    }, "WRAPPER");
  }
  libWrapper.register(MODULE_ID, `${combatPath}.prototype._onUpdate`, function (wrapped, changed, options, userId) {
    beforeCombatUpdate(this, changed, options);
    return wrapped(changed, options, userId);
  }, "WRAPPER");
}
