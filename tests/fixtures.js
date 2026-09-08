import { compareGroupedCombatants } from "../scripts/initiative-ordering.js";
export const MID = "squad-combat-initiative";
export const settings = new Map();
let sequence = 0;
export function environment() {
  settings.clear();
  for (const [key, value] of Object.entries({ moraleEnabled: true, playerMoraleVisibility: "visible", gmSquadCardDetail: "full", moraleStatusEffect: "fleeing", moraleMobConfidenceDivisor: 3, moraleAutoPromptThreshold: 50, defaultInitiativeMode: "average", defaultGroupPinned: false, groupPresets: {} })) settings.set(key, value);
  globalThis.CONST = { TOKEN_DISPOSITIONS: { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 }, USER_ROLES: { ASSISTANT: 3 } };
  globalThis.game = {
    world: { id: "world" }, user: { id: "gm", isGM: true, isActiveGM: true, active: true }, system: { id: "dnd5e" },
    i18n: { lang: "en", localize: key => key, format: (key, data) => key + JSON.stringify(data) },
    settings: { get: (_m, key) => settings.get(key) ?? "off", set: async (_m, key, value) => settings.set(key, value) },
    combats: Object.assign([], { get(id) { return this.find(c => c.id === id); } }), actors: [], users: [],
  };
  game.users.push(game.user); game.users.activeGM = game.user;
  globalThis.ui = { combat: { render() {} }, notifications: { info() {}, warn() {}, error() {} } };
  globalThis.CONFIG = { queries: {}, statusEffects: [] };
  globalThis.Hooks = { callAll() {}, on() {}, once() {} };
  globalThis.foundry = {
    data: { operators: { ForcedDeletion: class {} } },
    utils: { deepClone: structuredClone, escapeHTML: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll(String.fromCharCode(34), "&quot;"), randomID: () => `random${++sequence}` },
    applications: { handlebars: { renderTemplate: async () => "<p>fixture</p>" }, api: { DialogV2: { confirm: async () => true } } },
  };
  globalThis.ChatMessage = { create: async data => data, getSpeaker: () => ({}) };
}
export function put(root, path, value) {
  const parts = path.split(".");
  for (const part of parts.slice(0, -1)) root = root[part] ??= {};
  if (value instanceof foundry.data.operators.ForcedDeletion) delete root[parts.at(-1)]; else root[parts.at(-1)] = value;
}
export function actor(id = `actor${++sequence}`) {
  const result = {
    id, uuid: `Actor.${id}`, documentName: "Actor", effects: [],
    system: { abilities: { dex: { mod: 0, value: 10 }, wis: { mod: 0 } }, attributes: { hp: { value: 10 } }, details: { cr: 1 } },
    async createEmbeddedDocuments(_type, data) {
      const created = data.map(value => {
        const effect = { ...structuredClone(value), id: `effect${++sequence}`, getFlag(m, key) { return this.flags?.[m]?.[key]; }, async update(changes) { for (const [key, value] of Object.entries(changes)) put(this, key, value); return this; } };
        this.effects.push(effect); return effect;
      }); return created;
    },
    async deleteEmbeddedDocuments(_type, ids) { this.effects = this.effects.filter(e => !ids.includes(e.id)); },
  };
  game.actors.push(result); return result;
}
export function combat(id = `combat${++sequence}`) {
  const result = {
    id, uuid: `Combat.${id}`, documentName: "Combat", round: 1, turn: 0, _source: { turn: 0 },
    flags: { [MID]: { groups: {
      a: { name: "A", initiative: 15, initiativeMode: "average", startingSize: 2, deletedCount: 0, moraleTrigger: "both" },
      b: { name: "B", initiative: 12, initiativeMode: "average", startingSize: 1, deletedCount: 0, moraleTrigger: "both" },
    } } },
    combatants: [], turns: [], writes: [], settings: { skipDefeated: true },
    get combatant() { return this.turns[this.turn]; }, get started() { return this.round > 0; },
    getFlag(module, path) { return path.split(".").reduce((v, p) => v?.[p], this.flags[module]); },
    async update(changes, options = {}) {
      this.writes.push({ changes, options });
      for (const [key, value] of Object.entries(changes)) { put(this, key, value); if (key === "turn") this._source.turn = value; }
      return this;
    },
    async setFlag(m, path, value) { return this.update({ [`flags.${m}.${path}`]: value }); },
    async updateEmbeddedDocuments(_type, updates) {
      for (const update of updates) for (const [key, value] of Object.entries(update)) if (key !== "_id") put(this.combatants.get(update._id), key, value);
      this.setupTurns(); return updates.map(u => this.combatants.get(u._id));
    },
    setupTurns() {
      this.turns = [...this.combatants].sort((a, b) => compareGroupedCombatants(a, b, { moduleId: MID, fallbackCompare: (a, b) => b.initiative - a.initiative }));
      this.current = { combatantId: this.combatant?.id, turn: this.turn, round: this.round }; return this.turns;
    },
    getTimeDelta(fromRound, fromTurn, toRound, toTurn) { return (toRound - fromRound) * 6 + toTurn - fromTurn; },
  };
  for (const [id, groupId, initiative] of [["a1", "a", 20], ["a2", "a", 10], ["b1", "b", 12]]) {
    const member = {
      id, uuid: `${result.uuid}.Combatant.${id}`, documentName: "Combatant", name: id, parent: result,
      initiative, flags: { [MID]: { groupId } }, actor: actor(),
      getFlag(m, key) { return this.flags?.[m]?.[key]; },
      async setFlag(m, key, value) { (this.flags[m] ??= {})[key] = value; },
      async unsetFlag(m, key) { delete this.flags[m][key]; },
    }; result.combatants.push(member);
  }
  result.combatants.get = id => result.combatants.find(c => c.id === id);
  result.setupTurns(); game.combats.push(result); return result;
}
