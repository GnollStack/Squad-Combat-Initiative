import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveReleaseContract,
  validateManifestValues,
  validateTagState,
  validateArchiveBuffer,
  validateArchiveContents,
} from "../tools/release.mjs";

// Minimal stored ZIP entries exercise validation without filesystem or Git state.
function zipFiles(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of files) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test("archive validation rejects compatibility drift even when version and URLs match", () => {
  const manifest = { version: "14.1.1", compatibility: { verified: "14.367" } };
  const archive = zipFiles([["module.json", JSON.stringify({ ...manifest, compatibility: { verified: "14.363" } })]]);
  assert.ok(validateArchiveBuffer(archive, manifest).failures.some((failure) => failure.includes("contents do not exactly match")));
});

test("archive validation rejects unsafe, private and duplicate entries", () => {
  const archive = zipFiles([
    ["module.json", "{}"], ["scripts/../secret.js", ""],
    ["scripts/AGENTS.md", ""], ["scripts/main.js", "a"], ["scripts/main.js", "b"],
  ]);
  const { failures } = validateArchiveBuffer(archive, {});
  assert.ok(failures.some((failure) => failure.includes("unsafe path")));
  assert.ok(failures.some((failure) => failure.includes("private or local-only")));
  assert.ok(failures.some((failure) => failure.includes("duplicate path")));
});

test("archive verification rejects altered, missing and extra runtime files", () => {
  const expected = new Map([["scripts/main.js", Buffer.from("tested code")], ["scripts/shared.js", Buffer.from("helper")]]);
  const archive = zipFiles([["scripts/main.js", "stale code"], ["scripts/extra.js", "unexpected"]]);
  const failures = validateArchiveContents(archive, expected);
  assert.ok(failures.some((failure) => failure.includes("differs from tag")));
  assert.ok(failures.some((failure) => failure.includes("missing tagged file")));
  assert.ok(failures.some((failure) => failure.includes("absent from tag")));
  assert.deepEqual(validateArchiveContents(zipFiles([...expected]), expected), []);
});

test("release contract derives the uppercase tag and pinned ZIP URL", () => {
  const contract = deriveReleaseContract("14.1.0");
  assert.equal(contract.expectedTag, "V14.1.0");
  assert.equal(contract.manifestUrl, "https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest/download/module.json");
  assert.equal(contract.downloadUrl, "https://github.com/GnollStack/Squad-Combat-Initiative/releases/download/V14.1.0/squad-combat-initiative.zip");
});

test("manifest validation rejects incorrect tag capitalization in download URL", () => {
  const manifest = {
    version: "14.1.0",
    manifest: "https://github.com/GnollStack/Squad-Combat-Initiative/releases/latest/download/module.json",
    download: "https://github.com/GnollStack/Squad-Combat-Initiative/releases/download/v14.1.0/squad-combat-initiative.zip",
  };
  const result = validateManifestValues(manifest, { version: "14.1.0" });
  assert.ok(result.failures.some((failure) => failure.includes("V14.1.0")));
});

test("manifest validation rejects a package version mismatch", () => {
  const contract = deriveReleaseContract("14.1.0");
  const result = validateManifestValues({
    version: "14.1.0",
    manifest: contract.manifestUrl,
    download: contract.downloadUrl,
  }, { version: "14.0.0" });
  assert.ok(result.failures.some((failure) => failure.includes("package.json.version")));
});

test("final validation rejects an absent release tag", () => {
  const failures = validateTagState({ expectedTag: "V14.1.0", headCommit: "final", tags: [] });
  assert.ok(failures.some((failure) => failure.includes("does not exist")));
});

test("final validation rejects an incorrectly capitalized release tag", () => {
  const failures = validateTagState({
    expectedTag: "V14.1.0",
    headCommit: "final",
    tags: [{ name: "v14.1.0", commit: "final" }],
  });
  assert.ok(failures.some((failure) => failure.includes("Incorrect tag capitalization")));
  assert.ok(failures.some((failure) => failure.includes("does not exist")));
});

test("final validation rejects a stale release tag", () => {
  const failures = validateTagState({
    expectedTag: "V14.1.0",
    headCommit: "final",
    tags: [{ name: "V14.1.0", commit: "older" }],
  });
  assert.ok(failures.some((failure) => failure.includes("resolves to older")));
});

test("final validation reports when the tag points to a different commit", () => {
  const failures = validateTagState({
    expectedTag: "V14.1.0",
    headCommit: "bbbbbbbb",
    tags: [{ name: "V14.1.0", commit: "aaaaaaaa" }],
  });
  assert.deepEqual(failures, [
    "Release tag V14.1.0 resolves to aaaaaaaa, but the final release commit is bbbbbbbb.",
  ]);
});
