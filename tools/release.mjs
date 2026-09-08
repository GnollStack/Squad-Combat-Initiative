import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import zlib from "node:zlib";

export const RELEASE_CONVENTION = Object.freeze({
  owner: "GnollStack",
  repository: "Squad-Combat-Initiative",
  tagPrefix: "V",
  manifestFilename: "module.json",
  zipFilename: "squad-combat-initiative.zip",
  versionPattern: /^\d+\.\d+\.\d+$/,
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ARCHIVE = path.join(ROOT, "dist", RELEASE_CONVENTION.zipFilename);
const DEFAULT_STANDALONE_MANIFEST = path.join(ROOT, "dist", RELEASE_CONVENTION.manifestFilename);
const ARCHIVE_RUNTIME_PATHS = Object.freeze([
  "module.json",
  "README.md",
  "LICENSE.txt",
  "lang",
  "scripts",
  "styles",
  "templates",
]);

export function deriveReleaseContract(version) {
  const base = `https://github.com/${RELEASE_CONVENTION.owner}/${RELEASE_CONVENTION.repository}`;
  const expectedTag = `${RELEASE_CONVENTION.tagPrefix}${version}`;
  return {
    version,
    expectedTag,
    manifestUrl: `${base}/releases/latest/download/${RELEASE_CONVENTION.manifestFilename}`,
    downloadUrl: `${base}/releases/download/${expectedTag}/${RELEASE_CONVENTION.zipFilename}`,
    exactManifestUrl: `${base}/releases/download/${expectedTag}/${RELEASE_CONVENTION.manifestFilename}`,
  };
}

function run(command, args, { allowFailure = false, cwd = ROOT, encoding = "utf8" } = {}) {
  const result = spawnSync(command, args, { cwd, encoding });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function git(args, options) {
  return run("git", args, options);
}

function readJson(relativePath, failures) {
  const absolutePath = path.join(ROOT, relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    failures.push(`${relativePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

function manifestRuntimePaths(manifest) {
  const paths = [];
  for (const key of ["esmodules", "scripts", "styles"]) {
    if (Array.isArray(manifest?.[key])) paths.push(...manifest[key]);
  }
  if (Array.isArray(manifest?.languages)) {
    paths.push(...manifest.languages.map((language) => language?.path).filter(Boolean));
  }
  if (Array.isArray(manifest?.packs)) {
    paths.push(...manifest.packs.map((pack) => pack?.path).filter(Boolean));
  }
  return [...new Set(paths)];
}

function normalizeArchivePath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function isSafeRelativePath(value) {
  const normalized = normalizeArchivePath(value);
  return normalized.length > 0
    && !normalized.startsWith("/")
    && !normalized.split("/").includes("..")
    && !/^[A-Za-z]:/.test(normalized);
}

function isPrivateOrLocalPath(value) {
  const normalized = normalizeArchivePath(value).replace(/\/$/, "");
  const lower = normalized.toLowerCase();
  const parts = lower.split("/");
  const basename = parts.at(-1) ?? "";
  if (["agents.md", "claude.md"].includes(basename)) return true;
  if (parts.some((part) => ["llm-instructions", ".agents", ".codex"].includes(part))) return true;
  if (parts.some((part) => ["log", "logs", "credentials"].includes(part))) return true;
  return basename.endsWith(".log")
    || basename === ".env"
    || basename.startsWith(".env.")
    || basename.endsWith(".pem")
    || basename.endsWith(".key")
    || basename.endsWith("credentials.json");
}

function isReleaseRuntimePath(value) {
  const normalized = normalizeArchivePath(value).replace(/\/$/, "");
  if (["module.json", "README.md", "LICENSE.txt"].includes(normalized)) return true;
  if (["lang", "scripts", "styles", "templates"].includes(normalized)) return true;
  return ["lang/", "scripts/", "styles/", "templates/"].some((prefix) => normalized.startsWith(prefix));
}

export function validateManifestValues(manifest, packageJson) {
  const failures = [];
  const version = manifest?.version;
  if (typeof version !== "string" || !RELEASE_CONVENTION.versionPattern.test(version)) {
    failures.push("module.json.version must use the discovered numeric X.Y.Z format.");
    return { failures, contract: null };
  }

  const contract = deriveReleaseContract(version);
  if (packageJson?.version !== version) {
    failures.push(`package.json.version must equal module.json.version (${version}).`);
  }
  if (manifest.manifest !== contract.manifestUrl) {
    failures.push(`module.json.manifest must equal ${contract.manifestUrl}`);
  }
  if (manifest.download !== contract.downloadUrl) {
    failures.push(`module.json.download must equal ${contract.downloadUrl}`);
  }
  return { failures, contract };
}

export function validateTagState({ expectedTag, headCommit, tags }) {
  const failures = [];
  const sameVersion = tags.filter((tag) => tag.name.toLowerCase() === expectedTag.toLowerCase());
  const wrongCase = sameVersion.filter((tag) => tag.name !== expectedTag);
  for (const tag of wrongCase) {
    failures.push(`Incorrect tag capitalization: found ${tag.name}; expected exactly ${expectedTag}.`);
  }

  const exact = tags.find((tag) => tag.name === expectedTag);
  if (!exact) {
    failures.push(`Expected release tag ${expectedTag} does not exist.`);
  } else if (exact.commit !== headCommit) {
    failures.push(`Release tag ${expectedTag} resolves to ${exact.commit}, but the final release commit is ${headCommit}.`);
  }
  return failures;
}

function validateTrackedPrivacy() {
  const output = git(["ls-files", "-z"]).stdout;
  return output.split("\0").filter(Boolean)
    .filter(isPrivateOrLocalPath)
    .map((file) => `Private or local-only path is tracked by Git: ${file}`);
}

function validateWhitespace() {
  const failures = [];
  for (const args of [["diff", "--check"], ["diff", "--cached", "--check"]]) {
    const result = git(args, { allowFailure: true });
    if (result.status !== 0) failures.push((result.stdout || result.stderr).trim());
  }
  return failures.filter(Boolean);
}

function validateDiskRuntimePaths(manifest) {
  const failures = [];
  for (const runtimePath of manifestRuntimePaths(manifest)) {
    if (!isSafeRelativePath(runtimePath)) {
      failures.push(`Unsafe runtime path in module.json: ${runtimePath}`);
      continue;
    }
    if (!fs.existsSync(path.join(ROOT, runtimePath))) {
      failures.push(`Runtime path listed by module.json does not exist: ${runtimePath}`);
    }
  }
  return failures;
}

function currentMetadataValidation() {
  const failures = [];
  const manifest = readJson("module.json", failures);
  const packageJson = readJson("package.json", failures);
  let contract = null;
  if (manifest && packageJson) {
    const result = validateManifestValues(manifest, packageJson);
    failures.push(...result.failures);
    contract = result.contract;
    failures.push(...validateDiskRuntimePaths(manifest));
  }
  failures.push(...validateTrackedPrivacy(), ...validateWhitespace());
  return { failures, manifest, packageJson, contract };
}

function localTags() {
  const names = git(["tag", "--list"]).stdout.split(/\r?\n/).filter(Boolean);
  return names.map((name) => ({
    name,
    commit: git(["rev-list", "-n", "1", name]).stdout.trim(),
  }));
}

function currentHead() {
  return git(["rev-parse", "HEAD"]).stdout.trim();
}

function releaseGitValidation(contract) {
  const failures = validateTagState({
    expectedTag: contract.expectedTag,
    headCommit: currentHead(),
    tags: localTags(),
  });
  const trackedStatus = git(["status", "--porcelain=v1", "--untracked-files=no"]).stdout.trim();
  if (trackedStatus) failures.push(`Tracked working tree is not clean:\n${trackedStatus}`);
  return failures;
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record was not found.");
}

function readZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central-directory entry.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ name: normalizeArchivePath(name), method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error(`Invalid local ZIP header for ${entry.name}.`);
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  let content;
  if (entry.method === 0) content = compressed;
  else if (entry.method === 8) content = zlib.inflateRawSync(compressed);
  else throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}.`);
  if (content.length !== entry.uncompressedSize) throw new Error(`ZIP size mismatch for ${entry.name}.`);
  return content;
}

function compareManifestContract(label, actual, expected, failures) {
  for (const key of ["version", "manifest", "download"]) {
    if (actual?.[key] !== expected?.[key]) {
      failures.push(`${label} ${key} does not match standalone module.json.`);
    }
  }
  if (!isDeepStrictEqual(actual, expected)) failures.push(`${label} contents do not exactly match standalone module.json.`);
}

export function validateArchiveBuffer(buffer, standaloneManifest) {
  const failures = [];
  let entries;
  try {
    entries = readZip(buffer);
  } catch (error) {
    return { failures: [`Release ZIP is invalid: ${error.message}`], entries: [], embeddedManifest: null };
  }

  const privateEntries = entries.filter((entry) => isPrivateOrLocalPath(entry.name));
  const seen = new Set();
  for (const entry of entries) {
    if (!isSafeRelativePath(entry.name)) failures.push(`Release ZIP contains unsafe path: ${entry.name}`);
    if (seen.has(entry.name)) failures.push(`Release ZIP contains duplicate path: ${entry.name}`);
    seen.add(entry.name);
  }
  for (const entry of privateEntries) failures.push(`Release ZIP contains private or local-only path: ${entry.name}`);
  const nonRuntimeEntries = entries.filter((entry) => {
    const normalized = entry.name.replace(/\/$/, "");
    return normalized && !isReleaseRuntimePath(entry.name);
  });
  for (const entry of nonRuntimeEntries) failures.push(`Release ZIP contains non-runtime path: ${entry.name}`);

  const manifestEntries = entries.filter((entry) => entry.name === RELEASE_CONVENTION.manifestFilename);
  if (manifestEntries.length !== 1) {
    failures.push(`Release ZIP must contain exactly one root ${RELEASE_CONVENTION.manifestFilename}; found ${manifestEntries.length}.`);
    return { failures, entries, embeddedManifest: null };
  }

  let embeddedManifest = null;
  try {
    embeddedManifest = JSON.parse(readZipEntry(buffer, manifestEntries[0]).toString("utf8"));
    compareManifestContract("Embedded manifest", embeddedManifest, standaloneManifest, failures);
  } catch (error) {
    failures.push(`Embedded module.json is invalid: ${error.message}`);
  }

  if (embeddedManifest) {
    const entryNames = new Set(entries.map((entry) => entry.name.replace(/\/$/, "")));
    for (const runtimePath of manifestRuntimePaths(embeddedManifest)) {
      if (!entryNames.has(normalizeArchivePath(runtimePath))) {
        failures.push(`Release ZIP is missing manifest runtime path: ${runtimePath}`);
      }
    }
  }
  return { failures, entries, embeddedManifest };
}

export function validateArchiveContents(buffer, expectedFiles) {
  const failures = [];
  try {
    const entries = readZip(buffer).filter((entry) => !entry.name.endsWith("/"));
    const names = new Set(entries.map((entry) => entry.name));
    for (const name of expectedFiles.keys()) {
      if (!names.has(name)) failures.push(`Release ZIP is missing tagged file: ${name}`);
    }
    for (const entry of entries) {
      const expected = expectedFiles.get(entry.name);
      if (!expected) failures.push(`Release ZIP contains file absent from tag: ${entry.name}`);
      else if (!readZipEntry(buffer, entry).equals(expected)) failures.push(`Release ZIP content differs from tag: ${entry.name}`);
    }
  } catch (error) {
    failures.push(`Could not compare ZIP content with tag: ${error.message}`);
  }
  return failures;
}

function validateTaggedArchive(buffer, contract) {
  try {
    const names = git(["ls-tree", "-r", "--name-only", "-z", contract.expectedTag, "--", ...ARCHIVE_RUNTIME_PATHS]).stdout.split("\0").filter(Boolean);
    const files = new Map(names.map((name) => [name, git(["show", `${contract.expectedTag}:${name}`], { encoding: null }).stdout]));
    return validateArchiveContents(buffer, files);
  } catch (error) {
    return [`Could not verify tagged archive contents: ${error.message}`];
  }
}

function validateArchiveFile(archivePath, manifest) {
  if (!fs.existsSync(archivePath)) return [`Release ZIP does not exist: ${archivePath}`];
  return validateArchiveBuffer(fs.readFileSync(archivePath), manifest).failures;
}

function validateStandaloneAsset(assetPath, sourceManifest) {
  const failures = [];
  if (!fs.existsSync(assetPath)) {
    failures.push(`Standalone release manifest does not exist: ${assetPath}`);
    return { failures, manifest: null };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(assetPath, "utf8"));
    compareManifestContract("Standalone release manifest", manifest, sourceManifest, failures);
    return { failures, manifest };
  } catch (error) {
    failures.push(`Standalone release manifest is invalid: ${error.message}`);
    return { failures, manifest: null };
  }
}

function printContract(contract) {
  if (!contract) return;
  console.log(`[INFO] Expected tag: ${contract.expectedTag}`);
  console.log(`[INFO] Stable manifest: ${contract.manifestUrl}`);
  console.log(`[INFO] Pinned download: ${contract.downloadUrl}`);
}

function finish(label, failures, contract) {
  printContract(contract);
  if (failures.length) {
    for (const failure of failures) console.error(`[FAIL] ${failure}`);
    console.error(`[FAIL] ${label} completed with ${failures.length} failure(s).`);
    process.exitCode = 1;
    return false;
  }
  console.log(`[PASS] ${label} completed with 0 failures.`);
  return true;
}

function runPreTag() {
  const result = currentMetadataValidation();
  finish("Pre-tag release validation", result.failures, result.contract);
}

function resolveArchiveArgument(value) {
  return value ? path.resolve(ROOT, value) : DEFAULT_ARCHIVE;
}

function runArchiveCheck(archiveArgument) {
  const result = currentMetadataValidation();
  const archivePath = resolveArchiveArgument(archiveArgument);
  if (result.manifest) result.failures.push(...validateArchiveFile(archivePath, result.manifest));
  finish(`Release archive validation (${archivePath})`, result.failures, result.contract);
}

function runFinal(archiveArgument) {
  const result = currentMetadataValidation();
  if (result.contract) result.failures.push(...releaseGitValidation(result.contract));
  const archivePath = resolveArchiveArgument(archiveArgument);
  if (result.manifest) {
    const standalone = validateStandaloneAsset(DEFAULT_STANDALONE_MANIFEST, result.manifest);
    result.failures.push(...standalone.failures);
    result.failures.push(...validateArchiveFile(archivePath, standalone.manifest ?? result.manifest));
    if (!result.failures.length) result.failures.push(...validateTaggedArchive(fs.readFileSync(archivePath), result.contract));
  }
  finish(`Final release validation (${archivePath})`, result.failures, result.contract);
}

function runBuild() {
  const result = currentMetadataValidation();
  if (result.contract) result.failures.push(...releaseGitValidation(result.contract));
  if (!finish("Pre-build tagged release validation", result.failures, result.contract)) return;

  fs.mkdirSync(path.dirname(DEFAULT_ARCHIVE), { recursive: true });
  if (fs.existsSync(DEFAULT_ARCHIVE)) fs.rmSync(DEFAULT_ARCHIVE);
  if (fs.existsSync(DEFAULT_STANDALONE_MANIFEST)) fs.rmSync(DEFAULT_STANDALONE_MANIFEST);
  const taggedManifest = git(["show", `${result.contract.expectedTag}:module.json`]).stdout;
  fs.writeFileSync(DEFAULT_STANDALONE_MANIFEST, taggedManifest, "utf8");
  run("git", [
    "archive",
    "--format=zip",
    `--output=${DEFAULT_ARCHIVE}`,
    result.contract.expectedTag,
    ...ARCHIVE_RUNTIME_PATHS,
  ]);

  const standalone = validateStandaloneAsset(DEFAULT_STANDALONE_MANIFEST, result.manifest);
  const archiveFailures = [
    ...standalone.failures,
    ...validateArchiveFile(DEFAULT_ARCHIVE, standalone.manifest ?? result.manifest),
    ...validateTaggedArchive(fs.readFileSync(DEFAULT_ARCHIVE), result.contract),
  ];
  finish(`Release build (${DEFAULT_ARCHIVE})`, archiveFailures, result.contract);
}

function fetchBuffer(url, redirects = 0) {
  if (redirects > 10) return Promise.reject(new Error(`Too many redirects while fetching ${url}`));
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, { headers: { "User-Agent": "Squad-Combat-Initiative-release-validator" } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve(fetchBuffer(new URL(response.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`${url} returned HTTP ${status}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    request.on("error", reject);
  });
}

function parseRemoteTags(output) {
  const refs = new Map();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [commit, ref] = line.split(/\s+/);
    if (!ref?.startsWith("refs/tags/")) continue;
    const rawName = ref.slice("refs/tags/".length);
    const peeled = rawName.endsWith("^{}");
    const name = peeled ? rawName.slice(0, -3) : rawName;
    if (peeled || !refs.has(name)) refs.set(name, commit);
  }
  return [...refs].map(([name, commit]) => ({ name, commit }));
}

async function runRemote() {
  const result = currentMetadataValidation();
  if (!result.contract || !result.manifest) {
    finish("Remote release validation", result.failures, result.contract);
    return;
  }

  result.failures.push(...releaseGitValidation(result.contract));
  const remoteResult = git(["ls-remote", "--tags", "origin"], { allowFailure: true });
  if (remoteResult.status !== 0) {
    result.failures.push(`Could not query remote tags: ${(remoteResult.stderr || remoteResult.stdout).trim()}`);
  } else {
    result.failures.push(...validateTagState({
      expectedTag: result.contract.expectedTag,
      headCommit: currentHead(),
      tags: parseRemoteTags(remoteResult.stdout),
    }).map((failure) => `Remote: ${failure}`));
  }

  try {
    const [exactManifestBuffer, latestManifestBuffer, zipBuffer] = await Promise.all([
      fetchBuffer(result.contract.exactManifestUrl),
      fetchBuffer(result.contract.manifestUrl),
      fetchBuffer(result.contract.downloadUrl),
    ]);
    const exactManifest = JSON.parse(exactManifestBuffer.toString("utf8"));
    const latestManifest = JSON.parse(latestManifestBuffer.toString("utf8"));
    console.log(`[PASS] Fetched and parsed ${result.contract.exactManifestUrl}`);
    console.log(`[PASS] Fetched and parsed ${result.contract.manifestUrl}`);
    compareManifestContract("Published exact-version manifest", exactManifest, result.manifest, result.failures);
    compareManifestContract("Published latest manifest", latestManifest, result.manifest, result.failures);
    const archiveResult = validateArchiveBuffer(zipBuffer, exactManifest);
    console.log(`[PASS] Fetched and inspected ${result.contract.downloadUrl} (${archiveResult.entries.length} entries)`);
    result.failures.push(...archiveResult.failures.map((failure) => `Published ZIP: ${failure}`));
    result.failures.push(...validateTaggedArchive(zipBuffer, result.contract));
  } catch (error) {
    result.failures.push(`Published asset inspection failed: ${error.message}`);
  }
  finish("Remote release validation", result.failures, result.contract);
}

function printUsage() {
  console.log("Usage: node tools/release.mjs <check|archive|build|verify|remote> [archive-path]");
}

async function main() {
  const [command = "check", archiveArgument] = process.argv.slice(2);
  if (command === "check") runPreTag();
  else if (command === "archive") runArchiveCheck(archiveArgument);
  else if (command === "build") runBuild();
  else if (command === "verify") runFinal(archiveArgument);
  else if (command === "remote") await runRemote();
  else {
    printUsage();
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
