import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => fs.readFileSync(path.join(ROOT, file), "utf8");

function returnType(comment) {
  const tag = comment.match(/@returns?\s*\{/);
  if (!tag) return "see behavior tests";
  const start = tag.index + tag[0].length;
  let depth = 1, end = start;
  for (; depth && end < comment.length; end++) {
    if (comment[end] === "{") depth++;
    else if (comment[end] === "}") depth--;
  }
  return comment.slice(start, end - 1).trim();
}

export async function collectContracts() {
  const settings = {};
  globalThis.CONST ??= { TOKEN_DISPOSITIONS: { SECRET: -2, HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 } };
  const previousGame = globalThis.game;
  // Capture the GM-facing configuration; role-dependent visibility is tested separately.
  globalThis.game = { user: { isGM: true }, settings: { get: () => "off", register: (_id, key, metadata) => {
    settings[key] = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, typeof value === "function" ? value.name || "function" : value]));
  } } };
  try { (await import("../scripts/settings.js")).registerSettings(); }
  finally { globalThis.game = previousGame; }
  const { PERSISTED_FIELDS, PRESET_FIELDS } = await import("../scripts/group-contracts.js");
  const { DIAGNOSTIC_ACTION_TYPES } = await import("../scripts/diagnostics.js");
  await import("../scripts/combat-events.js");
  const { getCommandContracts } = await import("../scripts/mutation-authority.js");
  const main = read("scripts/main.js");
  const block = main.match(/mod\.api\s*=\s*\{([\s\S]*?)\n\s*\};/)[1];
  const api = {};
  for (const match of block.matchAll(/^\s{6}([A-Za-z_]\w*)(?::\s*([^\n]+)|,)/gm)) {
    const [, key, expression = ""] = match;
    const bound = expression.match(/(GroupManager|MoraleManager)\.(\w+)\.bind/);
    const sourceFile = bound ? bound[1] === "GroupManager" ? "scripts/group-manager.js" : "scripts/morale.js"
      : ["generateGroupId", "isGM", "canManageGroups", "calculateAverageInitiative", "calculateGroupInitiative"].includes(key) ? "scripts/shared.js"
        : key === "clearAllTokenHighlights" ? "scripts/squad-card-renderer.js" : null;
    if (!sourceFile) { api[key] = { kind: "value" }; continue; }
    const symbol = bound?.[2] ?? key;
    const source = read(sourceFile);
    const start = source.search(new RegExp(`(?:static (?:async )?|(?:export )?(?:async )?function )${symbol}\\s*\\(`));
    if (start < 0) throw new Error(`Missing API implementation ${symbol}`);
    const open = source.indexOf("(", start); let depth = 1, end = open + 1;
    for (; depth && end < source.length; end++) { if (source[end] === "(") depth++; else if (source[end] === ")") depth--; }
    // Only the immediately preceding JSDoc belongs to this declaration.
    const preceding = source.slice(0, start).match(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*$/)?.[1] ?? "";
    api[key] = { kind: "function", source: sourceFile, symbol, parameters: source.slice(open + 1, end - 1).replace(/\s+/g, " ").trim(), returns: returnType(preceding) };
  }
  return { settings, persistedFields: PERSISTED_FIELDS, presetFields: PRESET_FIELDS, api, diagnostics: DIAGNOSTIC_ACTION_TYPES, commands: getCommandContracts() };
}

export function localizationFailures() {
  const language = JSON.parse(read("lang/en.json"));
  const files = [];
  const walk = directory => { for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`; if (entry.isDirectory()) walk(name); else files.push(name);
  } };
  walk("scripts"); walk("templates");
  const failures = [];
  for (const file of files) {
    // Literal quoted keys only: SCI.Combatant is a drag payload type, not a translation.
    for (const match of read(file).matchAll(/["'](SCI\.[\w.]+)["']/g)) {
      const key = match[1]; if (key === "SCI.Combatant") continue;
      const value = key.split(".").reduce((node, part) => node?.[part], language);
      if (value === undefined) failures.push(`${file}: ${key}`);
    }
  }
  return [...new Set(failures)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await collectContracts(), null, 2));
}
