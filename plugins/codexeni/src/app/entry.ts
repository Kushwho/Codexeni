#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequestStateCodec } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createBuiltInAdapters } from "../adapters/index.js";
import { LIMITS } from "../core/limits.js";
import { resolveBridgeConfig } from "../platform/config.js";
import { NonceLedger, type SealedInputState } from "./input-state.js";
import { createMcpServer } from "./mcp-server.js";
import { BridgeRuntime } from "../runtime/bridge-runtime.js";

export async function runStdioServer(): Promise<void> {
  const config = resolveBridgeConfig();
  const runtime = new BridgeRuntime({ config });
  for (const adapter of createBuiltInAdapters(config)) runtime.registerAdapter(adapter);
  // Built once, outside the factory: serveStdio may pin a fresh McpServer per era, but every
  // round of a delegate_respond elicitation must land on the same runtime, codec key, and nonces.
  const codec = createRequestStateCodec<SealedInputState>({
    key: randomBytes(32),
    ttlSeconds: LIMITS.inputRequestStateTtlSeconds,
    bind: (ctx) => ctx.mcpReq.method,
  });
  const nonces = new NonceLedger(LIMITS.inputRequestStateTtlSeconds * 1_000);
  serveStdio(() => createMcpServer(runtime, { codec, nonces }));
}

// Start only when this bundle is the program being run, not when it is imported (as the tests do).
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  void runStdioServer();
}
