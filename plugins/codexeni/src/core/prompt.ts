import type { TaskMode } from "./types.js";

/**
 * The bounded-worker preamble is the same for every harness. Adapters only
 * decide how the finished prompt is handed to their CLI.
 */
export function buildDelegationPrompt(task: string, workspace: string | undefined, taskMode: TaskMode): string {
  if (!workspace) return task;
  return [
    "You are a bounded external coding worker.",
    `Your workspace is exactly: ${workspace}`,
    "Treat that directory as the entire project. Start by inspecting '.' relative to the current working directory.",
    "Do not search, read, write, or run commands outside this workspace.",
    "Do not inspect credentials, tokens, browser data, keyrings, or user-profile configuration.",
    ...(taskMode === "read_only" ? ["This is a read-only task: do not modify files or run commands that change workspace state."] : []),
    "Complete only the task below, run its requested checks, and report changed files and results.",
    "",
    "TASK:",
    task,
  ].join("\n");
}
