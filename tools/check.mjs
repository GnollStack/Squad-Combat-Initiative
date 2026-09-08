import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
const directory = mode === "test" ? "tests" : "scripts";
const files = fs.readdirSync(path.join(root, directory)).filter(name => mode === "test" ? name.endsWith(".test.js") : name.endsWith(".js"));
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, [...(mode === "test" ? [] : ["--check"]), path.join(directory, file)], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status) process.exit(result.status);
}
