/** Squad initiative implementation: rolls, aggregates, reconciliation and the per-combat queue. Invoked with GroupManager as `this`. */
import { MODULE_ID, logger, isGM, INITIATIVE_MODE, calculateGroupInitiative, sanitizeColor, sanitizeImagePath, formatModifier, localizeEnumValue, unnamedGroup, TEMPLATES, renderModuleTemplate } from "./shared.js";
import { getRawInitiative } from "./initiative-ordering.js";
import { assertMutationAuthority } from "./mutation-authority.js";
import { updateCombatState, updateMembers } from "./combat-state.js";
import { initiativeInputs, UNGROUPED, INITIATIVE_UPDATE_OPTION } from "./group-contracts.js";

/** Implementation of GroupManager.setBulkRollInProgress; the facade in group-manager.js carries the public contract. */
export function setBulkRollInProgress(combat, active) {
  if (!combat?.id) return;
  if (active) this._bulkRollCombats.add(combat.id);
  else this._bulkRollCombats.delete(combat.id);
  this._bulkRollInProgress = this._bulkRollCombats.size > 0;
}

/** Implementation of GroupManager.isBulkRollInProgress; the facade in group-manager.js carries the public contract. */
export function isBulkRollInProgress(combat) {
  return !!combat?.id && this._bulkRollCombats.has(combat.id);
}

/** Implementation of GroupManager._enqueueInitiativeOperation; the facade in group-manager.js carries the public contract. */
export function _enqueueInitiativeOperation(combat, operation) {
  if (!combat?.id) return Promise.resolve().then(operation);
  const key = combat.id;
  const previous = this._initiativeQueues.get(key) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(operation);
  const tracked = queued.finally(() => {
    if (this._initiativeQueues.get(key) === tracked) this._initiativeQueues.delete(key);
  });
  this._initiativeQueues.set(key, tracked);
  return tracked;
}

/** Implementation of GroupManager.rollGroupAndApplyInitiative; the facade in group-manager.js carries the public contract. */
export async function rollGroupAndApplyInitiative(combat, groupId, { mode = "normal" } = {}) {
  const log = logger.fn("rollGroupAndApplyInitiative");

  if (!isGM()) {
    log.warn("Non-GM attempted to roll group initiative");
    return;
  }

  const groupMeta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
  const groupName = groupMeta.name ?? unnamedGroup();

  const members = combat.combatants.filter(
    (c) => c.getFlag(MODULE_ID, "groupId") === groupId
  );
  const toRoll = members.filter((c) => c.initiative == null);

  if (!toRoll.length) {
    if (!Number.isFinite(groupMeta.initiative) && members.every((c) => Number.isFinite(getRawInitiative(c)))) {
      return this._local.finalizeGroupInitiative(combat, groupId);
    }
    return ui.notifications.info(game.i18n.format("SCI.Notifications.AlreadyRolled", { name: groupName }));
  }

  log.groupStart(`Rolling initiative for "${groupName}"`, {
    groupId,
    mode,
    memberCount: toRoll.length,
  });

  try {
    const rolledSummary = [];

    for (const c of toRoll) {
      const roll = this._getInitiativeRoll(c, mode);
      if (!roll) {
        log.warn(`Could not prepare initiative roll for ${c.name}`);
        continue;
      }
      assertMutationAuthority();
      await roll.evaluate();

      assertMutationAuthority();
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: c.actor, token: c.token, alias: c.name }),
        flavor: game.i18n.format("SCI.Chat.InitiativeFlavor", { name: c.name }),
        flags: { "core.initiativeRoll": true },
      }, { messageMode: "gm" });

      const dexValue = c.actor?.system?.abilities?.dex?.value ?? 10;
      rolledSummary.push({
        combatant: c,
        name: c.name,
        init: roll.total,
        dex: dexValue,
      });

      // Verbose: log each roll individually
      log.trace(`Rolled for ${c.name}`, { total: roll.total, dex: dexValue });
    }

    // Normal: single summary of all rolls
    log.debug("Rolled initiative for group", {
      rolls: rolledSummary.map(r => `${r.name}: ${r.init} (DEX ${r.dex})`),
    });

    if (!rolledSummary.length) {
      log.groupEnd("no rolls prepared");
      return;
    }

    await this._enqueueInitiativeOperation(combat, async () => {
      await updateMembers(combat,
        rolledSummary.map((r) => ({ _id: r.combatant.id, initiative: r.init })),
        { [INITIATIVE_UPDATE_OPTION]: true }
      );

      // Combat5e performs initiative-period recovery after native tracker rolls.
      // Preserve that lifecycle for the module's actor-aware advantage rolls.
      if (typeof combat._recoverUses === "function") {
        for (const entry of rolledSummary) {
          assertMutationAuthority();
          await combat._recoverUses({ initiative: entry.combatant });
        }
      }

      const rolledById = new Map(rolledSummary.map((entry) => [entry.combatant.id, entry]));
      const completeSummary = members.map((combatant) => rolledById.get(combatant.id) ?? ({
        combatant,
        name: combatant.name,
        init: getRawInitiative(combatant),
        dex: combatant.actor?.system?.abilities?.dex?.value ?? 10,
      }));

      await this._applyGroupOrder(combat, groupId, completeSummary, { sendSummary: true });
    });

    log.groupEnd("success");
  } catch (err) {
    log.groupEnd("failed");
    log.errorNotify(game.i18n.format("SCI.Errors.RollGroup", { name: groupName }), err);
    throw err;
  }
}

/** Implementation of GroupManager.finalizeGroupInitiative; the facade in group-manager.js carries the public contract. */
export async function finalizeGroupInitiative(combat, groupId, _options = {}) {
  if (!combat?.id || !groupId) return false;
  // Each request reads current documents when it reaches the queue. A request
  // arriving during an awaited write must not share the stale computation.
  return this._enqueueInitiativeOperation(combat, () =>
    this._reconcileGroupInitiativeNow(combat, groupId, { sendSummary: true }));
}

/** Implementation of GroupManager._getInitiativeRoll; the facade in group-manager.js carries the public contract. */
export function _getInitiativeRoll(combatant, mode = "normal") {
  const advantage = mode === "advantage";
  const disadvantage = mode === "disadvantage";
  const rollOptions = {};
  if (advantage) rollOptions.advantage = true;
  if (disadvantage) rollOptions.disadvantage = true;

  if (combatant.actor && typeof combatant.actor.getInitiativeRoll === "function") {
    return combatant.actor.getInitiativeRoll(rollOptions);
  }

  if (!advantage && !disadvantage && typeof combatant.getInitiativeRoll === "function") {
    return combatant.getInitiativeRoll();
  }

  const dieExpr = advantage ? "2d20kh"
    : disadvantage ? "2d20kl"
      : "1d20";
  const dexMod = combatant.actor?.system?.abilities?.dex?.mod ?? 0;
  const formula = dexMod >= 0 ? `${dieExpr} + ${dexMod}` : `${dieExpr} - ${Math.abs(dexMod)}`;
  return new Roll(formula);
}

/** Implementation of GroupManager._applyGroupOrder; the facade in group-manager.js carries the public contract. */
export async function _applyGroupOrder(
  combat,
  groupId,
  list,
  { sendSummary = false } = {}
) {
  if (!isGM()) return;

  const log = logger.fn("_applyGroupOrder");
  const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`) ?? {};
  const groupName = meta.name ?? unnamedGroup();

  this._sortOrderList(list);

  const mode = Object.values(INITIATIVE_MODE).includes(meta.initiativeMode)
    ? meta.initiativeMode
    : INITIATIVE_MODE.AVERAGE;
  let captainInit = null;
  if (mode === INITIATIVE_MODE.CAPTAIN && meta.captainId) {
    const captainEntry = list.find(r => r.combatant.id === meta.captainId);
    captainInit = captainEntry?.init ?? null;
  }
  const avgInit = calculateGroupInitiative(list.map(r => r.init), mode, captainInit);

  const memberDexMods = list.map(r => r.combatant.actor?.system?.abilities?.dex?.mod ?? 0);
  const avgDexMod = memberDexMods.length > 0
    ? (memberDexMods.reduce((a, b) => a + b, 0) / memberDexMods.length)
    : 0;

  const rawUpdates = list.filter(entry => entry.combatant.getFlag(MODULE_ID, "rawInitiative") !== entry.init);
  const inputs = initiativeInputs(combat, groupId);
  if (!rawUpdates.length && meta.initiative === avgInit && meta.initiativeTiebreaker === avgDexMod && meta.initiativeInputs === inputs && meta.initiativeSource === "computed") return;

  log.debug("Calculated group order", {
    groupName,
    avgInit,
    memberOrder: list.map(r => `${r.name}: ${r.init}`),
  });

  try {
    if (rawUpdates.length) await updateMembers(combat, rawUpdates.map((entry) => ({
      _id: entry.combatant.id,
      [`flags.${MODULE_ID}.rawInitiative`]: entry.init,
    })), { [INITIATIVE_UPDATE_OPTION]: true });
    await updateCombatState(combat, {
      [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: avgInit,
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeSource`]: "computed",
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeInputs`]: inputs,
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeTiebreaker`]: avgDexMod,
    });
  } catch (err) {
    log.error(`Error applying group order for "${groupName}"`, err);
    throw err;
  }

  if (sendSummary) {
    try {
      const gmIds = game.users.filter((u) => u.isGM).map((u) => u.id);

      // Compute summary stats
      const totalInit = list.reduce((sum, r) => sum + r.init, 0);
      const highRoll = Math.max(...list.map(r => r.init));
      const lowRoll = Math.min(...list.map(r => r.init));
      const content = await renderModuleTemplate(TEMPLATES.CHAT_INITIATIVE_SUMMARY, {
        groupColor: sanitizeColor(meta.color, "#7b68ee"),
        groupImg: sanitizeImagePath(meta.img, "icons/svg/combat.svg"),
        groupName,
        groupInit: avgInit,
        totalInit,
        highRoll,
        lowRoll,
        avgDexMod: formatModifier(Math.round(avgDexMod * 10) / 10),
        memberCount: list.length,
        modeLabel: localizeEnumValue("SCI.InitiativeModeName", mode),
        captainName: mode === INITIATIVE_MODE.CAPTAIN && meta.captainId
          ? (list.find(r => r.combatant.id === meta.captainId)?.name ?? game.i18n.localize("SCI.Unknown"))
          : null,
        rows: list.map((r) => ({
          img: sanitizeImagePath(r.combatant.img || r.combatant.token?.texture?.src || "", ""),
          name: r.name,
          init: r.init,
          dexMod: formatModifier(r.combatant.actor?.system?.abilities?.dex?.mod ?? 0),
        })),
      });

      assertMutationAuthority();
      await ChatMessage.create({
        content,
        whisper: gmIds,
        blind: true,
      });
    } catch (err) {
      log.warn("Failed to create chat summary", { error: err.message });
    }
  }

  log.success(`Applied group order for "${groupName}"`);
}

/** Implementation of GroupManager._shapeOrderEntry; the facade in group-manager.js carries the public contract. */
export function _shapeOrderEntry(combatant) {
  return {
    combatant,
    name: combatant.name,
    init: getRawInitiative(combatant),
    dex: combatant.actor?.system?.abilities?.dex?.value ?? 10,
  };
}

/** Implementation of GroupManager._sortOrderList; the facade in group-manager.js carries the public contract. */
export function _sortOrderList(list) {
  list.sort((a, b) =>
    (b.init ?? -Infinity) - (a.init ?? -Infinity)
    || (b.dex ?? 0) - (a.dex ?? 0)
    || String(a.combatant?.id ?? "").localeCompare(String(b.combatant?.id ?? ""))
  );
  return list;
}

/** Implementation of GroupManager._buildNormalizedGroupUpdates; the facade in group-manager.js carries the public contract. */
export function _buildNormalizedGroupUpdates(combat, updatedGroupId = null, updatedBase = null, updatedOrder = null) {
  const allGroups = combat.getFlag(MODULE_ID, "groups") ?? {};
  const entries = [];

  for (const [gid, data] of Object.entries(allGroups)) {
    const members = combat.combatants.filter((c) => c.getFlag(MODULE_ID, "groupId") === gid);
    if (!members.length) continue;

    const base = gid === updatedGroupId ? updatedBase : data.initiative;
    if (!Number.isFinite(base)) continue;

    const order = gid === updatedGroupId && updatedOrder
      ? updatedOrder.map((entry) => ({ ...entry }))
      : members.map((combatant) => this._shapeOrderEntry(combatant));
    if (!order.length || order.some((entry) => !Number.isFinite(entry.init))) continue;

    this._sortOrderList(order);
    const avgDex = members.reduce((sum, c) => sum + (c.actor?.system?.abilities?.dex?.mod ?? 0), 0) / members.length;
    entries.push({ id: gid, initiative: base, avgDex, order });
  }

  entries.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    if (b.avgDex !== a.avgDex) return b.avgDex - a.avgDex;
    return a.id.localeCompare(b.id);
  });

  // Retained for diagnostics/API compatibility. Ordering is now supplied by
  // the Combat comparator wrapper, so normalization never writes documents.
  return { updates: [], entries };
}

/** Implementation of GroupManager.setGroupInitiative; the facade in group-manager.js carries the public contract. */
export async function setGroupInitiative(combat, groupId, value) {
  const log = logger.fn("setGroupInitiative");

  if (!isGM()) {
    log.warn("Non-GM attempted to set group initiative");
    return;
  }
  if (!Number.isFinite(value)) {
    ui.notifications.warn(game.i18n.localize("SCI.Notifications.InvalidInitiative"));
    return;
  }

  await this._enqueueInitiativeOperation(combat, async () => {
    const members = combat.combatants.filter(c => c.getFlag(MODULE_ID, "groupId") === groupId);
    if (!members.length || !combat.getFlag(MODULE_ID, `groups.${groupId}`)) return;
    const avgDexMod = members.reduce((sum, c) => sum + (c.actor?.system?.abilities?.dex?.mod ?? 0), 0) / members.length;
    await updateMembers(combat, members.map((combatant) => {
      const raw = getRawInitiative(combatant) ?? value;
      return {
        _id: combatant.id,
        ...(!Number.isFinite(combatant.initiative) ? { initiative: raw } : {}),
        [`flags.${MODULE_ID}.rawInitiative`]: raw,
      };
    }), { [INITIATIVE_UPDATE_OPTION]: true });
    await updateCombatState(combat, {
      [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: value,
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeSource`]: "manual",
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeInputs`]: initiativeInputs(combat, groupId),
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeTiebreaker`]: avgDexMod,
    });
  });

  const groupName = combat.getFlag(MODULE_ID, `groups.${groupId}`)?.name ?? unnamedGroup();
  log.debug(`Set group initiative to ${value}`, { groupId, groupName });
}

/** Implementation of GroupManager.resetGroupInitiative; the facade in group-manager.js carries the public contract. */
export async function resetGroupInitiative(combat, groupId) {
  const log = logger.fn("resetGroupInitiative");

  if (!isGM()) {
    log.warn("Non-GM attempted to reset group initiative");
    return;
  }

  const members = combat.combatants.filter(
    (c) => c.getFlag(MODULE_ID, "groupId") === groupId
  );

  const updates = members.map((c) => ({
    _id: c.id,
    initiative: null,
    [`flags.${MODULE_ID}.rawInitiative`]: new foundry.data.operators.ForcedDeletion(),
  }));

  await this._enqueueInitiativeOperation(combat, async () => {
    await updateMembers(combat,
      updates,
      { [INITIATIVE_UPDATE_OPTION]: true }
    );
    await updateCombatState(combat, {
      [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: null,
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeSource`]: "computed",
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeInputs`]: initiativeInputs(combat, groupId),
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeTiebreaker`]: null,
    });
  });

  const groupName = combat.getFlag(MODULE_ID, `groups.${groupId}`)?.name ?? unnamedGroup();
  log.debug(`Reset initiative for "${groupName}"`, { groupId });
}

/** Implementation of GroupManager.reconcileGroupInitiatives; the facade in group-manager.js carries the public contract. */
export async function reconcileGroupInitiatives(combat, groupIds) {
  const ids = [...new Set(Array.from(groupIds ?? []).filter((id) => id && id !== UNGROUPED))];
  if (!combat || !ids.length) return;
  return this._enqueueInitiativeOperation(combat, async () => {
    for (const groupId of ids) await this._reconcileGroupInitiativeNow(combat, groupId);
  });
}

/** Implementation of GroupManager._reconcileGroupInitiativeNow; the facade in group-manager.js carries the public contract. */
export async function _reconcileGroupInitiativeNow(combat, groupId, { sendSummary = false } = {}) {
  const meta = combat.getFlag(MODULE_ID, `groups.${groupId}`);
  if (!meta) return false;

  const members = combat.combatants.filter(
    (combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId
  );
  if (!members.length) {
    await updateCombatState(combat, {
      [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: null,
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeSource`]: "computed",
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeInputs`]: initiativeInputs(combat, groupId),
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeTiebreaker`]: null,
      [`flags.${MODULE_ID}.groups.${groupId}.captainId`]: null,
    });
    return false;
  }

  if (!members.every((combatant) => Number.isFinite(getRawInitiative(combatant)))) {
    await updateCombatState(combat, {
      [`flags.${MODULE_ID}.groups.${groupId}.initiative`]: null,
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeSource`]: "computed",
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeInputs`]: initiativeInputs(combat, groupId),
      [`flags.${MODULE_ID}.groups.${groupId}.initiativeTiebreaker`]: null,
    });
    return false;
  }

  const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
  if (group?.initiativeSource === "manual" && group.initiativeInputs === initiativeInputs(combat, groupId)) return true;

  const shaped = members.map((combatant) => this._shapeOrderEntry(combatant));
  await this._applyGroupOrder(combat, groupId, shaped, { sendSummary });
  return true;
}

/** Implementation of GroupManager.skipGroupTurn; the facade in group-manager.js carries the public contract. */
export async function skipGroupTurn(combat, groupId) {
  const turns = combat.turns ?? [];
  if (!combat.round || !Number.isInteger(combat.turn) || combat.combatant?.getFlag(MODULE_ID, "groupId") !== groupId) return false;
  for (let step = 1; step <= turns.length; step += 1) {
    const turn = (combat.turn + step) % turns.length;
    const next = turns[turn];
    if (next.getFlag(MODULE_ID, "groupId") === groupId || combat.settings?.skipDefeated && (next.isDefeated ?? next.defeated)) continue;
    const round = combat.round + (turn <= combat.turn ? 1 : 0);
    const data = { round, turn };
    const options = { direction: 1, worldTime: { delta: combat.getTimeDelta(combat.round, combat.turn, round, turn) } };
    Hooks.callAll(round === combat.round ? "combatTurn" : "combatRound", combat, data, options);
    assertMutationAuthority();
    await combat.update(data, options);
    return true;
  }
  ui.notifications.info(game.i18n.localize("SCI.Notifications.SkipNoTarget"));
  return false;
}

/** Implementation of GroupManager._recalculateGroupIfReady; the facade in group-manager.js carries the public contract. */
export async function _recalculateGroupIfReady(combat, groupId, { sendSummary = false } = {}) {
  return this._enqueueInitiativeOperation(combat, () => this._reconcileGroupInitiativeNow(combat, groupId, { sendSummary }));
}
