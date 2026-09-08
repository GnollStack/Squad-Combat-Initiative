/** SCI mutations execute once, in order, on Foundry's designated active GM. */
import { MODULE_ID } from "./shared.js";

export const COMMAND_QUERY = `${MODULE_ID}.command`;
const commands = new Map();
const queues = new Map();
const requests = new Map();
let sequence = 0;

export function isMutationAuthority() {
  return game.user?.isGM === true && game.user?.isActiveGM === true;
}

export function assertMutationAuthority() {
  if (!isMutationAuthority()) throw new Error(game.i18n.localize("SCI.Errors.AuthorityChanged"));
}

export function registerMutationAuthority() {
  CONFIG.queries[COMMAND_QUERY] = async (request, context) => {
    if (!context.user?.isGM || context.user.active === false) {
      throw new Error(game.i18n.localize("SCI.Errors.ManagerRequired"));
    }
    assertMutationAuthority();
    if (!request || typeof request.requestId !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(request.requestId)
      || !commands.has(request.action) || !Array.isArray(request.args)) {
      throw new Error(game.i18n.localize("SCI.Errors.InvalidCommand"));
    }
    const key = `${context.user.id}:${request.requestId}`;
    const previous = requests.get(key);
    if (previous) return previous.promise;
    const record = { settled: false, promise: null };
    // Reserve the id before resolving documents or awaiting any writes.
    record.promise = (async () => {
      const args = await decodeCommandValue(request.args);
      return encodeCommandValue(await executeLocal(request.action, args));
    })();
    requests.set(key, record);
    const settle = () => {
      record.settled = true;
      for (const [id, entry] of requests) {
        if (requests.size <= 256) break;
        if (entry.settled) requests.delete(id);
      }
    };
    record.promise.then(settle, settle);
    return record.promise;
  };
}

/** Register explicit public entrypoints; internal calls use bound _local methods. */
export function registerCommandOwner(namespace, owner, definitions) {
  owner._local ??= {};
  for (const [name, scope] of Object.entries(definitions)) {
    const implementation = owner[name].bind(owner);
    owner._local[name] = implementation;
    const action = `${namespace}.${name}`;
    commands.set(action, { implementation, scope });
    owner[name] = (...args) => requestMutation(action, args);
  }
}

export async function requestMutation(action, args) {
  if (!game.user?.isGM) throw new Error(game.i18n.localize("SCI.Errors.ManagerRequired"));
  if (isMutationAuthority()) return executeLocal(action, args);
  const gm = game.users?.activeGM;
  if (!gm) throw new Error(game.i18n.localize("SCI.Errors.NoActiveGM"));
  const requestId = `${game.user.id}:${Date.now()}:${++sequence}`;
  try {
    const result = await gm.query(COMMAND_QUERY, {
      requestId, action, args: encodeCommandValue(args),
    }, { timeout: 60000 });
    return await decodeCommandValue(result);
  } catch (error) {
    // An acknowledgement may have been lost after a roll committed. Never replay.
    throw new Error(`${game.i18n.localize("SCI.Errors.CommandInterrupted")} ${error.message}`);
  }
}

function executeLocal(action, args) {
  const entry = commands.get(action);
  if (!entry) throw new Error(game.i18n.localize("SCI.Errors.InvalidCommand"));
  const document = entry.scope === "combatant" ? args[0]?.parent : args[0];
  const key = entry.scope === "world" ? "world" : document?.uuid ?? document?.id;
  if (!key) throw new Error(game.i18n.localize("SCI.Errors.InvalidCommand"));
  const prior = queues.get(key) ?? Promise.resolve();
  const operation = prior.catch(() => undefined).then(async () => {
    assertMutationAuthority();
    if (entry.scope !== "world" && game.combats?.get && game.combats.get(document.id) !== document) {
      throw new Error(game.i18n.localize("SCI.Notifications.CombatMissing"));
    }
    return entry.implementation(...args);
  });
  queues.set(key, operation);
  const finish = () => { if (queues.get(key) === operation) queues.delete(key); };
  operation.then(finish, finish);
  return operation;
}

/** Preserve document and Roll types across User.query's JSON transport. */
export function encodeCommandValue(value) {
  if (value === undefined) return { __sciWire: "undefined" };
  if (value === null || typeof value !== "object") return value;
  const document = value.document ?? value;
  if (document.documentName && document.uuid) return { __sciWire: "document", uuid: document.uuid };
  const RollClass = globalThis.Roll ?? globalThis.foundry?.dice?.Roll;
  if (RollClass && value instanceof RollClass) return { __sciWire: "roll", data: JSON.stringify(value.toJSON()) };
  if (Array.isArray(value)) return value.map(encodeCommandValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeCommandValue(item)]));
}

export async function decodeCommandValue(value) {
  if (!value || typeof value !== "object") return value;
  if (value.__sciWire === "undefined") return undefined;
  if (value.__sciWire === "document") {
    if (typeof value.uuid !== "string" || value.uuid.length > 250) throw new Error("Invalid document reference");
    const document = await fromUuid(value.uuid);
    if (!document || !["Combat", "Combatant", "Token", "Actor", "Scene"].includes(document.documentName)) {
      throw new Error(game.i18n.localize("SCI.Errors.StaleDocument"));
    }
    return document;
  }
  if (value.__sciWire === "roll") return (globalThis.Roll ?? foundry.dice.Roll).fromJSON(value.data);
  if (Array.isArray(value)) return Promise.all(value.map(decodeCommandValue));
  const pairs = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await decodeCommandValue(item)]));
  return Object.fromEntries(pairs);
}

export function getCommandContracts() {
  return Object.fromEntries([...commands].map(([name, entry]) => [name, entry.scope]));
}

/** Diagnostics can await observed document work without replaying commands. */
export async function waitForMutations(combat) {
  const key = combat.uuid ?? combat.id;
  while (queues.has(key)) await queues.get(key);
}
