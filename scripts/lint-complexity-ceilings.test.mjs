import assert from "node:assert/strict";

import { Linter } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

import lintConfig, { complexityCeilings } from "../eslint.config.js";

const configuredRules = lintConfig.find(
  (config) =>
    config.rules?.complexity &&
    config.rules["sonarjs/cognitive-complexity"],
)?.rules;

assert.deepEqual(configuredRules?.complexity, [
  "error",
  complexityCeilings.cyclomatic,
]);
assert.deepEqual(configuredRules?.["sonarjs/cognitive-complexity"], [
  "error",
  complexityCeilings.cognitive,
]);

function functionWithBranches(branches) {
  const conditions = Array.from(
    { length: branches },
    (_, index) => `  if (values[${index}]) result += ${index};`,
  ).join("\n");

  return `function measured(values: boolean[]): number {
  let result = 0;
${conditions}
  return result;
}`;
}

function verify(rule, ceiling, branches) {
  const linter = new Linter();
  return linter.verify(
    functionWithBranches(branches),
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: tseslint.parser },
        plugins: { sonarjs },
        rules: { [rule]: ["error", ceiling] },
      },
    ],
    { filename: "complexity-boundary.ts" },
  );
}

const cases = [
  {
    rule: "complexity",
    ceiling: complexityCeilings.cyclomatic,
    acceptedBranches: complexityCeilings.cyclomatic - 1,
    rejectedBranches: complexityCeilings.cyclomatic,
  },
  {
    rule: "sonarjs/cognitive-complexity",
    ceiling: complexityCeilings.cognitive,
    acceptedBranches: complexityCeilings.cognitive,
    rejectedBranches: complexityCeilings.cognitive + 1,
  },
];

for (const testCase of cases) {
  assert.deepEqual(
    verify(testCase.rule, testCase.ceiling, testCase.acceptedBranches),
    [],
    `${testCase.rule} must accept its configured ceiling`,
  );

  const rejected = verify(
    testCase.rule,
    testCase.ceiling,
    testCase.rejectedBranches,
  );
  assert.equal(rejected.length, 1, `${testCase.rule} must reject above its ceiling`);
  assert.equal(rejected[0]?.ruleId, testCase.rule);
  assert.equal(rejected[0]?.severity, 2);
  assert.match(rejected[0]?.message ?? "", new RegExp(`${testCase.ceiling + 1}`));
}

console.log("lint complexity ceilings verified");
