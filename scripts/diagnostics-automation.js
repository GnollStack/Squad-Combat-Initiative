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
import { onEncounterPlaced } from "./encounter-squads.js";

export const FIXTURE_PREFIX = "SCI-MCP-FIXTURE";
export const FIXTURE_FLAG = "diagnosticsFixture";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

const MUTATION_SETTING_KEYS = Object.freeze([
  "autoCollapseGroups",
  "defaultGroupPinned",
  "defaultInitiativeMode",
  "encounterSquads",
  "carouselSquadCards",
  "carouselMembersShown",
  "carouselPreviewCount",
  "carouselExpandDirection",
  "carouselMemberOrder",
  "carouselFadeEdges",
  "carouselShowHealth",
  "carouselShowNext",
  "carouselDimDefeated",
  "carouselCollapse",
  "carouselDefeated",
  "groupTokenHighlight",
  "visibilitySyncMode",
  "moraleEnabled",
  "moraleStatusEffect",
  "moraleMobConfidenceDivisor",
  "moraleEffectDuration",
]);

const DND5E_RECORDED_SETTING_KEYS = Object.freeze([
  "initiativeGroupRoll",
  "initiativeGroupCombatants",
  "initiativeScore",
  "initiativeDexTiebreaker",
  "autoApplyDowned",
  "encounterPlacementBehavior",
  "bloodied",
]);

const DND5E_DERIVATION_SETTING_KEYS = Object.freeze(["initiativeGroupRoll", "initiativeScore"]);

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
  const previousDnd5eSettings = captureSettings(DND5E_RECORDED_SETTING_KEYS, "dnd5e");
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
      // Shared mode deliberately rewrites members and has its own step.
      const modes = Object.values(INITIATIVE_MODE).filter((mode) => mode !== INITIATIVE_MODE.SHARED);
      for (const mode of modes) {
        await GroupManager.editGroup(state.combat, groupId, { initiativeMode: mode });
        const actual = state.combat.getFlag(MODULE_ID, `groups.${groupId}.initiative`);
        const expected = calculateGroupInitiative(raw, mode, raw[0]);
        assertAutomationCondition(actual === expected, "Aggregate mode did not use the original rolls.", { mode, actual, expected });
        assertAutomationCondition(members.every((member, index) => member.initiative === raw[index]), "Aggregate mode rewrote a member roll.", { mode });
      }
      return { modes, raw };
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

    await runAutomationStep(steps, "native group roll derivation under SCI", async () => {
      const [alpha, bravo, charlie, delta] = state.actors;
      const previous = captureSettings(DND5E_DERIVATION_SETTING_KEYS, "dnd5e");
      const tokens = await createFixtureTokens(scene, [alpha, alpha, alpha, bravo, bravo, bravo, alpha, charlie, delta], marker);
      // A separate combat keeps the later steps' squad and turn counts unchanged.
      const combat = await createFixtureCombat(scene, tokens, marker);
      try {
        await combat.activate();
        const membersOf = (actor) => tokens
          .filter((token) => token.actorId === actor.id)
          .map((token) => combat.combatants.find((combatant) => combatant.tokenId === token.id));
        const alphas = membersOf(alpha);
        const bravos = membersOf(bravo);
        const others = [...membersOf(charlie), ...membersOf(delta)];
        const members = [...alphas, ...bravos, ...others];
        const memberDetails = () => members.map((member) => ({
          id: member.id,
          actorId: member.actorId,
          groupId: member.getFlag(MODULE_ID, "groupId"),
          initiative: member.initiative,
        }));
        const squadIds = [];
        for (const [label, squad] of [["Same A", alphas.slice(0, 3)], ["Same B", bravos], ["Mixed", [alphas[3], ...others]]]) {
          const groupId = await GroupManager.createGroup(combat, {
            name: fixtureName(runId, `Derivation ${label}`),
            img: "icons/svg/combat.svg",
            color: "#33aaff",
            pinned: false,
            hidden: false,
            initiativeMode: INITIATIVE_MODE.AVERAGE,
          }, []);
          await markFixtureGroup(combat, groupId, marker);
          await GroupManager.addCombatantsToGroup(combat, groupId, squad.map((member) => member.id));
          squadIds.push(groupId);
        }
        const [sameA, sameB, mixed] = squadIds;
        const rollsOf = (groupId) => combat.combatants
          .filter((combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId)
          .map((combatant) => combatant.initiative);
        const resetSquads = async () => {
          for (const groupId of squadIds) await GroupManager.resetGroupInitiative(combat, groupId);
        };
        const assertAggregates = (scenario) => {
          for (const groupId of squadIds) {
            const rolls = rollsOf(groupId);
            const actual = combat.getFlag(MODULE_ID, `groups.${groupId}.initiative`);
            const expected = calculateGroupInitiative(rolls, INITIATIVE_MODE.AVERAGE);
            assertAutomationCondition(rolls.every(Number.isFinite), "A derivation squad member was left unrolled.", { scenario, rolls });
            assertAutomationCondition(actual === expected, "The squad aggregate does not match its member rolls.", { scenario, actual, expected, rolls });
          }
          assertAutomationCondition(
            members.every((member) => member.getFlag(MODULE_ID, "rawInitiative") === member.initiative),
            "Raw initiative flags do not mirror member initiative after rolling.",
            { scenario }
          );
        };
        // Three identical d20 results in both squads is a 1 in 160000 false failure.
        const assertRolledPerMember = (scenario) => {
          const same = [rollsOf(sameA), rollsOf(sameB)];
          assertAutomationCondition(same.some((rolls) => new Set(rolls).size > 1), "Same-actor squads shared one roll where each member should roll.", { scenario, same });
        };
        const rollNative = async () => {
          await resetSquads();
          await combat.rollNPC({ messageMode: "gm" });
          await waitForMutations(combat);
        };
        const rollSquads = async () => {
          await resetSquads();
          for (const groupId of squadIds) await GroupManager.rollGroupAndApplyInitiative(combat, groupId);
          await waitForMutations(combat);
        };
        const snapshot = () => ({ sameA: rollsOf(sameA), sameB: rollsOf(sameB), mixed: rollsOf(mixed) });

        await game.settings.set("dnd5e", "initiativeScore", "none");
        await game.settings.set("dnd5e", "initiativeGroupRoll", true);

        await rollNative();
        const derivedA = rollsOf(sameA);
        const derivedB = rollsOf(sameB);
        assertAutomationCondition(new Set(derivedA).size === 1 && new Set(derivedB).size === 1, "Roll Once per Creature did not derive one roll per base actor.", { derivedA, derivedB, members: memberDetails() });
        assertAutomationCondition(alphas[3].initiative === derivedA[0], "A mixed-squad member did not derive from its base actor's roll in another squad.", { derived: derivedA[0], members: memberDetails() });
        assertAggregates("native roll, group roll on");
        const nativeOn = snapshot();

        await resetSquads();
        await combat.rollInitiative([alphas[0].id], { messageMode: "gm" });
        await waitForMutations(combat);
        await combat.rollInitiative([alphas[1].id], { messageMode: "gm" });
        await waitForMutations(combat);
        assertAutomationCondition(alphas[0].initiative === alphas[1].initiative, "A lone native roll did not derive from an already rolled match before combat start.", { first: alphas[0].initiative, second: alphas[1].initiative });
        assertAutomationCondition(combat.getFlag(MODULE_ID, `groups.${sameA}.initiative`) === null, "A partially rolled squad acquired an aggregate from lone rolls.");
        const loneOn = [alphas[0].initiative, alphas[1].initiative];

        await rollSquads();
        assertRolledPerMember("squad roll, group roll on");
        assertAggregates("squad roll, group roll on");
        const squadOn = snapshot();

        await game.settings.set("dnd5e", "initiativeGroupRoll", false);

        await rollNative();
        assertRolledPerMember("native roll, group roll off");
        assertAggregates("native roll, group roll off");
        const nativeOff = snapshot();

        await rollSquads();
        assertRolledPerMember("squad roll, group roll off");
        assertAggregates("squad roll, group roll off");
        const squadOff = snapshot();

        return { nativeOn, loneOn, squadOn, nativeOff, squadOff };
      } finally {
        for (const [key, value] of Object.entries(previous)) await game.settings.set("dnd5e", key, value);
        await combat.delete();
        await scene.deleteEmbeddedDocuments("Token", tokens.map((token) => token.id));
        await state.combat.activate();
      }
    });

    await runAutomationStep(steps, "shared squad carries one initiative value", async () => {
      const tokens = await createFixtureTokens(scene, state.actors, marker);
      const combat = await createFixtureCombat(scene, tokens, marker);
      try {
        await combat.activate();
        const [first, captain, third, joiner] = tokens.map((token) => combat.combatants.find((combatant) => combatant.tokenId === token.id));
        const groupId = await GroupManager.createGroup(combat, {
          name: fixtureName(runId, "Shared"),
          img: "icons/svg/combat.svg",
          color: "#33aaff",
          pinned: false,
          hidden: false,
          initiativeMode: INITIATIVE_MODE.SHARED,
        }, []);
        await markFixtureGroup(combat, groupId, marker);
        await GroupManager.addCombatantsToGroup(combat, groupId, [first.id, captain.id, third.id]);
        await GroupManager.setCaptain(combat, groupId, captain.id);
        const squad = () => combat.combatants.filter((combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId);
        const squadValue = () => combat.getFlag(MODULE_ID, `groups.${groupId}.initiative`);
        const assertOneValue = async (scenario, expected = null) => {
          await waitForMutations(combat);
          await waitForCondition(() => {
            const values = new Set(squad().map((member) => member.initiative));
            return values.size === 1 && values.values().next().value === squadValue() && (expected === null || squadValue() === expected);
          });
          const rolls = squad().map((member) => member.initiative);
          assertAutomationCondition(Number.isFinite(squadValue()) && rolls.every((roll) => roll === squadValue()), "A shared squad does not carry one value.", { scenario, rolls, value: squadValue() });
          assertAutomationCondition(expected === null || squadValue() === expected, "A shared squad took the wrong value.", { scenario, expected, value: squadValue() });
          assertAutomationCondition(squad().every((member) => member.getFlag(MODULE_ID, "rawInitiative") === member.initiative), "Raw flags do not mirror the shared value.", { scenario });
          return squadValue();
        };

        const initiativeMessages = () => game.messages.filter((message) => message.getFlag("core", "initiativeRoll") && message.flavor?.includes(fixtureName(runId, "Shared"))).length;
        await GroupManager.rollGroupAndApplyInitiative(combat, groupId, { mode: "advantage" });
        const rolled = await assertOneValue("squad roll");
        assertAutomationCondition(initiativeMessages() === 1, "A shared squad roll did not produce exactly one roll message.", { messages: initiativeMessages() });

        await GroupManager.addCombatantsToGroup(combat, groupId, [joiner.id]);
        await assertOneValue("joiner before start", rolled);
        await GroupManager.removeCombatantFromGroup(combat, joiner.id);
        await waitForMutations(combat);

        await GroupManager.resetGroupInitiative(combat, groupId);
        await combat.rollNPC({ messageMode: "gm" });
        const bulk = await assertOneValue("native bulk roll");
        assertAutomationCondition(captain.getFlag(MODULE_ID, "nativeInitiative") === undefined, "The representative saved a native roll over its own.");
        const saved = [first, third].map((member) => member.getFlag(MODULE_ID, "nativeInitiative") ?? bulk);

        await GroupManager.editGroup(combat, groupId, { initiativeMode: INITIATIVE_MODE.HIGHEST });
        await waitForMutations(combat);
        const restored = [first.initiative, third.initiative];
        assertAutomationCondition(restored.every((roll, index) => roll === saved[index]), "Leaving shared mode did not restore native rolls.", { restored, saved });
        assertAutomationCondition(squad().every((member) => member.getFlag(MODULE_ID, "nativeInitiative") === undefined), "Leaving shared mode left saved native rolls.");
        await GroupManager.editGroup(combat, groupId, { initiativeMode: INITIATIVE_MODE.SHARED });
        await assertOneValue("returning to shared uses the representative", bulk);

        await first.update({ initiative: bulk + 3 });
        const edited = await assertOneValue("edit moves the squad", bulk + 3);

        await GroupManager.resetGroupInitiative(combat, groupId);
        await combat.rollInitiative([third.id], { messageMode: "gm" });
        const lone = await assertOneValue("lone roll");

        await combat.startCombat();
        await GroupManager.addCombatantsToGroup(combat, groupId, [joiner.id]);
        await assertOneValue("joiner after start", lone);
        const validation = await validateData({ combatId: combat.id });
        assertAutomationCondition(!validation.errors.length, "Shared squad data failed validation.", validation.errors);
        return { rolled, bulk, saved, restored, edited, lone };
      } finally {
        await combat.delete();
        await scene.deleteEmbeddedDocuments("Token", tokens.map((token) => token.id));
        await state.combat.activate();
      }
    });

    await runAutomationStep(steps, "placed encounter becomes a squad", async () => {
      const tokens = await createFixtureTokens(scene, state.actors, marker);
      const combat = await createFixtureCombat(scene, tokens, marker);
      try {
        await combat.activate();
        const important = combat.combatants.find((combatant) => combatant.tokenId === tokens[2].id);
        await important.actor.update({ "system.traits.important": true });
        const encounter = { name: fixtureName(runId, "Encounter"), img: "icons/svg/skull.svg" };

        assertAutomationCondition(await onEncounterPlaced(encounter, tokens, { combatBehavior: "none" }) === null, "A placement outside combat created a squad.");
        await game.settings.set(MODULE_ID, "encounterSquads", false);
        assertAutomationCondition(await onEncounterPlaced(encounter, tokens, { combatBehavior: "createCombatants" }) === null, "The disabled setting still created a squad.");
        await game.settings.set(MODULE_ID, "encounterSquads", true);

        await combat.rollNPC({ messageMode: "gm" });
        const groupId = await onEncounterPlaced(encounter, tokens, { combatBehavior: "rollInitiative" });
        await markFixtureGroup(combat, groupId, marker);
        await waitForMutations(combat);
        const group = combat.getFlag(MODULE_ID, `groups.${groupId}`);
        const rolls = combat.combatants.filter((combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId).map((combatant) => combatant.initiative);
        assertAutomationCondition(rolls.length === tokens.length, "The placed members did not all join the squad.", { rolls });
        assertAutomationCondition(group.name === encounter.name && group.img === encounter.img, "The squad did not take the Encounter's name and image.", { group });
        assertAutomationCondition(group.captainId === important.id, "The Important NPC is not the captain.", { captainId: group.captainId, important: important.id });
        const expected = calculateGroupInitiative(rolls, group.initiativeMode);
        assertAutomationCondition(group.initiative === expected, "An already rolled placement did not produce an aggregate.", { rolls, initiative: group.initiative, expected });
        return { groupId, captainId: group.captainId, rolls, initiative: group.initiative };
      } finally {
        await combat.delete();
        await scene.deleteEmbeddedDocuments("Token", tokens.map((token) => token.id));
        await state.combat.activate();
      }
    });

    await runAutomationStep(steps, "encounter with no linked scene builds squads and syncs tokens", async () => {
      const combat = await game.combats.documentClass.create(withFixtureFlag({ name: fixtureName(runId, "Unlinked Combat"), active: false }, marker));
      const tokens = await createFixtureTokens(scene, state.actors, marker);
      try {
        await combat.activate();
        assertAutomationCondition(!combat.scene, "The fixture encounter is linked to a scene.");

        const groupId = await GroupManager.createGroup(combat, {
          name: fixtureName(runId, "Unlinked Selected"),
          img: "icons/svg/combat.svg",
          color: "#33aaff",
          pinned: false,
          hidden: false,
        }, tokens.slice(0, 2));
        await markFixtureGroup(combat, groupId, marker);
        await waitForMutations(combat);
        const selected = combat.combatants.filter((combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId);
        assertAutomationCondition(selected.length === 2 && selected.every((member) => member.sceneId === scene.id), "Selected tokens did not join an unlinked encounter's squad.", { count: selected.length });

        const hidden = await GroupManager.toggleGroupVisibility(combat, groupId);
        assertAutomationCondition(hidden === true && tokens.slice(0, 2).every((token) => token.hidden), "Hiding a squad did not hide its tokens in an unlinked encounter.");
        await GroupManager.toggleGroupVisibility(combat, groupId);
        assertAutomationCondition(tokens.slice(0, 2).every((token) => !token.hidden), "Showing a squad did not show its tokens in an unlinked encounter.");

        // The same call dnd5e's placement makes, which leaves members in the unlinked viewed encounter.
        const placed = tokens.slice(2);
        await TokenDocument.implementation.createCombatants(placed, { combat });
        await waitForMutations(combat);
        const encounterGroupId = await onEncounterPlaced({ name: fixtureName(runId, "Unlinked Encounter"), img: "icons/svg/skull.svg" }, placed, { combatBehavior: "createCombatants" });
        await markFixtureGroup(combat, encounterGroupId, marker);
        await waitForMutations(combat);
        const members = combat.combatants.filter((combatant) => combatant.getFlag(MODULE_ID, "groupId") === encounterGroupId);
        assertAutomationCondition(members.length === placed.length, "A placed encounter's squad came out empty in an unlinked encounter.", { count: members.length });
        return { selected: selected.length, encounterMembers: members.length };
      } finally {
        await combat.delete();
        await scene.deleteEmbeddedDocuments("Token", tokens.map((token) => token.id));
        await state.combat.activate();
      }
    });

    await runAutomationStep(steps, "carousel squad cards collapse and expand", async () => {
      if (game.modules.get(MODULE_ID)?.__carouselSquadsRegistered !== true) return { skipped: true, reason: "Carousel Combat Tracker is not active" };
      const [alpha, bravo, charlie] = state.actors;
      const tokens = await createFixtureTokens(scene, [alpha, alpha, alpha, alpha, alpha, bravo, bravo, charlie], marker);
      const combat = await createFixtureCombat(scene, tokens, marker);
      try {
        await game.settings.set(MODULE_ID, "carouselExpandDirection", "along");
        await game.settings.set(MODULE_ID, "carouselMemberOrder", "turn");
        await game.settings.set(MODULE_ID, "carouselFadeEdges", true);
        await game.settings.set(MODULE_ID, "carouselShowHealth", true);
        await game.settings.set(MODULE_ID, "carouselShowNext", true);
        await game.settings.set(MODULE_ID, "carouselDimDefeated", true);
        await game.settings.set(MODULE_ID, "carouselCollapse", "all");
        await game.settings.set(MODULE_ID, "carouselMembersShown", 3);
        await game.settings.set(MODULE_ID, "carouselPreviewCount", 2);
        await game.settings.set(MODULE_ID, "carouselDefeated", "dim");
        await combat.activate();
        await waitForCondition(() => ui.combatDock?.combat === combat && ui.combatDock.element?.querySelector("#combatants .combatant-portrait"), 5000);
        const dock = ui.combatDock;
        assertAutomationCondition(dock?.combat === combat, "The carousel did not open for the fixture encounter.");
        const list = dock.element.querySelector("#combatants");

        const members = tokens.map((token) => combat.combatants.find((combatant) => combatant.tokenId === token.id));
        const portrait = (member) => list.querySelector(`.combatant-portrait[data-combatant-id="${member.id}"]`);
        const shown = (group) => group.filter((member) => getComputedStyle(portrait(member)).display !== "none").map((member) => member.id);
        const createSquad = async (label, squad) => {
          const groupId = await GroupManager.createGroup(combat, { name: fixtureName(runId, label), img: "icons/svg/combat.svg", color: "#33aaff", pinned: false, hidden: false }, []);
          await markFixtureGroup(combat, groupId, marker);
          await GroupManager.addCombatantsToGroup(combat, groupId, squad.map((member) => member.id));
          return groupId;
        };
        const large = members.slice(0, 5), small = members.slice(5, 7), loner = members[7];
        const largeId = await createSquad("Carousel Large", large);
        const smallId = await createSquad("Carousel Small", small);
        const settle = () => settleFixture(combat);
        // Carousel animates removed elements with temporary .flip-ghost clones.
        const cards = () => [...list.querySelectorAll(".sci-carousel-squad:not(.flip-ghost)")].map((card) => card.dataset.groupKey);

        await game.settings.set(MODULE_ID, "carouselSquadCards", false);
        await settle();
        assertAutomationCondition(!cards().length && shown(large).length === 5, "Squad cards appeared while the setting was off.", { cards: cards(), shown: shown(large) });

        await game.settings.set(MODULE_ID, "carouselSquadCards", true);
        await settle();
        assertAutomationCondition(cards().length === 2, "Each squad did not get one card.", { cards: cards() });
        assertAutomationCondition(!shown(large).length && !shown(small).length && shown([loner]).length === 1, "Squads were not collapsed before combat started, or an ungrouped portrait was hidden.", { large: shown(large), small: shown(small) });
        const preview = list.querySelector(`.sci-carousel-squad[data-group-key="${largeId}"]:not(.flip-ghost) .sci-carousel-squad-previews`);
        assertAutomationCondition(preview?.querySelectorAll("img").length === 2, "The collapsed card did not honor the preview count.");

        await combat.rollNPC({ messageMode: "gm" });
        await waitForMutations(combat);
        // Put the large squad first so the turn walk starts inside it.
        await GroupManager.setGroupInitiative(combat, largeId, 30);
        await GroupManager.setGroupInitiative(combat, smallId, 20);
        await loner.update({ initiative: 1 });
        await combat.startCombat();
        await settle();
        assertAutomationCondition(large.some((member) => member.id === combat.combatant.id), "The fixture encounter did not start in the large squad.", { current: combat.combatant?.id });
        const firstWindow = shown(large);
        assertAutomationCondition(firstWindow.length === 3 && firstWindow.includes(combat.combatant.id), "The active squad did not expand to its limit around the current member.", { firstWindow });
        assertAutomationCondition(!shown(small).length, "A squad that is not active stayed expanded.");
        const activeCard = list.querySelector(`.sci-carousel-squad[data-group-key="${largeId}"]:not(.flip-ghost)`);
        assertAutomationCondition(activeCard.classList.contains("sci-active") && getComputedStyle(activeCard).display !== "none", "The active squad's card did not stay beside its members.");
        const smallCard = list.querySelector(`.sci-carousel-squad[data-group-key="${smallId}"]:not(.flip-ghost)`);
        assertAutomationCondition(smallCard.classList.contains("sci-next") && !activeCard.classList.contains("sci-next"), "The squad after the active one is not marked as up next.", { small: smallCard.className, active: activeCard.className });
        const nudges = list.querySelectorAll(`.sci-carousel-nudge[data-group-key="${largeId}"]:not(.flip-ghost)`);
        assertAutomationCondition(nudges.length === 2, "An overflowing squad has no scroll controls.", { nudges: nudges.length });

        const fadedAtEdge = () => [...list.querySelectorAll(".combatant-portrait.sci-fade-start:not(.flip-ghost), .combatant-portrait.sci-fade-end:not(.flip-ghost)")];
        // The squad starts on its first member, so only the far side has hidden members.
        const edges = fadedAtEdge();
        assertAutomationCondition(edges.length === 1 && edges[0].classList.contains("sci-fade-end"), "The hidden side of the list did not fade.", { edges: edges.map((element) => element.className), shown: shown(large), current: combat.combatant.id });
        assertAutomationCondition(!portrait(combat.combatant).className.includes("sci-fade"), "The current member faded.");
        assertAutomationCondition(!edges[0].matches(":hover") && (getComputedStyle(edges[0]).maskImage ?? "none") !== "none", "The edge member has no fade mask.", { mask: getComputedStyle(edges[0]).maskImage });
        await game.settings.set(MODULE_ID, "carouselFadeEdges", false);
        await settle();
        assertAutomationCondition(!fadedAtEdge().length, "Edges faded with the setting off.");
        await game.settings.set(MODULE_ID, "carouselFadeEdges", true);
        await settle();

        const ordered = [...list.children].filter((element) => getComputedStyle(element).display !== "none" && !element.classList.contains("separator") && !element.classList.contains("flip-ghost"))
          .sort((a, b) => parseInt(a.style.order) - parseInt(b.style.order));
        const cardIndex = ordered.indexOf(activeCard);
        const after = ordered.slice(cardIndex + 1, cardIndex + 6);
        assertAutomationCondition(after[0]?.classList.contains("sci-carousel-nudge") && after[4]?.classList.contains("sci-carousel-nudge"), "The expanded members do not sit between the scroll controls after the card.", { after: after.map((element) => element.className) });

        portrait(combat.combatants.get(firstWindow[0])).dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
        await settle();
        const scrolled = shown(large);
        assertAutomationCondition(scrolled.length === 3 && scrolled.join() !== firstWindow.join(), "The scroll wheel did not move through the squad.", { firstWindow, scrolled });
        const before = scrolled.join();
        const combatTurn = combat.turn;
        assertAutomationCondition(combat.turn === combatTurn && before === shown(large).join(), "Scrolling changed the combat.");

        await game.settings.set(MODULE_ID, "carouselExpandDirection", "cycle");
        await settle();
        const cycleCard = list.querySelector(`.sci-carousel-squad[data-group-key="${largeId}"]:not(.flip-ghost)`);
        const cycleStart = shown(large);
        assertAutomationCondition(cycleStart.length === 1, "One at a time did not show exactly one member.", { shown: cycleStart });
        assertAutomationCondition(!list.querySelector(`.sci-carousel-nudge[data-group-key="${largeId}"]:not(.flip-ghost)`), "One at a time kept the bar's scroll controls.");
        assertAutomationCondition(!fadedAtEdge().length, "One at a time faded its only member.");
        const cyclePosition = () => cycleCard.querySelector(".sci-carousel-cycle-position")?.textContent;
        const positionBefore = cyclePosition();
        assertAutomationCondition(/^\d+\/5$/.test(positionBefore ?? ""), "The card does not show where the squad is in its cycle.", { position: positionBefore });
        portrait(combat.combatants.get(cycleStart[0])).dispatchEvent(new WheelEvent("wheel", { deltaY: positionBefore === "5/5" ? -100 : 100, bubbles: true, cancelable: true }));
        await settle();
        const cycleWheel = shown(large);
        assertAutomationCondition(cycleWheel.length === 1 && cycleWheel[0] !== cycleStart[0] && cyclePosition() !== positionBefore, "The wheel did not cycle the squad.", { cycleStart, cycleWheel, position: cyclePosition() });
        const cycleControl = cycleCard.querySelector(`[data-sci-carousel-step="${cyclePosition() === "5/5" ? -1 : 1}"]`);
        cycleControl.click();
        await settle();
        assertAutomationCondition(shown(large)[0] !== cycleWheel[0], "The card's arrow did not cycle the squad.", { before: cycleWheel, after: shown(large) });
        await game.settings.set(MODULE_ID, "carouselExpandDirection", "along");
        await settle();

        let stackDetails = { skipped: "the carousel is vertical in this world" };
        if (!dock.isVertical) {
          await game.settings.set(MODULE_ID, "carouselExpandDirection", "away");
          await settle();
          // Carousel's animations stall in a background tab. Its intro clears an inline transform when it
          // finishes, so end them and let that run before measuring final positions.
          const introRunning = list.querySelector(".sci-carousel-squad:not(.flip-ghost)")?.style.transform;
          finishAnimations(list);
          await settle();
          const barRect = list.getBoundingClientRect();
          const cardRect = activeCard.getBoundingClientRect();
          const stackIds = shown(large);
          const stack = stackIds.map((id) => portrait(combat.combatants.get(id)));
          // Sorted by screen position, because members are listed in document order here.
          const rects = stack.map((element) => element.getBoundingClientRect()).sort((a, b) => a.top - b.top);
          const below = rects[0].top >= cardRect.bottom - 1;
          const layoutDetails = {
            visibility: document.visibilityState,
            introRunning,
            window: [window.innerWidth, window.innerHeight],
            bar: barRect,
            scroll: [list.scrollLeft, list.scrollTop, list.scrollWidth, list.scrollHeight, list.clientWidth, list.clientHeight],
            overflow: getComputedStyle(list).overflow,
            card: cardRect,
            rects,
            positions: stack.map((element) => { const style = getComputedStyle(element); return [style.position, style.left, style.top, element.style.left, element.style.top, element.className]; }),
            host: (() => { const host = dock.element.closest("#combat-dock") ?? dock.element; const style = getComputedStyle(host); return { id: host.id, contain: style.contain, transform: style.transform, rect: host.getBoundingClientRect() }; })(),
            stylesheet: [...document.styleSheets].some((sheet) => sheet.href?.includes("carousel.css")),
          };
          const above = rects.at(-1).bottom <= cardRect.top + 1;
          // The wheel just moved this view, so it need not hold the current member until the next turn.
          assertAutomationCondition(stack.length >= 1, "The active squad opened no stack.", { stackIds });
          assertAutomationCondition(below || above, "The stack overlaps its card instead of opening away from it.", layoutDetails);
          assertAutomationCondition(rects.every((rect) => Math.abs(rect.left + rect.width / 2 - (cardRect.left + cardRect.width / 2)) < 2), "The stack is not centered on its card.", layoutDetails);
          assertAutomationCondition(rects.every((rect, index) => !index || rect.top >= rects[index - 1].bottom), "The stacked members overlap.", layoutDetails);
          assertAutomationCondition(rects.every((rect) => rect.bottom > barRect.bottom || rect.top < barRect.top), "A stacked member stayed inside the bar.", layoutDetails);
          assertAutomationCondition(stack.every((element) => getComputedStyle(element).position === "fixed"), "A stacked member is not positioned out of the bar.", layoutDetails);
          assertAutomationCondition(cardRect.top >= barRect.top - 1 && cardRect.bottom <= barRect.bottom + 1, "The expanding squad's card slid out of the bar.", layoutDetails);
          const lastRect = rects.at(-1);
          const atPoint = document.elementFromPoint(lastRect.left + lastRect.width / 2, lastRect.top + lastRect.height / 2);
          assertAutomationCondition(stack.includes(atPoint?.closest(".combatant-portrait")), "A stacked member is clipped or covered.", { ...layoutDetails, atPoint: atPoint?.className ?? null });
          const stackNudges = [...list.querySelectorAll(`.sci-carousel-nudge[data-group-key="${largeId}"]:not(.flip-ghost)`)];
          assertAutomationCondition(stack.length === 3 ? stackNudges.length === 2 && stackNudges.every((nudge) => nudge.classList.contains("sci-carousel-nudge-vertical")) : true, "The stack's scroll controls are not vertical.");
          if (stack.length < 5) {
            stack[0].dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
            await settle();
            assertAutomationCondition(shown(large).join() !== stackIds.join(), "The scroll wheel did not move through the stack.", { stackIds, after: shown(large) });
          }
          stackDetails = { direction: below ? "down" : "up", members: stack.length, introRunning: introRunning || null };

          // Current member first: the current member leads and whoever just acted moves to the far end.
          await game.settings.set(MODULE_ID, "carouselMemberOrder", "current");
          await game.settings.set(MODULE_ID, "carouselMembersShown", 5);
          await settle();
          const displayOrder = () => {
            finishAnimations(list);
            const rectOf = (id) => portrait(combat.combatants.get(id)).getBoundingClientRect();
            const ids = shown(large).sort((a, b) => rectOf(a).top - rectOf(b).top);
            return below ? ids : ids.reverse();
          };
          const actedBefore = combat.combatant.id;
          const firstOrder = displayOrder();
          assertAutomationCondition(firstOrder[0] === actedBefore, "The current member does not lead the stack.", { firstOrder, current: actedBefore });
          await combat.nextTurn();
          await settle();
          const secondOrder = displayOrder();
          assertAutomationCondition(secondOrder[0] === combat.combatant.id && secondOrder[0] !== actedBefore, "The next member did not move to the front.", { secondOrder, current: combat.combatant.id });
          if (secondOrder.length === large.length) assertAutomationCondition(secondOrder.at(-1) === actedBefore, "The member who acted did not move to the far end.", { secondOrder, actedBefore });
          stackDetails.currentFirst = { firstOrder: firstOrder.length, moved: secondOrder.at(-1) === actedBefore };
          await game.settings.set(MODULE_ID, "carouselMemberOrder", "turn");
          await game.settings.set(MODULE_ID, "carouselMembersShown", 3);
          await game.settings.set(MODULE_ID, "carouselExpandDirection", "along");
          await settle();
          assertAutomationCondition(shown(large).every((id) => getComputedStyle(portrait(combat.combatants.get(id))).position !== "fixed"), "Members stayed stacked after returning to the bar.");
        }

        let turnsWalked = 0;
        while (combat.combatant?.getFlag(MODULE_ID, "groupId") === largeId && turnsWalked < 8) {
          await combat.nextTurn();
          await settle();
          assertAutomationCondition(combat.combatant.getFlag(MODULE_ID, "groupId") !== largeId || shown(large).includes(combat.combatant.id), "The expanded list did not follow the current member.", { current: combat.combatant.id, shown: shown(large) });
          turnsWalked += 1;
        }
        assertAutomationCondition(!shown(large).length && shown(small).length === 2, "Squads did not swap when the turn moved on.", { large: shown(large), small: shown(small) });
        assertAutomationCondition(!list.querySelector(`.sci-carousel-nudge[data-group-key="${largeId}"]:not(.flip-ghost)`), "A collapsed squad kept its scroll controls.");

        // Clicks are personal and last until the turn moves to another squad; pins are shared and stay.
        const cardOf = (groupId) => list.querySelector(`.sci-carousel-squad[data-group-key="${groupId}"]:not(.flip-ghost)`);
        cardOf(largeId).click();
        await settle();
        assertAutomationCondition(shown(large).length === 3, "Clicking a collapsed card did not open it.", { shown: shown(large) });
        cardOf(largeId).click();
        await settle();
        assertAutomationCondition(!shown(large).length, "Clicking an open card did not collapse it.");
        cardOf(smallId).click();
        await settle();
        assertAutomationCondition(!shown(small).length, "Clicking the active squad's card did not collapse it.");
        cardOf(smallId).click();
        await settle();
        assertAutomationCondition(shown(small).length === 2, "Clicking the active squad's card did not reopen it.");

        cardOf(largeId).querySelector("[data-sci-carousel-pin]").click();
        await waitForCondition(() => combat.getFlag(MODULE_ID, `groups.${largeId}.pinned`) === true);
        await settle();
        assertAutomationCondition(combat.getFlag(MODULE_ID, `groups.${largeId}.pinned`) === true && shown(large).length === 3, "The card's pin did not pin and open the squad.", { shown: shown(large) });
        assertAutomationCondition(cardOf(largeId).querySelector(".sci-carousel-pin.pinned"), "The card does not show that it is pinned.");
        cardOf(largeId).querySelector("[data-sci-carousel-pin]").click();
        await waitForCondition(() => combat.getFlag(MODULE_ID, `groups.${largeId}.pinned`) === false);
        await settle();
        assertAutomationCondition(!shown(large).length, "Unpinning did not let the squad collapse.");

        cardOf(largeId).click();
        await settle();
        assertAutomationCondition(shown(large).length === 3, "Clicking a collapsed card did not open it a second time.");
        await combat.nextTurn();
        await settle();
        assertAutomationCondition(shown(large).length === 3, "A click did not last while the turn stayed in the same squad.");
        await combat.nextTurn();
        await settle();
        assertAutomationCondition(combat.combatant.id === loner.id && !shown(large).length, "A click outlived the turn moving to another squad.", { current: combat.combatant.id, shown: shown(large) });

        await game.settings.set(MODULE_ID, "carouselCollapse", "hostile");
        await large[0].token.update({ disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY });
        for (const member of large.slice(1)) await member.token.update({ disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY });
        await settle();
        assertAutomationCondition(shown(large).length === 3, "A friendly squad did not stay expanded with that setting.", { shown: shown(large) });
        await game.settings.set(MODULE_ID, "carouselCollapse", "all");
        await settle();
        assertAutomationCondition(!shown(large).length, "A friendly squad did not collapse by default.");

        // The ungrouped member is acting, and turn order wraps back around to the large squad.
        assertAutomationCondition(cardOf(largeId).classList.contains("sci-next") && !cardOf(smallId).classList.contains("sci-next"), "The up-next highlight did not wrap around the round.", { large: cardOf(largeId).className, small: cardOf(smallId).className });
        await game.settings.set(MODULE_ID, "carouselShowNext", false);
        await settle();
        assertAutomationCondition(!list.querySelector(".sci-carousel-squad.sci-next:not(.flip-ghost)"), "The up-next highlight ignored its setting.");

        const hpOf = (member) => member.actor.system.attributes.hp;
        const healthBar = (groupId) => cardOf(groupId).querySelector(".sci-carousel-squad-health");
        const startingHp = new Map([...large, ...small].map((member) => [member.id, hpOf(member).value]));
        assertAutomationCondition(healthBar(largeId)?.querySelector("span").style.width === "100%", "A healthy squad's bar is not full.", { width: healthBar(largeId)?.querySelector("span").style.width });
        await large[0].actor.update({ "system.attributes.hp.value": 0 });
        await waitForMutations(combat);
        await settle();
        const totalMax = large.reduce((sum, member) => sum + (hpOf(member).effectiveMax ?? hpOf(member).max), 0);
        const totalValue = large.reduce((sum, member) => sum + hpOf(member).value, 0);
        const expectedWidth = `${Math.round(totalValue / totalMax * 100)}%`;
        assertAutomationCondition(healthBar(largeId)?.querySelector("span").style.width === expectedWidth, "An unlinked member's damage did not update the squad's bar.", { width: healthBar(largeId)?.querySelector("span").style.width, expectedWidth });
        await game.settings.set(MODULE_ID, "carouselShowHealth", false);
        await settle();
        assertAutomationCondition(!healthBar(largeId), "The health bar ignored its setting.");
        await game.settings.set(MODULE_ID, "carouselShowHealth", true);

        assertAutomationCondition(!cardOf(largeId).classList.contains("sci-defeated"), "A partly down squad was marked defeated.");
        for (const member of small) await member.actor.update({ "system.attributes.hp.value": 0 });
        await waitForMutations(combat);
        await settle();
        assertAutomationCondition(cardOf(smallId).classList.contains("sci-defeated") && getComputedStyle(cardOf(smallId)).filter !== "none", "A squad with every member down did not dim.", { card: cardOf(smallId).className });
        await game.settings.set(MODULE_ID, "carouselDimDefeated", false);
        await settle();
        assertAutomationCondition(!cardOf(smallId).classList.contains("sci-defeated"), "Dimming ignored its setting.");
        for (const member of [...large, ...small]) await member.actor.update({ "system.attributes.hp.value": startingHp.get(member.id) });
        await waitForMutations(combat);

        await game.settings.set(MODULE_ID, "carouselSquadCards", false);
        await settle();
        assertAutomationCondition(!cards().length && !list.querySelector(".sci-carousel-nudge:not(.flip-ghost), .sci-carousel-member:not(.flip-ghost), .sci-carousel-collapsed:not(.flip-ghost)") && shown(large).length === 5, "Turning squad cards off left the layout behind.", { cards: cards(), shown: shown(large), leftovers: [...list.querySelectorAll(".sci-carousel-nudge:not(.flip-ghost), .sci-carousel-member:not(.flip-ghost), .sci-carousel-collapsed:not(.flip-ghost)")].map((element) => element.className), portraits: large.map((member) => portrait(member)?.className ?? "missing") });
        return { firstWindow, scrolled, turnsWalked, cards: 2, stack: stackDetails };
      } finally {
        await game.settings.set(MODULE_ID, "carouselSquadCards", false);
        await combat.delete();
        await scene.deleteEmbeddedDocuments("Token", tokens.map((token) => token.id));
        await state.combat.activate();
      }
    });

    await runAutomationStep(steps, "carousel cards for other clients, right-click and hover", async () => {
      if (game.modules.get(MODULE_ID)?.__carouselSquadsRegistered !== true) return { skipped: true, reason: "Carousel Combat Tracker is not active" };
      const [alpha, bravo, charlie] = state.actors;
      const tokens = await createFixtureTokens(scene, [alpha, alpha, bravo, bravo, charlie], marker);
      const combat = await createFixtureCombat(scene, tokens, marker);
      try {
        await game.settings.set(MODULE_ID, "carouselExpandDirection", "along");
        await game.settings.set(MODULE_ID, "carouselCollapse", "all");
        await game.settings.set(MODULE_ID, "carouselShowHealth", true);
        await game.settings.set(MODULE_ID, "carouselShowNext", true);
        await game.settings.set(MODULE_ID, "carouselSquadCards", true);
        await combat.activate();
        await waitForCondition(() => ui.combatDock?.combat === combat && ui.combatDock.element?.querySelector("#combatants .combatant-portrait"), 5000);
        const list = ui.combatDock.element.querySelector("#combatants");
        const members = tokens.map((token) => combat.combatants.find((combatant) => combatant.tokenId === token.id));
        const createSquad = async (label, squad, data = {}) => {
          const groupId = await GroupManager.createGroup(combat, { name: fixtureName(runId, label), img: "icons/svg/combat.svg", color: "#33aaff", pinned: false, hidden: false, ...data }, []);
          await markFixtureGroup(combat, groupId, marker);
          await GroupManager.addCombatantsToGroup(combat, groupId, squad.map((member) => member.id));
          return groupId;
        };
        const openId = await createSquad("Open", members.slice(0, 2));
        const hiddenId = await createSquad("Hidden", members.slice(2, 4));
        await GroupManager.toggleGroupVisibility(combat, hiddenId);
        await GroupManager.setGroupInitiative(combat, openId, 30);
        await GroupManager.setGroupInitiative(combat, hiddenId, 20);
        await members[4].update({ initiative: 10 });
        await combat.startCombat();
        await settleFixture(combat, 600);

        const cardOf = (groupId) => list.querySelector(`.sci-carousel-squad[data-group-key="${groupId}"]:not(.flip-ghost)`);
        assertAutomationCondition(cardOf(openId) && cardOf(hiddenId), "The GM does not see both squad cards.");
        assertAutomationCondition(cardOf(hiddenId).classList.contains("sci-next") && cardOf(hiddenId).classList.contains("sci-hidden"), "The GM should see the hidden squad muted and up next.");

        // Right-click: the card's own menu, for those who manage squads.
        const rect = cardOf(openId).getBoundingClientRect();
        cardOf(openId).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 5, clientY: rect.top + 5 }));
        await waitForCondition(() => document.querySelector("#context-menu li"), 1000);
        const menuItems = [...document.querySelectorAll("#context-menu li")];
        const menuLabels = menuItems.map((item) => item.textContent.trim());
        const selectLabel = game.i18n.localize("SCI.Card.Select");
        assertAutomationCondition(menuLabels.includes(selectLabel) && menuLabels.includes(game.i18n.localize("SCI.Carousel.ToggleVisibility")), "The card's right-click menu is missing its entries.", { menuLabels });
        menuItems.find((item) => item.textContent.trim() === selectLabel).click();
        await waitForCondition(() => canvas.tokens.controlled.length >= 2, 1000);
        const selected = canvas.tokens.controlled.map((token) => token.id);
        assertAutomationCondition(tokens.slice(0, 2).every((token) => selected.includes(token.id)), "The menu's Select did not select the squad's tokens.", { selected });
        canvas.tokens.releaseAll();

        // Hover highlights follow the same rule as the tracker.
        await game.settings.set(MODULE_ID, "groupTokenHighlight", "gm");
        cardOf(openId).dispatchEvent(new MouseEvent("mouseenter"));
        const lit = tokens.slice(0, 2).map((token) => !!token.object?._sciGroupHighlight);
        cardOf(openId).dispatchEvent(new MouseEvent("mouseleave"));
        assertAutomationCondition(lit.every(Boolean) && !tokens[0].object?._sciGroupHighlight, "Hovering a card did not highlight and then clear its tokens.", { lit });

        // What the other clients actually drew.
        const collect = context.collectClientDiagnostics;
        const viewOf = (result, test) => (result?.clientSnapshots ?? []).find((snapshot) => test(snapshot.user))?.localUi?.carouselCards;
        const clients = await collect({ includeDom: true, expectedNonGMClients: 1, expectedGMClients: 2 });
        const player = viewOf(clients, (user) => !user.isGM);
        const assistant = viewOf(clients, (user) => user.isGM);
        const coverage = { player: player ? "checked" : "no player client connected", assistant: assistant ? "checked" : "no Assistant client connected" };
        if (player) {
          assertAutomationCondition(player.length === 1 && player[0].groupId === openId, "A player can see a hidden squad's card.", { player, hiddenId });
          assertAutomationCondition(!player[0].hasHealth, "A player can see a squad's health.", { player });
          assertAutomationCondition(!player[0].canPin, "A player was offered the pin.", { player });
          assertAutomationCondition(!player[0].upNext, "A player's up-next glow gave away a hidden squad's turn.", { player });
        }
        if (assistant) {
          const openCard = assistant.find((card) => card.groupId === openId);
          assertAutomationCondition(assistant.length === 2 && openCard?.hasHealth && openCard?.canPin, "An Assistant does not get the manager's card.", { assistant });
        }

        // A pin set here reaches the other clients, while a click stays on this one.
        await GroupManager.editGroup(combat, hiddenId, { pinned: true });
        await settleFixture(combat, 600);
        cardOf(openId).click();
        await settleFixture(combat);
        const afterPin = await collect({ includeDom: true, expectedNonGMClients: 1, expectedGMClients: 2 });
        const assistantAfter = viewOf(afterPin, (user) => user.isGM);
        const playerAfter = viewOf(afterPin, (user) => !user.isGM);
        if (assistantAfter) {
          assertAutomationCondition(assistantAfter.find((card) => card.groupId === hiddenId)?.pinned === true && assistantAfter.find((card) => card.groupId === hiddenId)?.expanded === true, "A pin did not reach another client.", { assistantAfter });
          assertAutomationCondition(assistantAfter.find((card) => card.groupId === openId)?.expanded === true, "A click on this client collapsed a squad on another client.", { assistantAfter });
        }
        if (playerAfter) assertAutomationCondition(playerAfter[0]?.expanded === true, "A click on this client collapsed a squad for a player.", { playerAfter });
        assertAutomationCondition(!cardOf(openId).classList.contains("sci-expanded"), "The click did not collapse the squad on this client.");
        return { menuLabels, selected: selected.length, coverage };
      } finally {
        canvas.tokens.releaseAll();
        await game.settings.set(MODULE_ID, "carouselSquadCards", false);
        await combat.delete();
        await scene.deleteEmbeddedDocuments("Token", tokens.map((token) => token.id));
        await state.combat.activate();
      }
    });

    await runAutomationStep(steps, "carousel squad cards in the other layouts", async () => {
      if (game.modules.get(MODULE_ID)?.__carouselSquadsRegistered !== true) return { skipped: true, reason: "Carousel Combat Tracker is not active" };
      const carouselId = "combat-tracker-dock";
      const previous = { direction: game.settings.get(carouselId, "direction"), carouselStyle: game.settings.get(carouselId, "carouselStyle") };
      const [alpha, bravo, charlie] = state.actors;
      const tokens = await createFixtureTokens(scene, [alpha, alpha, alpha, alpha, bravo, charlie], marker);
      const combat = await createFixtureCombat(scene, tokens, marker);
      const results = [];
      try {
        await game.settings.set(MODULE_ID, "carouselExpandDirection", "along");
        await game.settings.set(MODULE_ID, "carouselCollapse", "all");
        await game.settings.set(MODULE_ID, "carouselMembersShown", 3);
        await game.settings.set(MODULE_ID, "carouselSquadCards", true);
        await combat.activate();
        const members = tokens.map((token) => combat.combatants.find((combatant) => combatant.tokenId === token.id));
        const groupId = await GroupManager.createGroup(combat, { name: fixtureName(runId, "Layouts"), img: "icons/svg/combat.svg", color: "#33aaff", pinned: false, hidden: false }, []);
        await markFixtureGroup(combat, groupId, marker);
        await GroupManager.addCombatantsToGroup(combat, groupId, members.slice(0, 4).map((member) => member.id));
        await GroupManager.setGroupInitiative(combat, groupId, 30);
        await members[4].update({ initiative: 10 });
        await members[5].update({ initiative: 5 });
        await combat.startCombat();

        const layouts = [
          { label: "floating row", direction: "rowFloat", carouselStyle: previous.carouselStyle },
          { label: "vertical", direction: "columnFloat", carouselStyle: previous.carouselStyle },
          { label: "docked, left aligned", direction: "rowDocked", carouselStyle: 1 },
          { label: "docked, basic", direction: "rowDocked", carouselStyle: 2 },
        ];
        for (const layout of layouts) {
          await game.settings.set(carouselId, "carouselStyle", layout.carouselStyle);
          await game.settings.set(carouselId, "direction", layout.direction);
          await game.settings.set(MODULE_ID, "carouselExpandDirection", "along");
          await settleFixture(combat);
          // Changing direction closes the carousel and builds a new one, so wait for the result rather than a time.
          const currentList = () => (ui.combatDock?.combat === combat ? ui.combatDock.element?.querySelector("#combatants") : null);
          const portraitIn = (root, member) => root?.querySelector(`.combatant-portrait[data-combatant-id="${member.id}"]`);
          const shownIn = (root, group) => group.filter((member) => { const element = portraitIn(root, member); return element && getComputedStyle(element).display !== "none"; });
          const cardIn = (root) => root?.querySelector(`.sci-carousel-squad[data-group-key="${groupId}"]:not(.flip-ghost)`);
          await waitForCondition(() => { const root = currentList(); return cardIn(root)?.classList.contains("sci-expanded") && shownIn(root, members.slice(0, 4)).length === 3; }, 5000);
          finishAnimations(document.body);
          const list = currentList();
          assertAutomationCondition(list, "The carousel did not reopen for this layout.", { layout, dockCombat: ui.combatDock?.combat?.id ?? null, combat: combat.id });
          const portrait = (member) => portraitIn(list, member);
          const shown = (group) => shownIn(list, group);
          const card = cardIn(list);
          assertAutomationCondition(card?.classList.contains("sci-expanded") && shown(members.slice(0, 4)).length === 3, "The active squad did not expand in this layout.", { layout, card: card?.className ?? null, shown: shown(members.slice(0, 4)).length, portraits: members.slice(0, 4).map((member) => portrait(member)?.className ?? "missing"), failed: !!list.querySelector(".sci-carousel-squad") });
          assertAutomationCondition(shown(members.slice(4)).length === 2, "An ungrouped portrait was hidden in this layout.", { layout });

          await game.settings.set(MODULE_ID, "carouselExpandDirection", "away");
          await settleFixture(combat);
          finishAnimations(document.body);
          await settleFixture(combat);
          const cardRect = card.getBoundingClientRect();
          const rects = shown(members.slice(0, 4)).map((member) => portrait(member).getBoundingClientRect());
          const clear = rects.every((rect) => rect.top >= cardRect.bottom - 1 || rect.bottom <= cardRect.top + 1 || rect.left >= cardRect.right - 1 || rect.right <= cardRect.left + 1);
          assertAutomationCondition(rects.length >= 1 && clear, "The stack overlaps its card in this layout.", { layout, card: cardRect, rects });
          const onScreen = rects.every((rect) => rect.left >= -1 && rect.top >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1);
          assertAutomationCondition(onScreen, "The stack ran off the screen in this layout.", { layout, rects, window: [window.innerWidth, window.innerHeight] });
          results.push({ label: layout.label, stacked: rects.length, opens: rects[0].top >= cardRect.bottom - 1 ? "down" : rects[0].bottom <= cardRect.top + 1 ? "up" : rects[0].left >= cardRect.right - 1 ? "right" : "left" });
        }
        return { results };
      } finally {
        await game.settings.set(MODULE_ID, "carouselExpandDirection", "along");
        await game.settings.set(MODULE_ID, "carouselSquadCards", false);
        await game.settings.set(carouselId, "carouselStyle", previous.carouselStyle);
        await game.settings.set(carouselId, "direction", previous.direction);
        await combat.delete();
        await scene.deleteEmbeddedDocuments("Token", tokens.map((token) => token.id));
        await state.combat.activate();
        await settleFixture(state.combat, 500);
      }
    });

    await runAutomationStep(steps, "carousel settings window saves and greys out", async () => {
      const menu = game.settings.menus.get(`${MODULE_ID}.carouselSettings`);
      assertAutomationCondition(menu?.type, "The Carousel Settings menu is not registered.");
      const dockPrototype = CONFIG.combatTrackerDock?.CombatDock?.prototype;
      const carouselActive = !!game.modules.get("combat-tracker-dock")?.active && !!dockPrototype;
      const openSettingsButton = async () => {
        const sheet = new foundry.applications.settings.SettingsConfig();
        await sheet.render({ force: true });
        const button = sheet.element.querySelector(`button[data-action="openSubmenu"][data-key="${MODULE_ID}.carouselSettings"]`);
        const state = { found: !!button, disabled: !!button?.disabled };
        await sheet.close();
        return state;
      };
      let saved = null;
      if (carouselActive) {
        const app = new menu.type();
        await app.render({ force: true });
        const form = app.element;
        assertAutomationCondition(!form.querySelector("fieldset").disabled, "The settings are disabled while Carousel is available.");
        assertAutomationCondition(form.querySelectorAll("select[name='carouselExpandDirection'] option").length === 3, "The expand direction options are missing.");
        assertAutomationCondition(form.querySelector("button[type='submit']"), "The window has no save button.");
        const target = game.settings.get(MODULE_ID, "carouselMembersShown") === 7 ? 8 : 7;
        form.querySelector("input[name='carouselMembersShown']").value = target;
        form.querySelector("select[name='carouselExpandDirection']").value = "cycle";
        await app.submit();
        saved = { membersShown: game.settings.get(MODULE_ID, "carouselMembersShown"), direction: game.settings.get(MODULE_ID, "carouselExpandDirection") };
        assertAutomationCondition(saved.membersShown === target && saved.direction === "cycle", "The window did not save its values.", { saved, target });
        await app.close();
        const enabled = await openSettingsButton();
        assertAutomationCondition(enabled.found && !enabled.disabled, "The settings button is greyed out while Carousel is available.", enabled);
      }

      // An unsupported Carousel: take away a method the layout needs, then put it straight back.
      const greyed = {};
      const animateOrder = dockPrototype?.animateOrder;
      if (dockPrototype) dockPrototype.animateOrder = undefined;
      try {
        const app = new menu.type();
        await app.render({ force: true });
        greyed.fieldsetDisabled = app.element.querySelector("fieldset").disabled;
        greyed.notice = app.element.querySelector(".notification")?.textContent ?? null;
        greyed.saveButton = !!app.element.querySelector("button[type='submit']");
        await app.close();
        greyed.button = await openSettingsButton();
      } finally {
        if (dockPrototype) dockPrototype.animateOrder = animateOrder;
      }
      assertAutomationCondition(greyed.fieldsetDisabled && greyed.notice && !greyed.saveButton && greyed.button.found && greyed.button.disabled, "The settings did not grey out when Carousel is unavailable.", greyed);
      return { saved, greyed };
    });

    await runAutomationStep(steps, "placing an Encounter runs through the real dnd5e path", async () => {
      const encounterData = dnd5e.dataModels.actor.EncounterData;
      assertAutomationCondition(game.modules.get(MODULE_ID)?.__encounterSquadsRegistered === true, "The Encounter wrapper is not registered.");
      const [alpha, bravo] = state.actors;
      const [encounter] = await Actor.createDocuments([withFixtureFlag({ name: fixtureName(runId, "Encounter Actor"), type: "encounter", img: "icons/svg/skull.svg" }, marker)]);
      const combat = await game.combats.documentClass.create(withFixtureFlag({ name: fixtureName(runId, "Encounter Combat"), active: false }, marker));
      const tokens = await createFixtureTokens(scene, [alpha, alpha, bravo], marker);
      // Only the interactive token placement is replaced. dnd5e's own combat code and the wrapper both run.
      const template = Object.getPrototypeOf(encounterData.prototype);
      const placement = Object.getOwnPropertyDescriptor(template, "placeMembers");
      let placed = tokens;
      template.placeMembers = async () => placed;
      try {
        await combat.activate();
        await tokens[2].actor.update({ "system.traits.important": true });
        await game.settings.set(MODULE_ID, "encounterSquads", true);
        const groupsBefore = () => Object.keys(combat.getFlag(MODULE_ID, "groups") ?? {}).length;

        const none = await encounter.system.placeMembers({ combatBehavior: "none" });
        assertAutomationCondition(none === tokens && !combat.combatants.size && !groupsBefore(), "Placement with no combat behavior touched the encounter.", { combatants: combat.combatants.size, groups: groupsBefore() });

        const returned = await encounter.system.placeMembers({ combatBehavior: "rollInitiative" });
        await waitForMutations(combat);
        await waitForCondition(() => groupsBefore() === 1 && combat.getFlag(MODULE_ID, `groups.${Object.keys(combat.getFlag(MODULE_ID, "groups"))[0]}.captainId`));
        assertAutomationCondition(returned === tokens, "The wrapper did not return dnd5e's placed tokens.");
        assertAutomationCondition(groupsBefore() === 1, "Placing the Encounter did not create one squad.", { groups: groupsBefore() });
        const [groupId, group] = Object.entries(combat.getFlag(MODULE_ID, "groups"))[0];
        const members = combat.combatants.filter((combatant) => combatant.getFlag(MODULE_ID, "groupId") === groupId);
        assertAutomationCondition(members.length === tokens.length && members.every((member) => Number.isFinite(member.initiative)), "The placed members did not join the squad with rolled initiative.", { members: members.map((member) => member.initiative) });
        assertAutomationCondition(group.name === encounter.name && group.img === encounter.img, "The squad did not take the Encounter's name and image.", { group });
        const important = combat.combatants.find((combatant) => combatant.tokenId === tokens[2].id);
        assertAutomationCondition(group.captainId === important.id, "The Important NPC is not the captain.", { captainId: group.captainId, important: important.id });
        const rolls = members.map((member) => member.initiative);
        assertAutomationCondition(group.initiative === calculateGroupInitiative(rolls, group.initiativeMode), "The already rolled members did not produce an aggregate.", { rolls, initiative: group.initiative });

        await game.settings.set(MODULE_ID, "encounterSquads", false);
        placed = await createFixtureTokens(scene, [bravo], marker);
        await encounter.system.placeMembers({ combatBehavior: "createCombatants" });
        await waitForMutations(combat);
        assertAutomationCondition(groupsBefore() === 1 && combat.combatants.size === tokens.length + 1, "The disabled setting still created a squad, or dnd5e did not add the member.", { groups: groupsBefore(), combatants: combat.combatants.size });
        return { groupId, captain: important.id, rolls, sceneLinked: !!combat.scene };
      } finally {
        if (placement) Object.defineProperty(template, "placeMembers", placement);
        else delete template.placeMembers;
        await game.settings.set(MODULE_ID, "encounterSquads", true);
        await combat.delete();
        const fixtureTokens = [...new Set([...tokens, ...placed])];
        await scene.deleteEmbeddedDocuments("Token", fixtureTokens.map((token) => token.id));
        await encounter.delete();
        await state.combat.activate();
      }
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
        if (status === "fleeing") {
          assertAutomationCondition(managed[0].img === "icons/svg/terror.svg", "Fleeing effect image was lost during V14 data validation.");
          assertAutomationCondition(managed[0].name === game.i18n.localize("SCI.Effect.Fleeing"), "The registered Fleeing condition name was not localized.", { name: managed[0].name });
        }
        await MoraleManager.clearMoraleEffect(target);
        assertAutomationCondition(actor.effects.has(unrelated.id), "Clearing morale removed an unrelated effect.", { status });
        assertAutomationCondition(!actor.effects.some((effect) => effect.getFlag(MODULE_ID, "moraleEffect")), "Clearing morale left a managed effect.", { status });
        await actor.deleteEmbeddedDocuments("ActiveEffect", [unrelated.id]);
        results.push(status);
      }

      const fleeingCondition = CONFIG.statusEffects.fleeing;
      assertAutomationCondition(fleeingCondition?.hud !== false && CONFIG.DND5E.conditionTypes.fleeing?.name === game.i18n.localize("SCI.Effect.Fleeing"), "Fleeing is not offered as a localized condition.", { fleeingCondition });
      await game.settings.set(MODULE_ID, "moraleStatusEffect", "fleeing");
      await actor.update({ "system.traits.ci.value": ["fleeing"] });
      await MoraleManager.applyMoraleEffect(target);
      const immuneEffects = actor.effects.filter((effect) => effect.getFlag(MODULE_ID, "moraleEffect")).length;
      const immuneHasStatus = actor.statuses.has("fleeing");
      await MoraleManager.clearMoraleEffect(target);
      await actor.update({ "system.traits.ci.value": [] });
      await game.settings.set(MODULE_ID, "moraleStatusEffect", "none");
      assertAutomationCondition(immuneEffects === 1 && !immuneHasStatus, "A condition-immune actor still gained the Fleeing status.", { immuneEffects, immuneHasStatus });
      return { statuses: results, immuneActorIgnoresFleeing: true };
    });

    await runAutomationStep(steps, "morale effect duration expiry observed in a started combat", async () => {
      const groupId = state.groups[0];
      const target = state.combat.combatants.get(state.combatants[0].id);
      const actor = target.actor;
      const previousStatus = game.settings.get(MODULE_ID, "moraleStatusEffect");
      const position = () => ({ round: state.combat.round, turn: state.combat.turn, combatantId: state.combat.combatant?.id ?? null });
      try {
        const observations = {};
        // Built-in statuses and the custom Fleeing effect build their duration differently.
        for (const status of ["frightened", "fleeing"]) {
          await game.settings.set(MODULE_ID, "moraleStatusEffect", status);
          await target.setFlag(MODULE_ID, "moraleStatus", "failed");
          await MoraleManager.applyMoraleEffect(target);
          const effect = actor.effects.find((candidate) => candidate.getFlag(MODULE_ID, "moraleEffect"));
          assertAutomationCondition(effect, "The morale effect was not created in the started combat.", { status });
          const createdAt = position();
          const source = { duration: foundry.utils.deepClone(effect._source.duration), start: foundry.utils.deepClone(effect._source.start) };
          // In combat dnd5e keeps an expired effect, marked and suppressed, so read its state each turn.
          const readOutcome = () => {
            const current = actor.effects.get(effect.id);
            return !current ? "deleted" : current.duration.expired ? "expired" : null;
          };
          // This records the behavior for the 14.4.0 decision; it does not assert a turn.
          const maxTurns = state.combat.turns.length * 3;
          let turnsWalked = 0;
          while (!readOutcome() && turnsWalked < maxTurns) {
            await state.combat.nextTurn();
            await waitForMutations(state.combat);
            await new Promise((resolve) => setTimeout(resolve, 100));
            turnsWalked += 1;
          }
          const outcome = readOutcome();
          const remaining = actor.effects.get(effect.id);
          assertAutomationCondition(source.duration.value === 1 && source.duration.units === "rounds", "The morale effect did not store the configured duration.", { status, source });
          assertAutomationCondition(outcome === "expired", "The timed morale effect did not expire within three rounds.", { status, outcome, turnsWalked });
          assertAutomationCondition(!actor.statuses.has(status), "An expired morale effect still applies its status.", { status });
          const expiredState = { effectActive: remaining?.active ?? null, actorHasStatus: actor.statuses.has(status) };
          await MoraleManager.applyMoraleEffect(target);
          const reapplied = actor.effects.filter((candidate) => candidate.getFlag(MODULE_ID, "moraleEffect"));
          assertAutomationCondition(reapplied.length === 1 && reapplied[0].active && actor.statuses.has(status), "A repeat failure did not reactivate the expired morale effect.", { status, count: reapplied.length });
          observations[status] = {
            source,
            createdAt,
            outcome,
            endedAt: outcome ? position() : null,
            turnsWalked,
            ...expiredState,
            moraleStatusAfter: target.getFlag(MODULE_ID, "moraleStatus") ?? null,
          };
          await MoraleManager.clearMorale(state.combat, groupId);
        }
        return {
          moraleEffectDuration: game.settings.get(MODULE_ID, "moraleEffectDuration"),
          targetId: target.id,
          turnsPerRound: state.combat.turns.length,
          observations,
        };
      } finally {
        await MoraleManager.clearMorale(state.combat, groupId);
        await game.settings.set(MODULE_ID, "moraleStatusEffect", previousStatus);
      }
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
  const dnd5eSettingsRestored = settingsMatch(previousDnd5eSettings, captureSettings(DND5E_RECORDED_SETTING_KEYS, "dnd5e"));
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
    && dnd5eSettingsRestored
    && previousCombatRestored;

  return {
    success,
    gameplayAcceptancePassed: success && state.clientAcceptance?.status === "passed",
    clientAcceptance: state.clientAcceptance,
    runId,
    fixturePrefix: FIXTURE_PREFIX,
    dnd5eSettings: previousDnd5eSettings,
    beforeCounts,
    afterCounts,
    documentCountDelta,
    cleanupBefore: cleanupBeforeResult,
    cleanupAfter: cleanupAfterResult,
    cleanupVerified,
    remainingFixtures,
    restored: {
      settings: !restoreError && settingsRestored,
      dnd5eSettings: dnd5eSettingsRestored,
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

/** Ends finite animations; Carousel's current portrait also runs an endless one, which cannot finish. */
function finishAnimations(element) {
  for (const animation of element.getAnimations({ subtree: true })) {
    if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
  }
}

/** Lets queued work finish and debounced carousel layout run. */
async function settleFixture(combat, delayMs = 150) {
  await waitForMutations(combat);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForCondition(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
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

function getSettingValue(key, namespace = MODULE_ID) {
  try {
    return game.settings.get(namespace, key);
  } catch (err) {
    return { error: err.message };
  }
}

function captureSettings(keys, namespace = MODULE_ID) {
  const settings = {};
  for (const key of keys) {
    settings[key] = getSettingValue(key, namespace);
  }
  return settings;
}

async function applyAutomationSettings() {
  const updates = {
    autoCollapseGroups: true,
    defaultGroupPinned: false,
    defaultInitiativeMode: INITIATIVE_MODE.AVERAGE,
    encounterSquads: true,
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

  // Creation does not always return tokens in request order; grid position restores it.
  const tokens = await scene.createEmbeddedDocuments("Token", tokenData);
  return tokens.sort((a, b) => (a.y - b.y) || (a.x - b.x));
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
    // Unlinked encounters belong to no scene; the marker still scopes which ones are fixtures.
    return !sceneId || sceneId === scene.id;
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
