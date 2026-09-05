/**
 * The one place built-in harness adapters are registered. Adding a worker means
 * implementing HarnessAdapter here and adding its BRIDGE_<ID>_PATH/_MODEL to the Codex host's env allow-list in .codex-plugin/mcp.json.
 */
import type { BridgeConfig } from "../core/types.js";
import type { HarnessAdapter } from "./adapter.js";
import { AntigravityAdapter } from "./antigravity.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";

export function createBuiltInAdapters(config: BridgeConfig): HarnessAdapter[] {
  return [
    new AntigravityAdapter(config.harnesses.antigravity ?? {}),
    new ClaudeCodeAdapter(config.harnesses["claude-code"] ?? {}),
    new CodexAdapter(config.harnesses.codex ?? {}),
  ];
}
