<div align="center">

# Squad Combat Initiative

**Run big D&D 5e fights as readable squads without losing individual combatants.**

[![Latest Release](https://img.shields.io/github/v/release/GnollStack/Squad-Combat-Initiative?label=Latest%20Release&style=flat-square)](https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/GnollStack/Squad-Combat-Initiative/total?style=flat-square&color=green)](https://github.com/GnollStack/Squad-Combat-Initiative/releases)
[![Downloads@latest](https://img.shields.io/github/downloads/GnollStack/Squad-Combat-Initiative/latest/total?style=flat-square)](https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest)
[![Foundry VTT](https://img.shields.io/badge/Foundry-v13-orange?style=flat-square)](https://foundryvtt.com)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20a%20Steak-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/gnollstack)

*For GMs who want large combats to move fast and still feel tactical.*

[Features](#what-you-get) - [Quick Start](#quick-start) - [Preview](#preview) - [Installation](#installation) - [Use It For](#use-it-for) - [Compatibility](#compatibility) - [API](#developer-api) - [Community](#community) - [Contributing](#contributing) - [AI Use](#ai-assisted-development) - [Support](#support-development) - [License](#license-permissions)

</div>

---

## Feature Index

| Feature | Why it matters |
| --- | --- |
| **[Combat Groups](#combat-groups)** | Turn scattered enemies into named squads with shared controls. |
| **[Group Initiative](#group-initiative)** | Roll members individually, then keep the squad together in the tracker. |
| **[Captains](#captain-system)** | Let a designated leader drive initiative and morale tension. |
| **[Visibility Tools](#visibility-sync)** | Hide, reveal, select, and track squads from one row. |
| **[Squad Morale](#squad-morale)** | Give groups a reason to break, rally, or hold when casualties mount. |
| **[MCP Diagnostics](#mcp-diagnostics)** | Validate live Foundry state and run safe active-scene fixture tests. |

> Foundry's combat tracker is excellent for normal encounters. This module is for the messy ones: guards in squads, minions in waves, captains rallying frightened troops, and a GM who does not want twenty separate rows stealing the table's whole evening.

---

<a id="quick-start"></a>

## Quick Start

1. Install and enable **Squad Combat Initiative** in your world.
2. Start a D&D 5e combat with several combatants.
3. Use **Add Group** to create a group from selected canvas tokens, or create an empty group.
4. Use **Auto Group** to group selected or all combatants by actor or disposition.
5. Roll a group from its header. Members roll individually, and the group receives a calculated initiative.

Groups can be renamed, recolored, hidden, pinned, assigned captains, given morale settings, and edited directly from the combat tracker.

---

<a id="preview"></a>

## Preview

<img width="366" height="567" alt="Squad Combat Initiative settings and controls" src="https://github.com/user-attachments/assets/ad0fefec-4509-4718-9452-bcb8dc05c7b7" />

---

<a id="what-you-get"></a>

## What You Get

### Combat Groups
**Create readable squad headers in the combat tracker.**

Create custom groups from selected tokens, build empty groups for drag/drop setup, or auto-group combatants by actor or token disposition. Existing groups are skipped unless you choose to regroup them.

| Method | What it does |
| --- | --- |
| Add Group | Creates a custom group from selected canvas tokens or an empty group. |
| Auto Group | Groups selected or all combatants by actor or disposition. |
| Drag and Drop | Moves combatants between groups or out to the ungrouped area. |

Group metadata includes name, color, icon, hidden state, pinning, initiative mode, discipline, morale trigger, and captain assignment.

---

### Group Initiative
**Keep individual rolls while sorting the squad as a unit.**

Each grouped combatant still rolls normally. The group initiative is calculated from member results using the selected mode.

| Mode | Calculation |
| --- | --- |
| Average | Rounded mean of member initiatives. |
| Highest | Best member initiative. |
| Lowest | Worst member initiative. |
| Median | Middle member initiative. |
| Captain | Uses the captain's initiative, with a safe fallback if needed. |

Manual group rolls use dnd5e actor-aware initiative, so bonuses, fixed initiative, advantage/disadvantage settings, and system roll configuration still apply.

| Input | Group roll |
| --- | --- |
| Click | Normal |
| Alt + Click | Advantage |
| Ctrl/Cmd + Click | Disadvantage |

---

### Captain System
**Put a leader inside the group.**

A captain can be chosen during group creation, set from the edit dialog, toggled from a combatant row, or changed through a context menu. Captain initiative mode uses that combatant's roll as the group initiative.

If morale is enabled, a captain dropping to 0 HP or becoming defeated can trigger a captain-death morale check. Deleted or removed captains are cleared from the group so captain-mode initiative can recover cleanly.

---

### Group Header Controls
**Run the squad from one compact row.**

| Control | Action |
| --- | --- |
| Pin | Keep a group expanded during auto-collapse. |
| Reset | Clear member initiatives. |
| Roll | Roll group initiative. |
| Skip | Advance to the next combatant outside the active group. |
| Select | Select all group tokens on the canvas. |
| Visibility | Hide or reveal the group. |
| Morale | Roll morale for the group, when morale is enabled. |
| Rally | Reroll morale for broken members, when morale is enabled. |
| Clear Morale | Clear morale flags and module-managed morale effects. |
| Delete | Delete the group without deleting combatants. |

Right-clicking a group header opens actions for editing, renaming, setting initiative, and deleting the group.

---

### Visibility Sync
**Choose how tracker visibility and canvas visibility relate.**

| Mode | Behavior |
| --- | --- |
| Bidirectional | Tracker and canvas visibility stay in sync. |
| Tracker Only | Group visibility controls combat tracker visibility only. |
| None | Leaves Foundry and token visibility behavior independent. |

Hidden groups are hidden from players and shown muted to managers.

---

### Squad Morale
**Make squads react to losses.**

The optional morale system tracks who holds and who breaks when a squad loses members or its captain falls.

For each living member:

```text
Roll: 1d20 + WIS modifier + floor(CR) + mob confidence
DC:   10 + casualty count
```

Casualties include defeated combatants, combatants at or below 0 HP, and deleted group members tracked by the module.

| Discipline | Roll mode |
| --- | --- |
| Expendable | Disadvantage, `2d20kl` |
| Standard | Normal, `1d20` |
| Elite | Advantage, `2d20kh` |
| Fearless | Immune to morale checks |

Morale can be triggered manually, by casualty threshold, by captain death, or per-turn when an eligible combatant starts its turn. Combatants that already have morale status are skipped by auto-checks until morale is cleared or rallied.

<details>
<summary><strong>Morale outcomes</strong></summary>

The failure effect is configurable:

| Setting | Effect |
| --- | --- |
| Frightened | Applies dnd5e's built-in `frightened` status. |
| Prone | Applies dnd5e's built-in `prone` status. |
| Fleeing | Applies a custom `Fleeing` ActiveEffect. |
| None | Records morale status without applying a status effect. |

Rally rerolls only living combatants currently marked as broken. A successful rally marks the combatant as holding and clears morale effects. A failed rally leaves the combatant broken and reapplies the configured failure effect.

</details>

---

### Quality Of Life
**Small tools that keep the tracker moving.**

- Collapsible group headers with per-user expanded state.
- Optional auto-collapse that keeps the active group visible.
- Token highlighting when hovering a group header.
- Inline group initiative editing with double-click.
- Active-group skip control for jumping past the rest of the current group.
- Group-aware `Roll All` and `Roll NPCs` support through libWrapper.
- GM-only morale chat cards with DC, modifier, and result breakdowns.

<details>
<a id="mcp-diagnostics"></a>
<summary><strong>MCP Diagnostics</strong></summary>

MCP diagnostics are available to GMs when the Foundry MCP Bridge developer-tools setting is enabled:

```javascript
call-module-debug-action({
  moduleId: "squad-combat-initiative",
  action: "getStatus",
  args: {}
})
```

Read-only actions are allowlisted under `game.modules.get("squad-combat-initiative").api.diagnostics.actions`: `getStatus`, `validateSettings`, `validateData`, `validateAssets`, `runSmokeTests`, and `collectClientDiagnostics`.

Dedicated test worlds can also enable **Allow Mutating MCP Diagnostics**. Mutating actions require that setting plus `confirmMutation: true`. The allowlisted mutating actions are `runAutomation` and `cleanupFixtures`. Fixture cleanup only touches active-scene documents with both the `SCI-MCP-FIXTURE` prefix and the module `diagnosticsFixture` marker. `runAutomation` creates temporary fixture actors, tokens, combatants, combat, groups, and chat messages in the current active scene, exercises group, captain, initiative, visibility, morale, and cleanup workflows, restores touched settings and active combat, then deletes its fixtures by default.

Live multi-client assertions are reported as inconclusive or failed based on actual connected clients. A missing non-GM client is an environment issue, not automatically a module bug.

> [!WARNING]
> Leave **Allow Mutating MCP Diagnostics** disabled outside active testing. The automation is fixture-safe, but it still creates temporary world documents while it runs.

</details>

---

<a id="installation"></a>

## Installation

1. Foundry -> **Add-on Modules** -> **Install Module**.
2. Search "Squad Combat Initiative", or paste this manifest URL:

```text
https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest/download/module.json
```

3. Enable the module in your world.

| Requirement | Version |
| --- | --- |
| Foundry VTT | v13+ (verified v13.351) |
| [D&D 5e System](https://github.com/foundryvtt/dnd5e) | 5.1.0+ (verified 5.2.4) |
| [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) | Latest |

---

<a id="use-it-for"></a>

## Use It For

| Use case | What it looks like |
| --- | --- |
| **Large enemy waves** | Combine many similar creatures into readable squads. |
| **Military encounters** | Give units names, colors, captains, and morale. |
| **Boss support crews** | Make minions act together while still tracking their individual bodies. |
| **Stealth or reinforcements** | Hide a whole group from players until it joins the fight. |

<details>
<summary><strong>Recipe - guards with a captain</strong></summary>

1. Select the guard tokens.
2. Click **Add Group**.
3. Name the group "North Gate Patrol".
4. Assign the sergeant as captain.
5. Set initiative mode to **Captain**.
6. Enable morale and use **Captain Death** or **Both** as the trigger.

The guards roll together in the tracker, but the sergeant's fate matters.

</details>

<details>
<summary><strong>Recipe - fast auto-grouping</strong></summary>

| Encounter shape | Good option |
| --- | --- |
| Many identical actors | Auto-group by actor. |
| Mixed hostile and neutral groups | Auto-group by disposition. |
| Hand-built squads | Create empty groups and drag combatants into them. |

</details>

---

<a id="compatibility"></a>

## Compatibility

> [!TIP]
> Squad Combat Initiative is designed for Foundry VTT v13 and dnd5e 5.x. It patches the combat tracker UI and wraps dnd5e initiative rolling through libWrapper, so keep libWrapper enabled for full group-aware `Roll All` and `Roll NPCs` behavior.

<details>
<summary><strong>dnd5e initiative behavior</strong></summary>

Group initiative rolls call dnd5e actor-aware initiative where available. This preserves actor bonuses, fixed initiative, advantage/disadvantage settings, and system roll options better than hand-built formulas.

</details>

<details>
<summary><strong>Combat tracker UI notes for other module authors</strong></summary>

This module adds custom `.sci-combatant-group[data-group-key]` rows and keeps them separate from Foundry's core combatant rows. Group state is stored on Combat and Combatant flags, while expanded/collapsed state is local to each browser through `localStorage`.

</details>

<details>
<summary><strong>Visibility and permissions</strong></summary>

GMs and assistant-level users can manage groups. Player clients see allowed rendered state but should not write group, morale, visibility, or initiative flags.

</details>

---

<a id="developer-api"></a>

## Developer API

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

<details>
<summary><strong>Group management</strong></summary>

```javascript
api.createGroup(combat, data, tokens)
api.autoGroupCombatants(combat, options)
api.deleteGroup(combat, groupId, options)
api.editGroup(combat, groupId, data)
api.getGroups(combatants, combat)
api.addCombatantsToGroup(combat, groupId, combatantIds)
api.removeCombatantFromGroup(combat, combatantId)
```

</details>

<details>
<summary><strong>Initiative, captain, and visibility</strong></summary>

```javascript
api.rollGroupInitiative(combat, groupId, options)
api.setGroupInitiative(combat, groupId, value)
api.resetGroupInitiative(combat, groupId)
api.finalizeGroupInitiative(combat, groupId, options)
api.setCaptain(combat, groupId, combatantId)
api.removeCaptain(combat, groupId)
api.toggleGroupVisibility(combat, groupId)
```

</details>

<details>
<summary><strong>Morale</strong></summary>

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

</details>

<details>
<summary><strong>Diagnostics, utilities, and constants</strong></summary>

```javascript
api.diagnostics
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

</details>

### Example macros

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
  if (result) ui.notifications.info(`${result.passed.length} rallied, ${result.failed.length} still broken.`);
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

---

<a id="community"></a>

## Community

- **Report bugs** — [open an issue](https://github.com/GnollStack/Squad-Combat-Initiative/issues) with your Foundry version, module version, steps to reproduce, console logs, and screenshots or short clips when useful.
- **Request features** — tell me what happened at your table and what you wish the module could do.
- **Star the repo** — if the module is useful at your table, a star helps other GMs find it.
- **Watch releases** — follow the repo for updates, compatibility notes, and new feature releases.

---

<a id="contributing"></a>

## Contributing

Bug reports, feature ideas, reproduction notes, documentation fixes, and localization ideas are welcome.

I am not generally accepting unsolicited code PRs for features, refactors, architecture, or behavior changes. This is still my module and my codebase; I will decide how features are designed and implemented unless I explicitly say otherwise.

- **Bug reports** — include Foundry version, module version, a console log, and the steps to reproduce. Screenshots or short clips help a lot.
- **Feature requests** — tell me what happened at your table and what you wish the module could do.
- **Pull requests** — please do not open code PRs unless I ask for one. Open an issue with the idea instead.
- **Code ownership** — core implementation, architecture, and release decisions remain with GnollStack unless stated otherwise.
- **Translations and docs** — typo fixes, wording suggestions, and localization ideas are welcome by issue first. I do not have a public translation setup yet, so I will fold useful wording in myself.

Submitted ideas may be adapted, declined, or implemented by GnollStack. Any accepted contribution or submitted project material may be released under the same EULA as the rest of the module.

---

<a id="ai-assisted-development"></a>

## AI-Assisted Development

This module is developed and maintained with the help of AI-assisted tools for coding, debugging, documentation, and testing.

I care about the quality, behavior, performance, security, and long-term maintainability of this module, and I take full responsibility for what ships. AI assistance does not replace review, testing, debugging, or security and design judgment.

AI is used here as a tool under my direction to make Foundry better and allow for long term module support while still having a life outside of building and maintaining my free and premium modules.

If you are uncomfortable using software developed with AI-assisted tools, this module is not for you.

---

<a id="support-development"></a>

## 🥩 Support Development

This module represents **many hours** of development.

**If this module enhanced your immersion, consider treating me to a steak, much better than coffee!**

<a href='https://ko-fi.com/gnollstack' target='_blank'>
<img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi3.png?v=3' border='0' alt='Buy Me a Steak at ko-fi.com' />
</a>

> *"Thanks for the support! It helps me maintain support for the module and puts a nice steak on the table."*

---

<a id="license-permissions"></a>

## ⚖️ License & Permissions

### Proprietary EULA
This module is licensed under the **GnollStack Proprietary EULA**.
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

**Author:** [GnollStack](https://github.com/GnollStack) - **Compatibility:** Foundry VTT v13+ (verified v13.351), dnd5e 5.1+

[Back to Top](#squad-combat-initiative)

</div>
