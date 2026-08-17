import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

// These independent ceilings match the highest values observed before this gate.
// scripts/lint-complexity-ceilings.test.mjs guards both boundaries.
export const complexityCeilings = {
  cognitive: 32,
  cyclomatic: 17,
};

const sourceFiles = [
  "apps/web/**/*.{ts,tsx}",
  "apps/server/**/*.ts",
  "packages/core/**/*.ts",
];

export default tseslint.config(
  {
    files: sourceFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      sonarjs,
    },
    rules: {
      complexity: ["error", complexityCeilings.cyclomatic],
      "sonarjs/cognitive-complexity": [
        "error",
        complexityCeilings.cognitive,
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-for-in-array": "error",
      "@typescript-eslint/no-implied-eval": "error",
      // React event attributes remain outside this first ratchet; all other
      // void-return positions are checked.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/no-misused-spread": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: [
      "apps/server/**/*.ts",
      "packages/core/**/*.test.ts",
      "apps/web/vite.config.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "apps/web/src/test/**/*.ts"],
    languageOptions: {
      globals: globals.vitest,
    },
  },
  {
    files: ["apps/web/src/**/*.tsx"],
    ...react.configs.flat.recommended,
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat["jsx-runtime"].rules,
      "react/prop-types": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
    plugins: {
      ...react.configs.flat.recommended.plugins,
      ...reactHooks.configs.flat.recommended.plugins,
    },
  },
);
