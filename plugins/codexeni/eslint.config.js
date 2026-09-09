/**
 * Flat ESLint config: size/complexity gates plus per-directory layer rules that keep
 * src/core at the bottom of the dependency graph and src/app at the top.
 */
import eslint from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

/**
 * Complexity gate. 12 flagged 18 pre-existing functions; even 15 (the Saisse article's
 * number, adopted here) still flags 13 — mostly the stream/interpret parsers in the
 * adapters and runtime. Rather than refactoring those in this phase, the existing
 * offenders carry inline `eslint-disable-next-line` waivers; they self-clean because
 * reportUnusedDisableDirectives is an error, so a waiver fails lint as soon as the code
 * under it is simplified. Don't add new waivers — refactor instead.
 */
const COMPLEXITY_MAX = 15;

/** No-restricted-imports patterns forbidding parent imports outside the allowed layer dirs. */
function layerRestriction(allowedDirs) {
  return [
    "error",
    {
      patterns: [
        {
          // Match `../` escape attempts, exempting the allowed layer dirs (each followed
          // by a path separator or the end of the specifier).
          regex: allowedDirs
            ? `^\\.\\.(?!/(?:${allowedDirs})(?:/|$))`
            : "^\\.\\.",
          message: "Cross-layer import violates the codexeni layering: core ← adapters/platform ← runtime ← app.",
        },
      ],
    },
  ];
}

export default tseslint.config(
  {
    ignores: ["dist/**"],
    // Keeps the pre-existing waivers honest: once refactored, the stale directive errors.
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    rules: {
      complexity: ["error", COMPLEXITY_MAX],
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  // Layer rules: relative imports may not escape the listed directories. `app/` (and the
  // root index.ts) may import anything, so they need no override.
  {
    files: ["src/core/**/*.ts"],
    rules: { "no-restricted-imports": layerRestriction(null) },
  },
  {
    files: ["src/adapters/**/*.ts"],
    rules: { "no-restricted-imports": layerRestriction("core") },
  },
  {
    // platform may import core, plus the one existing type-only import of the adapter
    // interface (platform/process.ts needs CommandResult to type spawn results).
    files: ["src/platform/**/*.ts"],
    rules: { "no-restricted-imports": layerRestriction("core|adapters/adapter\\.js") },
  },
  {
    files: ["src/runtime/**/*.ts"],
    rules: { "no-restricted-imports": layerRestriction("core|platform|adapters") },
  },
);
