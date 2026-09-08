import test from "node:test";
import assert from "node:assert/strict";
import { environment, combat } from "./fixtures.js";
environment();
const { registerCommandOwner, registerMutationAuthority, COMMAND_QUERY, encodeCommandValue, decodeCommandValue } = await import("../scripts/mutation-authority.js");
const calls = [];
class Commands { static async write(doc, value) { calls.push(value); if (value === "fail") throw new Error("failed write"); return { doc, value }; } }
registerCommandOwner("test", Commands, { write: "combat" });

test("authenticated query deduplicates an in-flight request before resolving its documents", async () => {
  environment(); registerMutationAuthority(); calls.length = 0;
  const doc = combat(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fromUuid = async () => { await gate; return doc; };
  const request = { requestId: "same", action: "test.write", args: encodeCommandValue([doc, 3]) };
  const handler = CONFIG.queries[COMMAND_QUERY];
  const a = handler(request, { user: game.user }); const b = handler(request, { user: game.user });
  release(); assert.deepEqual(await a, await b); assert.deepEqual(calls, [3]);
});

test("query rejects players, missing authority, unknown commands and stale documents", async () => {
  environment(); registerMutationAuthority(); const handler = CONFIG.queries[COMMAND_QUERY];
  await assert.rejects(handler({}, { user: { isGM: false } }), /ManagerRequired/);
  await assert.rejects(handler({ requestId: "x", action: "deleteEverything", args: [] }, { user: game.user }), /InvalidCommand/);
  game.user.isActiveGM = false; await assert.rejects(handler({}, { user: game.user }), /AuthorityChanged/);
  game.user.isActiveGM = true; globalThis.fromUuid = async () => null;
  await assert.rejects(decodeCommandValue({ __sciWire: "document", uuid: "Combat.missing" }), /StaleDocument/);
});

test("failed commands do not poison the encounter queue", async () => {
  environment(); calls.length = 0; const doc = combat();
  const failed = Commands.write(doc, "fail"); const next = Commands.write(doc, "success");
  await assert.rejects(failed, /failed write/); assert.equal((await next).value, "success");
  assert.deepEqual(calls, ["fail", "success"]);
});

test("queued commands recheck authority after GM handover", async () => {
  environment(); const doc = combat(); game.user.isActiveGM = true;
  const command = Commands.write(doc, "blocked"); game.user.isActiveGM = false;
  await assert.rejects(command, /AuthorityChanged/);
});

test("secondary GM uses the active GM query once and never replays a timeout", async () => {
  environment(); const doc = combat(); let count = 0;
  game.user = { id: "assistant", isGM: true, isActiveGM: false };
  game.users.activeGM.query = async (name, request) => {
    count++; assert.equal(name, COMMAND_QUERY); assert.equal(request.args[0].uuid, doc.uuid); throw new Error("timeout");
  };
  await assert.rejects(Commands.write(doc, "dice"), /CommandInterrupted.*timeout/);
  assert.equal(count, 1);
});

test("wire encoding round-trips documents, undefined and Roll results", async () => {
  environment(); const doc = combat(); globalThis.fromUuid = async () => doc;
  globalThis.Roll = class { toJSON() { return { total: 17 }; } static fromJSON(json) { return Object.assign(new this(), JSON.parse(json)); } };
  const decoded = await decodeCommandValue(encodeCommandValue({ doc, missing: undefined, roll: new Roll() }));
  assert.equal(decoded.doc, doc); assert.equal(decoded.missing, undefined); assert.ok(decoded.roll instanceof Roll); assert.equal(decoded.roll.total, 17);
});
