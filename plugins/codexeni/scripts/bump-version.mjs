#!/usr/bin/env node
/**
 * One plugin, several hosts, all needing the same version so each caches it correctly.
 * `node scripts/bump-version.mjs [version|--check]` — omit for a dev timestamp, --check exits 1 on disagreement. Uses a pre-release suffix (-dev.N), not build metadata, since semver ignores the latter when hosts compare.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSIONED = ["package.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json"];

const read = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const write = (file, value) => writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`, "utf8");

/** The argv each host uses to start the MCP server. */
function serverArgs(host) {
  if (host === "codex") {
    const mcpFile = read(".codex-plugin/plugin.json").mcpServers;
    return typeof mcpFile === "string" ? read(mcpFile).mcpServers?.codexeni?.args ?? [] : [];
  }
  return read(".claude-plugin/plugin.json").mcpServers?.codexeni?.args ?? [];
}

const argument = process.argv[2];
if (argument === "--check") {
  const problems = [];
  const versions = new Set(VERSIONED.map((file) => read(file).version));
  if (versions.size !== 1) problems.push(`versions differ: ${VERSIONED.map((file) => `${file}=${read(file).version}`).join(", ")}`);
  for (const host of ["codex", "claude"]) {
    if (!serverArgs(host).some((item) => String(item).endsWith("dist/index.js"))) problems.push(`${host} manifest does not launch dist/index.js`);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`manifests agree: ${[...versions][0]}`);
} else {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace(/[-:T]/g, "");
  const version = argument ?? `0.1.0-dev.${stamp}`;
  for (const file of VERSIONED) {
    const manifest = read(file);
    manifest.version = version;
    write(file, manifest);
  }
  console.log(`version ${version} written to ${VERSIONED.join(", ")}`);
}
