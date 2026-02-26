<div align="center">
  
# Squad Combat Initiative

**A Foundry VTT module for enhanced group-based initiative management in D&D 5e**

[![Release](https://img.shields.io/github/v/release/GnollStack/Squad-Combat-Initiative?label=Latest%20Release&style=flat-square)](https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/GnollStack/Squad-Combat-Initiative/total?style=flat-square&color=blue)](https://github.com/GnollStack/Squad-Combat-Initiative/releases)
![Downloads@latest](https://img.shields.io/github/downloads/GnollStack/Squad-Combat-Initiative/latest/total)
[![Foundry VTT](https://img.shields.io/badge/Foundry-v13-orange?style=flat-square)](https://foundryvtt.com)
[![D&D 5e](https://img.shields.io/badge/D%26D%205e-5.1%2B-red?style=flat-square)](https://github.com/foundryvtt/dnd5e)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20a%20Steak-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/gnollstack)

*Group combatants into visual squads, auto-calculate shared initiative, and streamline large-scale combat!*

[Features](#features) • [Installation](#installation) • [Documentation](#documentation) • [License](#%EF%B8%8F-license--permissions)

</div>

---

##  The Problem With Large Combats

**Do you love throwing hordes of enemies at your players but hate the initiative bookkeeping?**

Running combat with 8 goblins means 8 separate initiative rolls, 8 scattered turns throughout the round, and constant tracker scrolling. Squad Combat Initiative fixes this by letting you group enemies together, allowing yout roll once, act together, stay organized.

---

##  Features

### Group Creation & Management
Create initiative groups directly in the combat tracker with two flexible methods:

| Method | How It Works |
|--------|--------------|
| **Bulk Selection** | Select tokens on canvas → Click "Add Group" → All selected join the new group |
| **Drag & Drop** | Create an empty group → Drag individual combatants into it |

Each group can be customized with:
-  **Custom name** - "Goblin Squad Alpha" instead of "New Group"
-  **Color accent** - Visual distinction between factions
-  **Custom icon** - Use any image from your library
-  **Hidden toggle** - Keep groups secret from players until revealed

<img width="1361" height="935" alt="Screenshot 2026-01-27 221904" src="https://github.com/user-attachments/assets/e21e368e-1e4e-4cc7-aca9-fc7fd35e3a4d" />

---

### Smart Initiative System

**Roll once, sort automatically.** When you roll initiative for a group:

1. Each member rolls individually (with their own DEX modifier)
2. The group's position is set by the **rounded average** of all rolls
3. Members are ordered within the group by their individual rolls
4. Ties are broken by DEX score

This means your "Goblin Squad" acts together in initiative order, but the goblin who rolled highest goes first within the squad.

<img width="1634" height="1181" alt="Screenshot 2026-01-27 221432" src="https://github.com/user-attachments/assets/f90af600-106a-4ba6-b0ad-8e2661085636" />

#### Roll Modifiers
| Input | Roll Type |
|-------|-----------|
| Click | Normal (1d20) |
| Alt + Click | Advantage (2d20kh) |
| Ctrl/Cmd + Click | Disadvantage (2d20kl) |

---

### Full Combat Control

#### Group Header Controls
Every group header includes quick-action buttons:

| Button | Action |
|:------:|--------|
| 📌 | **Pin** - Keep expanded during auto-collapse |
| ↩️ | **Reset** - Clear all member initiatives |
| 🎲 | **Roll** - Roll initiative for unrolled members |
| ⬚ | **Select** - Select all group tokens on canvas |
| 👁️ | **Visibility** - Toggle hidden state |
| ✕ | **Delete** - Remove group (keeps combatants) |

#### Right-Click Context Menu
- **Rename Group** - Change the display name
- **Set Group Initiative** - Manually override the average
- **Delete Group** - Remove with confirmation

#### Drag & Drop
- Drag combatants between groups freely
- Drop outside any group to ungroup
- New combatants auto-sort into the "ungrouped" section

---

### Quality of Life

- **Collapsible headers** - Click to expand/collapse, state persists across sessions
- **Auto-collapse** - Only the active group stays expanded (configurable)
- **Token highlighting** - Hover a group header to highlight all its tokens on the map
- **Inline editing** - Double-click group initiative to manually adjust
- **Bulk roll support** - "Roll All" and "Roll NPCs" buttons work with groups

---

##  Installation

### Requirements
| Dependency | Version |
|------------|---------|
| [Foundry VTT](https://foundryvtt.com) | v13+ |
| [D&D 5e System](https://github.com/foundryvtt/dnd5e) | 5.1+ |
| [lib-wrapper](https://github.com/ruipin/fvtt-lib-wrapper) | Latest |

### Install via Foundry
1. Open Foundry VTT and navigate to **Add-on Modules**
2. Click **Install Module**
3. Search for "Squad Combat Initiative" or paste this manifest URL:
   ```
   https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest/download/module.json
   ```
4. Click **Install**
5. Enable the module in your world's **Module Settings**

---

##  Documentation

### Module Settings

Access via **Configure Settings → Module Settings → Squad Combat Initiative**

| Setting | Options | Default | Description |
|---------|---------|---------|-------------|
| Auto Collapse Groups | On/Off | On | Automatically collapse inactive groups when turn changes |
| Group Token Highlight | Off / GM Only / Everyone | GM Only | Who sees token highlights when hovering group headers |
| Debug Logging Level | Off / Normal / Verbose | Off | Console logging verbosity for troubleshooting |

---

### How Initiative Math Works

When a group rolls initiative:

```
Group Average = round(sum of all member initiatives / member count)
```

Each member's displayed initiative becomes:
```
Group Average + (group rank offset) + (member position × 0.01)
```

**Example:** Three goblins roll 18, 14, and 10.
- Group average: round((18 + 14 + 10) / 3) = **14**
- Goblin A (rolled 18): 14.03
- Goblin B (rolled 14): 14.02  
- Goblin C (rolled 10): 14.01

They all act at initiative 14 but maintain their internal order.

<img width="294" height="929" alt="image" src="https://github.com/user-attachments/assets/990a8a7c-211e-4c88-8391-5d1ba1f5a36d" />

---

### Keyboard Shortcuts

| Context | Shortcut | Action |
|---------|----------|--------|
| Roll button | Alt + Click | Roll with advantage |
| Roll button | Ctrl/Cmd + Click | Roll with disadvantage |
| Initiative value | Double-click | Edit inline |
| Group header | Click | Toggle collapse |

---

## Roadmap

Have ideas? Open an issue or reach out on Discord!

---

## 🥩 Support Development

This module represents **many hours** of developement.

**If this module enhanced your immersion, consider treating me to a steak, much better than coffee!**

<a href='https://ko-fi.com/gnollstack' target='_blank'>
<img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi3.png?v=3' border='0' alt='Buy Me a Steak at ko-fi.com' />
</a>

> *"Thanks for the support! It helps me maintain support for the module and puts a nice steak on the table."*

---

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
**Author:** [GnollStack](https://github.com/GnollStack)
**Compatibility:** Foundry VTT v13+ / dnd5e 5.2.5+

