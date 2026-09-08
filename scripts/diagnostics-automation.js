/**
 * @file diagnostics-automation.js
 * @description Gated MCP diagnostics fixture automation and cleanup.
 * @version Foundry V14+
 */

import {
  MODULE_ID,
  INITIATIVE_MODE,
  MORALE_TRIGGER,
  calculateGroupInitiative,
} from "./shared.js";
import { VISIBILITY_SYNC_MODE } from "./settings.js";
import { GroupManager, UNGROUPED } from "./group-manager.js";
import { DISCIPLINE, MoraleManager } from "./morale.js";
import { waitForMutations } from "./mutation-authority.js";

export const FIXTURE_PREFIX = "SCI-MCP-FIXTURE";
export const FIXTURE_FLAG = "diagnosticsFixture";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

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

export async function runAutomation(args = {}, context = {}) {
  assertActiveSceneReady();

  const validateData = context.validateData;
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
    clientAcceptance: null,
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
        let group = state.combat.getFlag(MODULE_ID, `groups.${groupId}`);
        assertAutomationCondition(Number.isFinite(group?.initiative), "Group initiative roll did not produce a finite initiative.", { mode, initiative: group?.initiative ?? null });
        const members = state.combat.combatants.filter(
          (combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId
        );
        const raw = members.map((combatant) => combatant.initiative);
        assertAutomationCondition(
          members.every((combatant) => combatant.getFlag(MODULE_ID, "rawInitiative") === combatant.initiative),
          "Raw initiative flags did not preserve native member rolls.",
          { mode, raw }
        );
        assertAutomationCondition(group.initiative === Math.max(...raw), "Highest mode did not use original member rolls.", { mode, group: group.initiative, raw });

        await GroupManager.editGroup(state.combat, groupId, { initiativeMode: INITIATIVE_MODE.LOWEST });
        group = state.combat.getFlag(MODULE_ID, `groups.${groupId}`);
        assertAutomationCondition(group.initiative === Math.min(...raw), "Mode switching did not recalculate from original member rolls.", { mode, group: group.initiative, raw });
        assertAutomationCondition(members.every((combatant, index) => combatant.initiative === raw[index]), "Mode switching rewrote native member initiative.", { mode, raw });

        await GroupManager.editGroup(state.combat, groupId, { initiativeMode: INITIATIVE_MODE.HIGHEST });
        results.push({ mode, initiative: Math.max(...raw), raw });
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

    await runAutomationStep(steps, "all aggregate modes preserve native member initiative", async () => {
      const groupId = state.groups[0];
      const members = state.combatants.slice(0, 2);
      const raw = members.map((member) => member.initiative);
      for (const mode of Object.values(INITIATIVE_MODE)) {
        await GroupManager.editGroup(state.combat, groupId, { initiativeMode: mode });
        const actual = state.combat.getFlag(MODULE_ID, `groups.${groupId}.initiative`);
        const expected = calculateGroupInitiative(raw, mode, raw[0]);
        assertAutomationCondition(actual === expected, "Aggregate mode did not use the original rolls.", { mode, actual, expected });
        assertAutomationCondition(members.every((member, index) => member.initiative === raw[index]), "Aggregate mode rewrote a member roll.", { mode });
      }
      return { modes: Object.values(INITIATIVE_MODE), raw };
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
      assertAutomationCondition(deleted && !state.combat.getFlag(MODULE_ID, `groups.${deleteGroupId}`), "Deleted group metadata remains.");
      const removed = state.combat.combatants.get(transientCombatantId);
      assertAutomationCondition(!removed.getFlag(MODULE_ID, "groupId") && !removed.getFlag(MODULE_ID, "rawInitiative"), "Deleted group left membership or raw initiative flags.");
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

    await runAutomationStep(steps, "bulk rolls preserve dnd5e recovery and contiguous tied squads", async () => {
      const actor = state.combatants[0].actor;
      const [item] = await actor.createEmbeddedDocuments("Item", [withFixtureFlag({
        name: fixtureName(runId, "Initiative Recovery"),
        type: "feat",
        system: { uses: { max: "1", spent: 1, recovery: [{ period: "initiative", type: "recoverAll" }] } },
      }, marker)]);
      for (const method of ["manual", "rollAll", "rollNPC"]) {
        for (const groupId of state.groups) await GroupManager.resetGroupInitiative(state.combat, groupId);
        await item.update({ "system.uses.spent": 1 });
        if (method === "manual") {
          for (const groupId of state.groups) await GroupManager.rollGroupAndApplyInitiative(state.combat, groupId);
        } else {
          const result = await state.combat[method]({ messageMode: "gm" });
          assertAutomationCondition(result === state.combat, "Bulk wrapper did not preserve the system return value.", { method });
        }
        assertAutomationCondition(actor.items.get(item.id).system.uses.spent === 0, "Initiative-period uses were not recovered.", { method });
        assertAutomationCondition(state.combatants.every((member) => Number.isFinite(member.initiative)), "Fixture NPC initiative was not rolled.", { method });
        assertAutomationCondition(!GroupManager.isBulkRollInProgress(state.combat), "Bulk roll guard was not cleared.", { method });
      }
      // Deliberately interleave native initiative across two equally ranked squads.
      await state.combat.updateEmbeddedDocuments("Combatant", state.combatants.map((member, index) => ({
        _id: member.id, initiative: [20, 1, 18, 2][index],
      })), { sciGroupInitiative: true });
      for (const groupId of state.groups) await GroupManager.setGroupInitiative(state.combat, groupId, 10);
      const order = state.combat.turns.map((member) => member.getFlag(MODULE_ID, "groupId"));
      assertAutomationCondition(order[0] === order[1] && order[2] === order[3] && order[0] !== order[2], "Tied squads are not contiguous in the live combat comparator.", { order });
      return { methods: ["manual", "rollAll", "rollNPC"], recovery: true, order };
    });

    await runAutomationStep(steps, "started encounter preserves active member during reordering and skip", async () => {
      await state.combat.startCombat();
      const activeId = state.combat.combatant.id;
      const groupId = state.combat.combatant.getFlag(MODULE_ID, "groupId");
      await GroupManager.setGroupInitiative(state.combat, groupId, -10);
      assertAutomationCondition(state.combat.combatant.id === activeId, "SCI reordering changed the active combatant.");
      assertAutomationCondition(state.combat.turns.at(-1).getFlag(MODULE_ID, "groupId") === groupId, "Lowering the score left stale turn order.");
      assertAutomationCondition(state.combat._source.turn === state.combat.turn, "Preserved turn index was not persisted.");
      await ui.combat.render({ force: true });
      const root = ui.combat.element;
      const rows = Array.from(root.querySelectorAll("li[data-combatant-id]"));
      ui.combat.renderGroups(root); ui.combat.renderGroups(root);
      assertAutomationCondition(root.querySelectorAll(".sci-combatant-group[data-group-key]").length === state.groups.length, "Repeated rendering duplicated or lost squad cards.");
      assertAutomationCondition(rows.every(row => root.contains(row)), "Card rendering replaced native member rows.");
      await GroupManager.skipGroupTurn(state.combat, groupId);
      assertAutomationCondition(state.combat.combatant.getFlag(MODULE_ID, "groupId") !== groupId, "Skip did not leave the active squad.");
      if (context.collectClientDiagnostics) state.clientAcceptance = await context.collectClientDiagnostics({ includeDom: true, expectedNonGMClients: 1, expectedGMClients: 2 });
      return { activeId, preservedTurn: true, cardCount: state.groups.length, clientStatus: state.clientAcceptance?.status ?? "not-run" };
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

    await runAutomationStep(steps, "morale effects use V14 images and preserve unrelated effects", async () => {
      const target = state.combatants[0];
      const actor = target.actor;
      const results = [];
      for (const status of ["frightened", "prone", "fleeing", "none"]) {
        await game.settings.set(MODULE_ID, "moraleStatusEffect", status);
        const [unrelated] = await actor.createEmbeddedDocuments("ActiveEffect", [withFixtureFlag({
          name: fixtureName(runId, `Unrelated ${status}`),
          img: "icons/svg/aura.svg",
          statuses: status === "none" ? [] : [status],
        }, marker)]);
        await MoraleManager.applyMoraleEffect(target);
        const managed = actor.effects.filter((effect) => effect.getFlag(MODULE_ID, "moraleEffect"));
        assertAutomationCondition(managed.length === (status === "none" ? 0 : 1), "Unexpected number of module-owned morale effects.", { status, count: managed.length });
        if (status === "fleeing") assertAutomationCondition(managed[0].img === "icons/svg/terror.svg", "Fleeing effect image was lost during V14 data validation.");
        await MoraleManager.clearMoraleEffect(target);
        assertAutomationCondition(actor.effects.has(unrelated.id), "Clearing morale removed an unrelated effect.", { status });
        assertAutomationCondition(!actor.effects.some((effect) => effect.getFlag(MODULE_ID, "moraleEffect")), "Clearing morale left a managed effect.", { status });
        await actor.deleteEmbeddedDocuments("ActiveEffect", [unrelated.id]);
        results.push(status);
      }
      return { statuses: results };
    });

    await runAutomationStep(steps, "unlinked casualty does not kill a captain sharing its base actor", async () => {
      const groupId = state.groups[0];
      const captain = state.combatants[0];
      const casualty = state.combatants[1];
      await casualty.token.update({ actorId: captain.actorId });
      await casualty.update({ actorId: captain.actorId });
      await GroupManager.editGroup(state.combat, groupId, { moraleTrigger: MORALE_TRIGGER.CAPTAIN_DEATH });
      await GroupManager.setCaptain(state.combat, groupId, captain.id);
      await MoraleManager.clearMorale(state.combat, groupId);
      await casualty.actor.update({ "system.attributes.hp.value": 0 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assertAutomationCondition(!MoraleManager.hasCaptainDeathTriggered(state.combat, groupId), "Another unlinked token's HP loss triggered captain death.");
      assertAutomationCondition(state.combat.getFlag(MODULE_ID, `groups.${groupId}.captainId`) === captain.id, "The living captain was cleared.");
      await casualty.actor.update({ "system.attributes.hp.value": 10 });
      await waitForMutations(state.combat);
      const messagesBefore = new Set(game.messages.map(message => message.id));
      const events = await Promise.allSettled([
        captain.actor.update({ "system.attributes.hp.value": 0 }),
        captain.update({ defeated: true }),
      ]);
      for (const event of events) if (event.status === "rejected") throw event.reason;
      const deadline = Date.now() + 2000;
      while (state.combat.getFlag(MODULE_ID, `groups.${groupId}.captainId`) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assertAutomationCondition(MoraleManager.hasCaptainDeathTriggered(state.combat, groupId), "The captain's own HP loss did not trigger morale.");
      assertAutomationCondition(!state.combat.getFlag(MODULE_ID, `groups.${groupId}.captainId`), "The fallen captain was not cleared.");
      await waitForMutations(state.combat);
      const groupName = state.combat.getFlag(MODULE_ID, `groups.${groupId}.name`);
      const newMessages = game.messages.filter(message => !messagesBefore.has(message.id) && message.content.includes(groupName));
      const captainResponses = newMessages.filter(message => message.content.includes(game.i18n.localize("SCI.Chat.CaptainFallenTitle"))).length;
      const moraleResponses = newMessages.filter(message => message.content.includes(game.i18n.format("SCI.Chat.MoraleCheckTitle", { name: groupName }))).length;
      assertAutomationCondition(captainResponses === 1 && moraleResponses === 1, "Simultaneous captain HP/defeat produced duplicate or missing automatic responses.", { captainResponses, moraleResponses });
      return { distinctActorUuids: captain.actor.uuid !== casualty.actor.uuid, actualCaptainDeathTriggered: true, captainResponses, moraleResponses };
    });

    await runAutomationStep(steps, "large tied squads preserve PC filtering with SCI-only grouping", async () => {
      await waitForMutations(state.combat);
      const [pc] = await Actor.createDocuments([withFixtureFlag({
        name: fixtureName(runId, "Player Character"), type: "character", img: "icons/svg/mystery-man.svg",
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, ...Object.fromEntries(game.users.filter(user => !user.isGM).map(user => [user.id, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER])) },
      }, marker)]);
      const actors = Array.from({ length: 22 }, (_, index) => index === 0 ? pc : state.actors[index % state.actors.length]);
      const tokens = await createFixtureTokens(scene, actors, marker);
      const created = await state.combat.createEmbeddedDocuments("Combatant", tokens.map((token, index) => withFixtureFlag({
        tokenId: token.id, actorId: token.actorId, sceneId: scene.id, hidden: false,
        flags: { [MODULE_ID]: { groupId: index < 20 ? state.groups[index % 2] : UNGROUPED } },
      }, marker)));
      await waitForMutations(state.combat);
      for (const id of state.groups) await GroupManager.resetGroupInitiative(state.combat, id);
      await state.combat.rollNPC({ messageMode: "gm" });
      await waitForMutations(state.combat);
      const playerMember = created.find(c => c.actorId === pc.id);
      assertAutomationCondition(playerMember?.hasPlayerOwner && playerMember.initiative === null, "Roll NPCs rolled a player-owned character.", { id: playerMember?.id, playerOwner: playerMember?.hasPlayerOwner, initiative: playerMember?.initiative });
      assertAutomationCondition(created.filter(c => c.id !== playerMember.id).every(c => Number.isFinite(c.initiative)), "Roll NPCs missed fixture NPCs.");
      const playerGroupId = playerMember.getFlag(MODULE_ID, "groupId");
      assertAutomationCondition(state.combat.getFlag(MODULE_ID, `groups.${playerGroupId}.initiative`) === null, "A partially rolled squad acquired an aggregate.");
      await state.combat.rollAll({ messageMode: "gm" });
      await waitForMutations(state.combat);
      const raw = new Map(state.combat.combatants.map(c => [c.id, c.initiative]));
      for (const id of state.groups) await GroupManager.setGroupInitiative(state.combat, id, 10);
      for (const id of state.groups) {
        const positions = state.combat.turns.flatMap((c, index) => c.getFlag(MODULE_ID, "groupId") === id ? [index] : []);
        assertAutomationCondition(positions.length === 12 && positions.at(-1) - positions[0] === 11, "A tied twelve-member squad is not contiguous.", { id, positions });
      }
      assertAutomationCondition(state.combat.combatants.every(c => c.initiative === raw.get(c.id)), "Tied ordering rewrote native rolls.");
      const nativeMembers = created.filter(c => c.getFlag(MODULE_ID, "groupId") === UNGROUPED);
      const legacyId = foundry.utils.randomID();
      // Materialize saved native data through the real document preparation path.
      // This detached clone never enters the world or dispatches document writes.
      const legacy = state.combat.clone({
        groups: [{ _id: legacyId, name: "SCI legacy preparation fixture", initiative: 99 }],
        combatants: nativeMembers.map(c => ({ ...c.toObject(), group: legacyId })),
      });
      assertAutomationCondition(legacy.groups.has(legacyId), "Saved native group data was removed.");
      assertAutomationCondition(legacy.combatants.every(c => c._source.group === legacyId && c.group === null && c.initiative === raw.get(c.id)), "Saved native membership changed or still overrides member initiative.");
      assertAutomationCondition(legacy.createGroups().size === 0 && state.combat.createGroups().size === 0, "Native automatic grouping remains enabled.");
      const denied = await state.combat.createEmbeddedDocuments("CombatantGroup", [withFixtureFlag({ name: fixtureName(runId, "Disabled Native Group") }, marker)]);
      assertAutomationCondition(denied.length === 0, "Creating a new native group was not prevented.");
      await ui.combat.render({ force: true });
      assertAutomationCondition(!ui.combat.element.querySelector(".combatant-group[data-group-key]"), "A native group header remains visible.");
      if (context.collectClientDiagnostics) state.clientAcceptance = await context.collectClientDiagnostics({ includeDom: true, expectedNonGMClients: 1, expectedGMClients: 2 });
      return { squadSizes: [12, 12], playerFiltering: true, groupingPolicy: "sci-only-preserve-native-data", savedNativeDataPreserved: true, clientStatus: state.clientAcceptance?.status ?? "not-run" };
    });

    await runAutomationStep(steps, "validate fixture combat data", async () => {
      if (typeof validateData !== "function") {
        throw new Error("Fixture validation requires a validateData callback.");
      }
      const validation = await validateData({ combatId: state.combat.id });
      if (validation.errors.length) {
        assertAutomationCondition(false, `Fixture validation failed with ${validation.errors.length} error(s).`, validation.errors);
      }
      return validation.checked;
    });
  } catch (err) {
    failure = serializeError(err);
  } finally {
    if (chatHook) Hooks.off("preCreateChatMessage", chatHook);

    const restoreErrors = [];
    try {
      await restoreSettings(previousSettings);
    } catch (err) {
      restoreErrors.push({ stage: "settings", ...serializeError(err) });
    }
    try {
      await restorePreviousCombat(previousCombatId, state.combat);
    } catch (err) {
      restoreErrors.push({ stage: "combat", ...serializeError(err) });
    }
    if (restoreErrors.length) restoreError = restoreErrors;

    if (cleanupAfter) {
      try {
        cleanupAfterResult = await cleanupFixturesInternal({ scene, runId });
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
    gameplayAcceptancePassed: success && state.clientAcceptance?.status === "passed",
    clientAcceptance: state.clientAcceptance,
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

export async function cleanupFixtures(args = {}) {
  assertActiveSceneReady();

  const scene = canvas?.scene ?? null;
  const runId = normalizeRunId(args.runId);
  return cleanupFixturesInternal({ scene, runId });
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

function getSettingValue(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (err) {
    return { error: err.message };
  }
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
    x: 100 + ((index % 6) * 110),
    y: 100 + (Math.floor(index / 6) * 110),
    width: 1,
    height: 1,
    disposition: CONST.TOKEN_DISPOSITIONS.HOSTILE,
    texture: { src: actor.img },
  }, marker));

  return scene.createEmbeddedDocuments("Token", tokenData);
}

async function createFixtureCombat(scene, tokens, marker) {
  const combat = await game.combats.documentClass.create(withFixtureFlag({
    name: fixtureName(marker.runId, "Combat"),
    scene: scene.id,
    active: false,
  }, marker));

  await combat.createEmbeddedDocuments("Combatant", tokens.map((token, index) => withFixtureFlag({
    tokenId: token.id,
    actorId: token.actorId,
    sceneId: scene.id,
    hidden: false,
    sort: (index + 1) * 100,
    flags: {
      [MODULE_ID]: {
        groupId: UNGROUPED,
      },
    },
  }, marker)));

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
      updateData[`flags.${MODULE_ID}.groups.${groupId}`] = new foundry.data.operators.ForcedDeletion();
      deleted.groupFlags += 1;

      for (const combatant of combat.combatants.filter((candidate) => candidate.getFlag(MODULE_ID, "groupId") === groupId)) {
        if (isFixtureDocument(combatant, runId, sceneId)) {
          combatantUpdates.push({ _id: combatant.id, [`flags.${MODULE_ID}.groupId`]: new foundry.data.operators.ForcedDeletion() });
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

export function getWorldDocumentCounts(scene = canvas?.scene ?? null) {
  return {
    actors: game.actors?.size ?? 0,
    scenes: game.scenes?.size ?? 0,
    combats: game.combats?.size ?? 0,
    activeSceneTokens: scene?.tokens?.size ?? 0,
    chatMessages: game.messages?.size ?? 0,
  };
}

export function getFixtureCounts(scene = canvas?.scene ?? null, runId = null) {
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
  return hasFixturePrefix(document);
}

function isFixtureGroup(group, runId = null, sceneId = null) {
  const marker = group?.[FIXTURE_FLAG] ?? null;
  if (!isFixtureMarker(marker, runId, sceneId)) return false;
  return String(group?.name ?? "").startsWith(FIXTURE_PREFIX);
}

function isFixtureMarker(marker, runId = null, sceneId = null) {
  if (!marker || typeof marker !== "object") return false;
  if (runId && marker.runId !== runId) return false;
  if (sceneId && marker.sceneId !== sceneId) return false;
  return marker.worldId === (game.world?.id ?? null)
    && String(marker.fixtureName ?? "").startsWith(FIXTURE_PREFIX);
}

function hasFixturePrefix(document) {
  const name = String(document?.name ?? "");
  const content = String(document?.content ?? "");
  const flavor = String(document?.flavor ?? "");
  const alias = String(document?.speaker?.alias ?? "");

  return name.startsWith(FIXTURE_PREFIX)
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
