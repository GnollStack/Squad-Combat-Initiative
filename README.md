<div align="center">

# Squad Combat Initiative

**Run big D&D 5e fights as readable squads without losing individual combatants.**

[![Latest Release](https://img.shields.io/github/v/release/GnollStack/Squad-Combat-Initiative?label=Latest%20Release&style=flat-square)](https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/GnollStack/Squad-Combat-Initiative/squad-combat-initiative.zip?label=Downloads&style=flat-square&color=green)](https://github.com/GnollStack/Squad-Combat-Initiative/releases)
[![Latest Downloads](https://img.shields.io/github/downloads/GnollStack/Squad-Combat-Initiative/latest/squad-combat-initiative.zip?label=Latest%20Downloads&style=flat-square)](https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest)
[![Foundry VTT v14](https://img.shields.io/badge/Foundry-v14-orange?style=flat-square)](https://foundryvtt.com)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20a%20Steak-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/gnollstack)
[![Patreon: Bazaar Patron](https://img.shields.io/badge/Patreon-Bazaar%20Patron-F96854?style=flat-square&logo=patreon&logoColor=white)](https://www.patreon.com/cw/GnollStack)
[![Discord: Bakshi's Bazaar](https://img.shields.io/badge/Discord-Bakshi%27s%20Bazaar-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/tcdYk54fxC)

*Group combatants into squads with shared initiative, captains, and morale.*

[Preview](#preview) · [Quick Start](#quick-start) · [Features](#features) · [Use It For](#use-it-for) · [Installation](#installation) · [Changelog](https://github.com/GnollStack/bakshis-bazaar-archives/blob/main/squad-combat-initiative/CHANGELOG.md) · [Compatibility](#compatibility) · [API](#developer-api) · [Bakshi's Bazaar](#bakshis-bazaar) · [Community](#community) · [Contributing](#contributing) · [AI Use](#ai-assisted-development) · [Support](#support-development) · [License](#license-permissions)

</div>

---

<div align="center">

## Feature Index

| Feature | What it does |
| :--- | :--- |
| **[Squads and presets](#combat-groups)** | Name, color, and organize combatants; reuse squad configurations. |
| **[Group initiative](#group-initiative)** | Keep individual rolls while ordering squads together with five calculation modes. |
| **[Tracker controls](#group-header-controls)** | Roll, skip, rally, rename, and change squad icons from the sidebar or popout. |
| **[Display and visibility](#group-header-controls)** | Choose card detail, collapse members, and control player morale summaries. |
| **[Captains and morale](#squad-morale)** | Let leaders and casualties affect whether living members hold or break. |

*Individual Foundry combatant rows remain available beneath each squad card.*

</div>

---

<div align="center">

<a id="preview"></a>

## Preview

</div>

<div align="center">

<img width="371" height="481" alt="Squad tracker overview" src="https://raw.githubusercontent.com/GnollStack/bakshis-bazaar-archives/main/squad-combat-initiative/images/squad-combat-initiative-tracker-overview.png" />

*Earlier interface shown. Version 14.2.0 uses expanded squad cards.*

</div>

<details>
<summary><strong>More screenshots</strong></summary>

These screenshots show the earlier compact headers. Version 14.2.0 uses expanded squad cards; the images will be updated.

<div align="center">

**Tracker overview**

<img width="371" height="481" alt="Squad tracker overview" src="https://raw.githubusercontent.com/GnollStack/bakshis-bazaar-archives/main/squad-combat-initiative/images/squad-combat-initiative-tracker-overview.png" />

</div>

<div align="center">

**Combat groups**

<img width="190" height="613" alt="Combat groups in the tracker" src="https://raw.githubusercontent.com/GnollStack/bakshis-bazaar-archives/main/squad-combat-initiative/images/squad-combat-initiative-combat-groups.png" />

</div>

<div align="center">

**Group initiative**

<img width="185" height="504" alt="Group initiative controls" src="https://raw.githubusercontent.com/GnollStack/bakshis-bazaar-archives/main/squad-combat-initiative/images/squad-combat-initiative-group-initiative.png" />

</div>

<div align="center">

**Captain controls**

<img width="369" height="410" alt="Captain controls" src="https://raw.githubusercontent.com/GnollStack/bakshis-bazaar-archives/main/squad-combat-initiative/images/squad-combat-initiative-captain-controls.png" />

</div>

<div align="center">

**Morale settings and controls**

<img width="366" height="567" alt="Squad Combat Initiative settings and controls" src="https://raw.githubusercontent.com/GnollStack/bakshis-bazaar-archives/main/squad-combat-initiative/images/squad-combat-initiative-morale-settings.png" />

</div>

</details>

---

<div align="center">

<a id="quick-start"></a>

## Quick Start

</div>

1. Install and enable **Squad Combat Initiative** in your world.
2. Start a D&D 5e combat with several combatants.
3. Use **Add Group** to create a group from selected canvas tokens, or create an empty group.
4. Use **Auto Group** to group selected or all combatants by actor or disposition.
5. Roll a group from its header. Members roll individually, and the group receives a calculated initiative.

---

<div align="center">

<a id="features"></a>

## Features

</div>

Each squad appears as a card in the combat tracker, with its members listed underneath. Expand a section below for controls, settings, and mechanics.

<a id="combat-groups"></a>

<details>
<summary><strong>Squad setup, assignment, and presets</strong></summary>

**Create expanded squad cards in the sidebar and tracker popout.**

Create custom groups from selected tokens, build empty groups for drag/drop setup, or auto-group combatants by actor or token disposition. Existing groups are skipped unless you choose to regroup them.

| Method | What it does |
| --- | --- |
| Add Group | Creates a custom group from selected canvas tokens or an empty group. |
| Auto Group | Groups selected or all combatants by actor or disposition. |
| Drag and Drop | Moves combatants between squads or into the explicit Ungrouped area; cross-combat drops are rejected. |
| Assign | Keyboard-accessible assignment from each member row or its context menu. |

Group metadata includes name, color, icon, hidden state, pinning, initiative mode, discipline, morale trigger, and captain assignment.

**Group presets** let you save a squad's configuration (name, icon, color, initiative mode, discipline, morale trigger) and reapply it from the Create Group dialog in any later combat. Tick *Save these settings as a preset* when creating a group, then pick it from the *Preset* dropdown next time. Use **Presets** in the tracker toolbar to create, edit, rename, or delete presets. Presets omit members, captains, rolls, visibility, and encounter morale state. The developer API supports the same operations.

</details>

<a id="group-initiative"></a>

<details>
<summary><strong>Initiative modes, manual scores, and captains</strong></summary>

**Keep individual rolls while sorting the squad as a unit.**

Each grouped combatant still rolls normally. The group initiative is calculated from member results using the selected mode.

The original combatant rolls remain unchanged. Squad Combat Initiative orders finalized groups through Foundry's combat comparator, so large or tied groups stay contiguous without fractional initiative offsets. Changing mode or captain after a roll always recalculates from the original member results.

| Mode | Calculation |
| --- | --- |
| Average | Rounded mean of member initiatives. |
| Highest | Best member initiative. |
| Lowest | Worst member initiative. |
| Median | Middle member initiative. |
| Captain | Uses the captain's initiative, with a safe fallback if needed. |

Empty and partially rolled squads have no computed aggregate. A manually assigned squad score persists through cosmetic edits and reloads until a member initiative, membership, mode, or captain changes, or you reset it. Assigning a manual score fills only unrolled members with that score; existing rolls stay intact. SCI reordering preserves the active combatant and rebuilds turn order on every client.

Manual group rolls use dnd5e actor-aware initiative, so bonuses, fixed initiative, advantage/disadvantage settings, and system roll configuration still apply.

| Input | Group roll |
| --- | --- |
| Click | Normal |
| Alt + Click | Advantage |
| Ctrl/Cmd + Click | Disadvantage |

Click the squad initiative score to edit it, or focus it and press Enter/Space. Inline editing accepts locale-safe values. Group-aware **Roll All** and **Roll NPCs** retain native rolling behavior.

#### Captains

**Put a leader inside the group.**

A captain can be chosen during group creation, set from the edit dialog, toggled from a combatant row, or changed through a context menu. Captain initiative mode uses that combatant's roll as the group initiative.

If morale is enabled, a captain dropping to 0 HP or becoming defeated can trigger a captain-death morale check. Deleted or removed captains are cleared from the group so captain-mode initiative can recover cleanly.

</details>

<a id="group-header-controls"></a>

<details>
<summary><strong>Tracker controls, visibility, and display settings</strong></summary>

**Run the squad from its expanded card.**

Cards show the squad icon/color, name, prominent initiative, captain, member count, and morale summary when enabled. The mode sits beside the member count to save a row. Compact spacing retains labeled actions, and collapse hides members while retaining the summary and actions.

| Control | Action |
| --- | --- |
| Pin | Keep a group expanded during auto-collapse. |
| More: Reset | Clear member initiatives and the squad score. |
| Roll | Roll group initiative. |
| Skip | Advance outside the active squad, honoring defeated skipping, round rollover, turn hooks, and world time. No eligible outside member leaves combat unchanged. |
| Select | Select all group tokens on the canvas. |
| Visibility | Hide or reveal the group. |
| Morale | Roll morale for the group, when morale is enabled. |
| Rally | Reroll morale for broken members, when morale is enabled. |
| More: Clear Morale | Clear this squad's morale flags and effects. |
| More: Delete | Delete the squad and clear its morale without deleting combatants. |

Visible secondary controls provide pinning, token selection, visibility, and editing. The three-dot **More** menu occupies a fixed slot, so pinning does not wrap it onto another row. It closes when clicking or moving keyboard focus outside, pressing Escape, or choosing an action. Primary actions have labels; unavailable and pending actions cannot execute. Hover or focus an unavailable action to learn why, such as all members already having rolled or no living broken members to rally. Right-click also provides group actions.

In **Configure Settings → Squad Combat Initiative**, **GM Squad Card Detail** is saved independently for each GM or Assistant in the current world and applies to both sidebar and popout:

| Detail | Squad information shown |
| --- | --- |
| Full (default) | Name, initiative, member count, mode, captain, and morale summary when enabled. |
| Compact | Name, initiative, member count, and mode. |
| Minimal | Name and initiative. |

All levels retain the icon/color accent, hidden-squad indicator, controls, and individual member rows with their badges. Changing detail does not change another user's view or squad data. Display settings refresh open trackers without a reload.

GMs and Assistants can **click the squad title to rename it directly**. Press Enter or click away to save; Escape cancels. Names must contain text and may be up to 200 characters. Click the **squad icon** to choose a new image with Foundry's image picker. Both controls are keyboard accessible and available at every detail level. These edits change only the squad's appearance and keep their originating encounter when another tracker is selected.

Expansion state is saved per user and combat. Optional auto-collapse keeps the active squad visible and respects pinned squads. Hovering a squad can highlight its visible tokens.

#### Visibility

**Choose how tracker visibility and canvas visibility relate.**

| Mode | Behavior |
| --- | --- |
| Bidirectional | Tracker and canvas visibility stay in sync. |
| Tracker Only | Group visibility controls combat tracker visibility only. |
| None | Leaves Foundry and token visibility behavior independent. |

Hidden groups are hidden from players and shown muted to managers. Player cards summarize permitted members only, omit hidden captains and member details, and disappear for empty or all-hidden squads. Highlights respect token visibility.

With morale enabled, **Player Morale Visibility** controls SCI's tracker summaries and individual morale badges: **Visible Members** (default) shows information only for members that player can see; **GM Only** hides both from players. This is a display preference: chat messages and Foundry condition icons retain their own visibility. It does not hide underlying document data or change morale mechanics.

</details>

<a id="squad-morale"></a>

<details>
<summary><strong>Morale rules, outcomes, and cleanup</strong></summary>

**Make squads react to losses.**

The optional morale system tracks who holds and who breaks when a squad loses members or its captain falls.

**Living**, **Holding**, and **Broken** summaries exclude defeated members and members at 0 HP. Holding and Broken count living members with a recorded pass or failure; members who have not checked morale count only as Living.

For each living member:

```text
Roll: 1d20 + WIS modifier + floor(CR) + mob confidence
DC:   10 + casualty count
```

Casualties include defeated combatants, combatants at or below 0 HP, and deleted group members tracked by the module. Reassignment changes the roster rather than adding a casualty. HP loss, defeated status, and captain deletion share one deduplicated captain response.

| Discipline | Roll mode |
| --- | --- |
| Expendable | Disadvantage, `2d20kl` |
| Standard | Normal, `1d20` |
| Elite | Advantage, `2d20kh` |
| Fearless | Immune to morale checks |

Morale can be triggered manually, by casualty threshold, by captain death, or per-turn when an eligible combatant starts its turn. Combatants that already have morale status are skipped by auto-checks until morale is cleared or rallied.

#### Outcomes and cleanup

The failure effect is configurable:

| Setting | Effect |
| --- | --- |
| Frightened | Applies dnd5e's built-in `frightened` status. |
| Prone | Applies dnd5e's built-in `prone` status. |
| Fleeing | Applies a custom `Fleeing` ActiveEffect. |
| None | Records morale status without applying a status effect. |

Morale effects carry combat and combatant origins. Reassignment, ungrouping, combatant deletion, group deletion, and encounter deletion clear the departing source while preserving other SCI sources and unrelated effects. Linked tokens still share actor-level conditions. Legacy effects migrate only when their origin is unambiguous; ambiguous legacy effects remain unchanged for manual review. Fearless checks and rallies clear existing SCI failures.

Rally rerolls only living combatants currently marked as broken. A successful rally marks the combatant as holding and clears morale effects. A failed rally leaves the combatant broken and reapplies the configured failure effect.

Morale chat cards are GM-only and include DC, modifier, and result breakdowns.

</details>

---

<div align="center">

<a id="use-it-for"></a>

## Use It For

</div>

| Use case | What it looks like |
| --- | --- |
| **Large enemy waves** | Combine many similar creatures into readable squads. |
| **Military encounters** | Give units names, colors, captains, and morale. |
| **Boss support crews** | Make minions act together while still tracking their individual bodies. |
| **Stealth or reinforcements** | Hide a whole group from players until it joins the fight. |

<details>
<summary><strong>Recipe: guards with a captain</strong></summary>

1. Select the guard tokens.
2. Click **Add Group**.
3. Name the group "North Gate Patrol".
4. Assign the sergeant as captain.
5. Set initiative mode to **Captain**.
6. Enable morale and use **Captain Death** or **Both** as the trigger.

The guards roll together in the tracker, but the sergeant's fate matters.

</details>

<details>
<summary><strong>Recipe: fast auto-grouping</strong></summary>

| Encounter shape | Good option |
| --- | --- |
| Many identical actors | Auto-group by actor. |
| Mixed hostile and neutral groups | Auto-group by disposition. |
| Hand-built squads | Create empty groups and drag combatants into them. |

</details>

---

<div align="center">

<a id="installation"></a>

## Installation

</div>

1. Foundry -> **Add-on Modules** -> **Install Module**.
2. Search "Squad Combat Initiative", or paste this manifest URL:

   ```text
   https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest/download/module.json
   ```

3. Enable **libWrapper** and **Squad Combat Initiative** in your world.

| Requirement | Version |
| --- | --- |
| Foundry VTT | v14 only; verified on 14.367 |
| [D&D 5e System](https://github.com/foundryvtt/dnd5e) | 5.3.3 minimum; verified on 5.3.3 |
| [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) | Required; tested with 1.13.5.1 |

<details>
<summary><strong>Upgrading to 14.2.0</strong></summary>

**SCI now provides the grouping interface while enabled.** Foundry and dnd5e's native grouping controls are disabled. Existing native group documents and saved membership are preserved; native-only members appear **Ungrouped** until you explicitly assign them to SCI squads. No automatic conversion occurs. Disabling SCI and reloading restores native grouping.

After updating, reload every connected client.

</details>

---

<div align="center">

<a id="compatibility"></a>

## Compatibility

</div>

**Foundry VTT:** v14 only; verified on **14.367**. Foundry V13 worlds should stay on the final 13.x module release.

**Game system:** **dnd5e** 5.3.3 minimum; verified on **5.3.3**. Later dnd5e releases haven't been verified yet.

**Required modules:** **libWrapper**, for group ordering and group-aware **Roll All** and **Roll NPCs**. Keep it enabled.

---

<div align="center">

<a id="developer-api"></a>

## Developer API

</div>

Access:

```javascript
const api = game.modules.get("squad-combat-initiative").api;
```

Other modules can wait for readiness:

```javascript
Hooks.on("squad-combat-initiative.apiReady", (api) => {
  // API is ready.
});
```

#### Group management

```javascript
api.createGroup(combat, data, tokens)
api.autoGroupCombatants(combat, options)
api.deleteGroup(combat, groupId, options)
api.editGroup(combat, groupId, data)
api.getGroups(combatants, combat)
api.addCombatantsToGroup(combat, groupId, combatantIds)
api.removeCombatantFromGroup(combat, combatantId)
api.getGroupPresets()
api.saveGroupPreset(name, data)
api.updateGroupPreset(presetId, data)
api.deleteGroupPreset(presetId)
```


#### Initiative, captain, and visibility

```javascript
api.rollGroupInitiative(combat, groupId, options)
api.skipGroupTurn(combat, groupId)
api.setGroupInitiative(combat, groupId, value)
api.resetGroupInitiative(combat, groupId)
api.finalizeGroupInitiative(combat, groupId, options)
api.setCaptain(combat, groupId, combatantId)
api.removeCaptain(combat, groupId)
api.toggleGroupVisibility(combat, groupId)
```


#### Morale

```javascript
api.rollMorale(combat, groupId)
api.rollMoraleSingle(combat, groupId, combatantId)
api.rallyMorale(combat, groupId, combatantId)
api.clearMorale(combat, groupId, combatantId)
api.clearMoraleEffect(combatant)
api.checkAutoMorale(combat, combatant)
api.getLivingMembers(combat, groupId)
api.getDeadMembers(combat, groupId)
api.getCasualtyCount(combat, groupId)
```


#### Utilities and constants

```javascript
api.generateGroupId()
api.isGM()
api.canManageGroups()
api.calculateAverageInitiative(values)
api.calculateGroupInitiative(values, mode, captainValue)
api.clearAllTokenHighlights()
api.expandStore

api.MODULE_ID
api.UNGROUPED
api.CONSTANTS
api.INITIATIVE_MODE
api.MORALE_TRIGGER
api.DISCIPLINE
api.VISIBILITY_SYNC_MODE
api.HIGHLIGHT_VISIBILITY
api.DEBUG_LEVELS
```


Mutation methods return promises and run on the active GM; await them before reading changed documents. Preset creation/update returns a preset ID, deletion returns a boolean, and `skipGroupTurn` returns whether it advanced. `getGroups` returns a Map. Morale group/rally results contain `passed` and `failed` arrays; single checks return an entry. Fearless outcomes instead return `{skipped: true, reason: "Fearless"}` (rally also includes `rallied`). Empty/inapplicable morale requests can return null. Existing API argument order and names remain supported.

<a id="example-macros"></a>

<details>
<summary><strong>Example macros</strong></summary>

**Auto-group hostile combatants by disposition.**

```javascript
const api = game.modules.get("squad-combat-initiative").api;
const combat = game.combat;
if (!combat) return ui.notifications.warn("No active combat.");

const hostileCombatants = combat.combatants.filter(
  (combatant) => combatant.token?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE
);

await api.autoGroupCombatants(combat, {
  combatants: hostileCombatants,
  groupBy: "disposition",
  includeGrouped: false,
});
```

**Rally a group by name.**

```javascript
const api = game.modules.get("squad-combat-initiative").api;
const combat = game.combat;
if (!combat) return ui.notifications.warn("No active combat.");

const targetName = "Goblin Squad";
for (const [groupId, group] of api.getGroups(combat.combatants, combat)) {
  if (group.name !== targetName) continue;
  const result = await api.rallyMorale(combat, groupId);
  if (result?.skipped) ui.notifications.info(`Fearless: ${result.rallied ?? 0} cleared.`);
  else if (result) ui.notifications.info(`${result.passed.length} rallied, ${result.failed.length} still broken.`);
  break;
}
```

**Roll initiative for all groups.**

```javascript
const api = game.modules.get("squad-combat-initiative").api;
const combat = game.combat;
if (!combat) return ui.notifications.warn("No active combat.");

for (const [groupId] of api.getGroups(combat.combatants, combat)) {
  if (groupId === api.UNGROUPED) continue;
  await api.rollGroupInitiative(combat, groupId);
}
```

</details>

---

<div align="center">

<a id="bakshis-bazaar"></a>

## Bakshi's Bazaar

*Squad Combat Initiative is free. My premium modules are released as **Bakshi's Bazaar** for [Bazaar Patrons](https://www.patreon.com/cw/GnollStack) and install through Foundry's Premium Content.*

</div>

| Module | What it adds |
| --- | --- |
| **[5e Activity Importer](https://foundryvtt.com/packages/5e-activity-importer)** | Adds activities and Active Effects to dnd5e Items from YAML, or imports complete Items together with 5e Item Importer. |
| **[Custom Currency 5e](https://foundryvtt.com/packages/custom-currency-5e)** | Custom coins, exchange rates, regional markets, and physical coin items on native dnd5e sheets. |
| **[FileSmith](https://foundryvtt.com/packages/filesmith)** | Folder colors, multi-select, clipboard actions, and move undo for Foundry's sidebar. |
| **[Immersive Vision FX](https://foundryvtt.com/packages/immersive-vision-fx)** | Soft vision and light edges, creature vision profiles, cave light, and eyeshine. |
| **[Traffick](https://foundryvtt.com/packages/traffick)** | Party trading, merchant catalogs, perceived prices, and appraisal checks for dnd5e. |

A Bazaar Patron membership includes:

- Every Bakshi's Bazaar premium module while your membership is active, including ongoing updates and new modules as they're added.
- Patron-only channels in the [Bakshi's Bazaar Discord](https://discord.gg/tcdYk54fxC).
- Priority module support.
- A direct place to share feedback and feature suggestions. Suggestions are welcome and taken seriously, but development priorities remain at my discretion.

Everyone is welcome in the [Bakshi's Bazaar Discord](https://discord.gg/tcdYk54fxC): the public channels cover release announcements, questions, and feature ideas, and patrons also get the patron-only channels and priority support. Bug reports for Squad Combat Initiative still go to [GitHub issues](https://github.com/GnollStack/Squad-Combat-Initiative/issues), as described under Community.

---

<div align="center">

<a id="community"></a>

## Community

</div>

- **Report bugs** — [open an issue](https://github.com/GnollStack/Squad-Combat-Initiative/issues) with your Foundry version, dnd5e system version, module version, steps to reproduce, console logs, and screenshots or short clips when useful.
- **Ask on Discord** — anyone can ask questions in the public channels of the [Bakshi's Bazaar Discord](https://discord.gg/tcdYk54fxC). Bazaar Patrons get priority support in the patron-only channels.
- **Request features** — tell me what happened at your table and what you wish the module could do.
- **Star the repo** — if the module is useful at your table, a star helps other GMs find it.
- **Watch releases** — follow the repo for updates, compatibility notes, and new feature releases.

---

<div align="center">

<a id="contributing"></a>

## Contributing

</div>

Bug reports, feature ideas, reproduction notes, documentation fixes, and localization ideas are welcome.

I am not generally accepting unsolicited code PRs for features, refactors, architecture, or behavior changes. This is still my module and my codebase; I will decide how features are designed and implemented unless I explicitly say otherwise.

- **Bug reports** — include Foundry version, dnd5e system version, module version, a console log, and the steps to reproduce. Screenshots or short clips help a lot.
- **Feature requests** — tell me what happened at your table and what you wish the module could do.
- **Pull requests** — please do not open code PRs unless I ask for one. Open an issue with the idea instead.
- **Code ownership** — core implementation, architecture, and release decisions remain with me unless stated otherwise.
- **Translations and docs** — typo fixes, wording suggestions, and localization ideas are welcome by issue first. I do not have a public translation setup yet, so I will fold useful wording in myself.

I may adapt, decline, or implement submitted ideas. Any accepted contribution or submitted project material may be released under the same EULA as the rest of the module.

---

<div align="center">

<a id="ai-assisted-development"></a>

## AI-Assisted Development

</div>

This module is developed and maintained with the help of AI-assisted tools for coding, debugging, and testing.

I care about the quality, behavior, performance, security, and long-term maintainability of this module, and I take full responsibility for what ships. AI assistance does not replace review, testing, debugging, or security and design judgment.

AI is used here as a tool under my direction to make Foundry better and allow for long term module support while still having a life outside of building and maintaining my free and premium modules.

If you are uncomfortable using software developed with AI-assisted tools, this module is not for you.

---

<div align="center">

<a id="support-development"></a>

## 🥩 Support Development

This module represents **many hours** of development.

**If this module enhanced your immersion, consider treating me to a steak, much better than coffee!**

<a href='https://ko-fi.com/gnollstack' target='_blank'>
<img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi3.png?v=3' border='0' alt='Buy Me a Steak at ko-fi.com' />
</a>

> *"Thanks for the support! It helps me maintain support for the module and puts a nice steak on the table."*

</div>

---

<div align="center">

<a id="license-permissions"></a>

## ⚖️ License & Permissions

</div>

### Proprietary EULA

This module is licensed under the **GnollStack Proprietary EULA**.
It is a **source-available proprietary EULA**: the source is visible for review and personal table use, but redistribution and commercial use remain restricted by the license.
It is **Free for Personal Use**, meaning you can use it in your home games, stream it, or modify it for your own table without restriction.

However, **Commercial Redistribution is Strictly Prohibited.**
You may **NOT** sell this module, bundle it within paid content (such as Patreon maps or adventures), or host it as a commercial service without prior written consent.

### Commercial Licensing

I am open to partnerships! If you are a map maker, adventure writer, or developer who wishes to use this module commercially, please contact me. I offer commercial licenses for:

* Bundling this module with paid VTT content.
* Official integration into commercial systems.
* Custom feature development for your specific product.

### Contact

For licensing inquiries or permission slips:

* **Discord:** `GnollStack` (Preferred)
* **Email:** `Somedudeed@gmail.com`
* *Please do not open GitHub Issues for commercial licensing discussions. But feel free to contact me via Discord or Email*

---

<div align="center">

**Author:** [GnollStack](https://github.com/GnollStack)

[Back to Top](#squad-combat-initiative)

</div>
