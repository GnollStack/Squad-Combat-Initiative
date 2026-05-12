# Squad Combat Initiative

A Foundry VTT v13 module for running D&D 5e combats with visual squads, shared initiative, captain-led groups, auto-grouping, visibility tools, and optional squad morale.

[![Release](https://img.shields.io/github/v/release/GnollStack/Squad-Combat-Initiative?label=Latest%20Release&style=flat-square)](https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/GnollStack/Squad-Combat-Initiative/total?style=flat-square&color=blue)](https://github.com/GnollStack/Squad-Combat-Initiative/releases)
[![Foundry VTT](https://img.shields.io/badge/Foundry-v13-orange?style=flat-square)](https://foundryvtt.com)
[![D&D 5e](https://img.shields.io/badge/D%26D%205e-5.1%2B-red?style=flat-square)](https://github.com/foundryvtt/dnd5e)

## Why Use It?

Large combats are easier when enemies can act as squads without losing individual rolls. Squad Combat Initiative lets you group combatants, roll each member normally, then place the whole squad together in the combat tracker.

## Features

### Group Creation

Create groups from the combat tracker:

| Method | What It Does |
| --- | --- |
| Add Group | Creates a custom group from selected canvas tokens or an empty group for drag/drop setup. |
| Auto Group | Groups selected or all combatants by actor or token disposition. Existing groups are skipped unless you choose to regroup them. |
| Drag and Drop | Move combatants between groups, or drop outside a group to ungroup them. |

Groups support custom names, colors, icons, hidden state, pinning, initiative mode, discipline, morale trigger, and captain assignment.

### Initiative Modes

Each grouped combatant still rolls individually. The group initiative is then calculated from one of these modes:

| Mode | Calculation |
| --- | --- |
| Average | Rounded mean of member initiatives. |
| Highest | Best member initiative. |
| Lowest | Worst member initiative. |
| Median | Middle member initiative. |
| Captain | Uses the designated captain's initiative. Falls back safely if no valid captain roll exists. |

Manual group rolls use dnd5e actor-aware initiative, so bonuses, advantage/disadvantage settings, fixed initiative, and system roll configuration still apply.

| Input | Group Roll |
| --- | --- |
| Click | Normal |
| Alt + Click | Advantage |
| Ctrl/Cmd + Click | Disadvantage |

### Captain System

A captain is a designated group leader. Captains can be chosen during group creation, changed in the Edit Group dialog, set from a combatant context menu, or toggled directly from grouped combatant rows.

Captain mode uses the captain's roll as the group's initiative. If morale is enabled, a captain dropping to 0 HP or becoming defeated can trigger a captain-death morale check. Deleted or removed captains are cleared from the group so captain-mode initiative can recover.

### Group Header Controls

| Control | Action |
| --- | --- |
| Pin | Keep a group expanded during auto-collapse. |
| Reset | Clear member initiatives. |
| Roll | Roll group initiative. |
| Skip | Advance the turn to the next combatant outside the active group. It appears beside the group initiative when that group is active. |
| Select | Select all group tokens on the canvas. |
| Visibility | Hide or reveal the group. |
| Morale | Roll morale for the group, when morale is enabled. |
| Rally | Reroll morale for currently broken members, when morale is enabled. |
| Clear Morale | Clear morale flags and module-managed morale effects. |
| Delete | Delete the group without deleting combatants. |

Right-clicking a group header opens actions for editing, renaming, setting initiative, and deleting the group.

### Visibility Sync

The visibility setting controls how combat tracker hiding and canvas token hiding interact:

| Mode | Behavior |
| --- | --- |
| Bidirectional | Tracker and canvas visibility stay in sync. |
| Tracker Only | Group visibility controls combat tracker visibility only. |
| None | Leaves Foundry/token visibility behavior independent. |

### Squad Morale

The optional morale system tracks who holds and who breaks when a squad loses members or its captain falls.

For each living member:

```text
Roll: 1d20 + WIS modifier + floor(CR) + mob confidence
DC:   10 + casualty count
```

Casualties include defeated combatants, combatants at or below 0 HP, and deleted group members tracked by the module.

| Discipline | Roll Mode |
| --- | --- |
| Expendable | Disadvantage, `2d20kl` |
| Standard | Normal, `1d20` |
| Elite | Advantage, `2d20kh` |
| Fearless | Immune to morale checks |

Morale can be triggered manually, by casualty threshold, by captain death, or per-turn when an eligible combatant starts its turn. Combatants that already have morale status are skipped by auto-checks until morale is cleared or rallied.

### Morale Outcomes

The failure effect is configurable:

| Setting | Effect |
| --- | --- |
| Frightened | Applies dnd5e's built-in `frightened` status. |
| Prone | Applies dnd5e's built-in `prone` status. |
| Fleeing | Applies a custom `Fleeing` ActiveEffect. |
| None | Records morale status without applying a status effect. |

Rally rerolls only living combatants currently marked as broken. A successful rally marks the combatant as holding and clears morale effects. A failed rally leaves the combatant broken and reapplies the configured failure effect.

### Quality Of Life

- Collapsible group headers with per-user persisted expanded state.
- Optional auto-collapse that keeps the active group visible.
- Token highlighting when hovering a group header.
- Inline group initiative editing with double-click.
- Active-group skip control for jumping past the remaining members of the current group.
- Group-aware `Roll All` and `Roll NPCs` support through libWrapper.
- GM-only morale chat cards with DC, modifier, and result breakdowns.

## Installation

### Requirements

| Dependency | Version |
|------------|---------|
| [Foundry VTT](https://foundryvtt.com) | v13+ |
| [D&D 5e System](https://github.com/foundryvtt/dnd5e) | 5.2.5+ |
| [lib-wrapper](https://github.com/ruipin/fvtt-lib-wrapper) | Latest |

### Install Via Foundry

1. Open Foundry VTT and go to Add-on Modules.
2. Click Install Module.
3. Search for Squad Combat Initiative, or paste this manifest URL:

##  Documentation

### Module Settings

Access via **Configure Settings → Module Settings → Squad Combat Initiative**

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| Auto Collapse Groups | On/Off | On | Automatically collapse inactive groups when turn changes |
| Pin New Groups by Default | On/Off | On | Newly created groups start pinned (stay expanded during auto-collapse) |
| Visibility Sync Mode | Bidirectional / Tracker Only / None | Bidirectional | Controls how hiding tokens syncs between the canvas and combat tracker |
| Group Token Highlight | Off / GM Only / Everyone | GM Only | Who sees token highlights when hovering group headers |
| Debug Logging Level | Off / Normal / Verbose | Off | Console logging verbosity for troubleshooting |

#### Morale System Settings

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| Enable Morale System | On/Off | Off | Master toggle for all morale features. When off, morale buttons and auto-prompts are hidden. |
| Auto-Prompt Threshold | 0-100% | 50% | When living members drop to this % of starting size, the GM is prompted. Set to 0 to disable. |
| Failure Status Effect | Frightened / Fleeing | Frightened | Which status effect to apply when a creature fails its morale check. |
| Mob Confidence Divisor | 1-10 | 3 | +1 morale bonus per this many living members. Can be overridden per group. |
| Effect Duration (rounds) | 0-100 | 0 | How many rounds the effect lasts. 0 = permanent (must be removed manually). |

<img width="366" height="567" alt="image" src="https://github.com/user-attachments/assets/ad0fefec-4509-4718-9452-bcb8dc05c7b7" />

---

### How Initiative Math Works

When a group rolls initiative:

```
Group Average = round(sum of all member initiatives / member count)
```

4. Enable the module in your world.

## Settings

Access settings through Configure Settings > Module Settings > Squad Combat Initiative.

| Setting | Default | Description |
| --- | --- | --- |
| Auto Collapse Groups | On | Automatically collapse inactive groups when the turn changes. |
| Pin New Groups by Default | On | Newly created groups start pinned. |
| Default Initiative Mode | Average | Initiative mode for newly created groups. |
| Visibility Sync Mode | Bidirectional | Controls tracker/canvas visibility sync. |
| Group Token Highlight | GM Only | Controls who sees token highlights when hovering group headers. |
| Debug Logging Level | Off | Console logging verbosity. |
| Enable Morale System | Off | Shows morale controls and enables morale automation. |
| Morale Auto-Prompt Threshold | 50% | Prompts when living members drop to this percent of starting size. |
| Morale Failure Status Effect | Frightened | Status/effect applied after a failed morale check. |
| Mob Confidence Divisor | 3 | Grants +1 morale bonus per this many living members. |
| Morale Effect Duration | 0 | Effect duration in rounds; 0 means permanent until cleared. |

## API

Access the API with:

```javascript
const api = game.modules.get("squad-combat-initiative").api;
```

Other modules can wait for:

```javascript
Hooks.on("squad-combat-initiative.apiReady", (api) => {
  // API is ready.
});
```

### Group Management

| Method | Description |
| --- | --- |
| `api.createGroup(combat, data, tokens?)` | Create a group from data and optional tokens. |
| `api.autoGroupCombatants(combat, options?)` | Auto-group combatants by actor or disposition. |
| `api.deleteGroup(combat, groupId, options?)` | Delete a group and keep its combatants. |
| `api.editGroup(combat, groupId, data)` | Update group metadata. |
| `api.getGroups(combatants, combat)` | Return grouped combatants as a `Map`. |
| `api.addCombatantsToGroup(combat, groupId, combatantIds)` | Assign combatants to a group. |
| `api.removeCombatantFromGroup(combat, combatantId)` | Move a combatant back to ungrouped. |

### Initiative And Captain

| Method | Description |
| --- | --- |
| `api.rollGroupInitiative(combat, groupId, options?)` | Roll initiative for unrolled group members. |
| `api.setGroupInitiative(combat, groupId, value)` | Manually set group initiative. |
| `api.resetGroupInitiative(combat, groupId)` | Clear group member initiatives. |
| `api.finalizeGroupInitiative(combat, groupId, options?)` | Recalculate and sort group initiative. |
| `api.setCaptain(combat, groupId, combatantId)` | Set a group's captain. |
| `api.removeCaptain(combat, groupId)` | Remove a group's captain. |

### Morale

| Method | Description |
| --- | --- |
| `api.rollMorale(combat, groupId)` | Roll morale for all living group members. |
| `api.rollMoraleSingle(combat, groupId, combatantId)` | Roll morale for one combatant. |
| `api.rallyMorale(combat, groupId, combatantId?)` | Reroll broken morale for one combatant or all broken group members. |
| `api.clearMorale(combat, groupId, combatantId?)` | Clear morale flags and effects for one combatant or the whole group. |
| `api.clearMoraleEffect(combatant)` | Remove module-managed morale effects. |
| `api.checkAutoMorale(combat, combatant)` | Internal helper for turn-based auto morale. |
| `api.getLivingMembers(combat, groupId)` | Return living group members. |
| `api.getDeadMembers(combat, groupId)` | Return dead/defeated group members. |
| `api.getCasualtyCount(combat, groupId)` | Return dead plus deleted group members. |

### Utilities And Constants

| Method Or Value | Description |
| --- | --- |
| `api.toggleGroupVisibility(combat, groupId)` | Toggle group visibility. |
| `api.generateGroupId()` | Generate a group id. |
| `api.isGM()` | True for GM-capable users. |
| `api.canManageGroups()` | True for users allowed to manage groups. |
| `api.calculateAverageInitiative(values)` | Return rounded average initiative. |
| `api.calculateGroupInitiative(values, mode, captainValue?)` | Calculate group initiative by mode. |
| `api.clearAllTokenHighlights()` | Remove group token highlights from the canvas. |
| `api.expandStore` | Per-user expanded/collapsed group state helpers. |
| `api.INITIATIVE_MODE` | Initiative mode constants. |
| `api.MORALE_TRIGGER` | Morale trigger constants. |
| `api.DISCIPLINE` | Morale discipline constants. |
| `api.MODULE_ID` | Module id string. |
| `api.UNGROUPED` | Ungrouped bucket id. |
| `api.CONSTANTS` | Internal numeric constants. |
| `api.VISIBILITY_SYNC_MODE` | Visibility sync mode constants. |
| `api.HIGHLIGHT_VISIBILITY` | Group highlight visibility constants. |
| `api.DEBUG_LEVELS` | Logging level constants. |

## Example Macros

### Auto-Group Hostile Combatants

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

### Rally A Group By Name

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

### Roll Initiative For All Groups

```javascript
const api = game.modules.get("squad-combat-initiative").api;
const combat = game.combat;
if (!combat) return ui.notifications.warn("No active combat.");

for (const [groupId] of api.getGroups(combat.combatants, combat)) {
  if (groupId === api.UNGROUPED) continue;
  await api.rollGroupInitiative(combat, groupId);
}
```

## Development Notes

- Foundry loads this module as an ES module through `scripts/main.js`.
- The module targets Foundry VTT v13 and dnd5e 5.1+.
- dnd5e-specific initiative behavior should be preserved by using actor-aware initiative rolls.
- Use `node --input-type=module --check` when syntax-checking source through stdin.

## Support

If this module helps your table, support is welcome:

[Ko-fi: Buy Me a Steak](https://ko-fi.com/gnollstack)

## License

Squad Combat Initiative is source-available proprietary software under the included EULA. See `LICENSE.txt` for the full terms; `module.json` declares the package license as `Proprietary`.

## Author

GnollStack
