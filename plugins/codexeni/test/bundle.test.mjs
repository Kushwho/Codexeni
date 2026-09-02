import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Every other test drives the runtime in-process through a fake spawn. This one launches
// the shipped bundle as a real child process over stdio, so a broken bundle or missing export fails here rather than on a user's first session.
const bundle = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

test("the shipped bundle starts over stdio and serves the delegate tools", async (t) => {
  const client = new Client({ name: "bundle-test", version: "1.0.0" }, { capabilities: { elicitation: {} } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    // Pin the workspace policy so the assertions below do not depend on the
    // developer's own environment leaking BRIDGE_* variables into the child.
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
  });
  await client.connect(transport);
  t.after(async () => { await client.close(); });

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["delegate_cancel", "delegate_discover", "delegate_start", "delegate_status", "delegate_respond"].sort(),
  );

  const discovered = JSON.parse((await client.callTool({ name: "delegate_discover", arguments: {} })).content[0].text);
  // Full is the default; a bundle that shipped the old default would fail here.
  assert.equal(discovered.permissionMode, "full");
  assert.equal(discovered.humanInput.toolName, "delegate_respond");
  assert.deepEqual(discovered.humanInput.modes, ["mrtr", "legacy_elicitation_shim", "external"]);
  assert.equal(discovered.limits.maxInputRounds, 3);
  assert.ok(!("sampling" in discovered) && !("roots" in discovered));
  // Install and login state depend on the machine, so only the shape is asserted.
  for (const harness of Object.values(discovered.harnesses)) {
    assert.equal(typeof harness.installed, "boolean");
    assert.equal(typeof harness.supportsContinuation, "boolean");
  }

  // Bad input must come back as a clean tool error, not a crashed server: a malformed id is
  // rejected by the schema before the handler; a well-formed but unknown one comes back as the bridge's own JSON error.
  const malformed = await client.callTool({ name: "delegate_status", arguments: { jobId: "not-a-uuid" } });
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0].text, /Invalid UUID/);

  const unknown = await client.callTool({ name: "delegate_status", arguments: { jobId: "f47ac10b-58cc-4372-a567-0e02b2c3d479" } });
  assert.equal(unknown.isError, true);
  assert.match(JSON.parse(unknown.content[0].text).error, /Unknown job ID/);
});
