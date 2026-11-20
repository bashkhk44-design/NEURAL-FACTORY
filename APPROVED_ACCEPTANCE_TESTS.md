# Approved Acceptance Test Execution

BOSS BOT MASTER treats the approved AI Designer acceptance tests as executable release gates.

## Generated contract

Every \`acceptanceTest\` in the approved design must have exactly one \`testCases\` entry in \`boss-design-map.json\`:

\`\`\`json
{
  "designType": "acceptanceTest",
  "designId": "customer_can_submit_order",
  "requirementRefs": ["SPEC_FEATURES"],
  "filePaths": ["src/orders.js", "test/acceptance.test.js"],
  "testCases": [
    {
      "filePath": "test/acceptance.test.js",
      "testName": "[BOSS_ACCEPTANCE:customer_can_submit_order] customer can submit an order"
    }
  ]
}
\`\`\`

The test file must use Node's \`node:test\` API and register a test with the exact name recorded in the map. The test should exercise the behavior described by the approved scenario and expected result. The map must also bind the acceptance criterion to its implementation file.

## Execution gate

- AI TESTER validates the map against the exact approved design fingerprint.
- The isolated runner executes \`node --test --test-reporter=tap\`.
- It requires a non-empty TAP summary with every test passing.
- It requires each approved acceptance test marker and exact test name to appear once as a passing TAP result.
- Missing, skipped, duplicated, failed, or unreported acceptance tests fail the gate.
- When sandbox execution is disabled or no test files are present, the project is not marked as passed and deployment preparation is blocked.
- AI FIXER only spends repair attempts after an actual sandbox run has executed and exposed failures.

## Security and limits

The runner retains the existing pinned-image Docker sandbox, no network, read-only mounts, bounded resources, non-root UID, dropped capabilities, and no application secrets in the container environment. Dependency packages must come from the verified offline artifact path.

A passing test demonstrates that the generated test case executed and passed. It does not prove that its assertions are semantically complete, that every business edge case was covered, or that the project is production-ready. Human review and explicit release approval remain necessary.


## Execution state and safe repair

The sandbox reports execution state separately from the test outcome:

- \`executionStatus: completed\` means a structurally valid TAP summary was received.
- \`executionStatus: not_confirmed\` means the sandbox did not produce a valid completed test report; this includes startup, image, dependency preparation, timeout, and malformed-report failures.
- \`repairable: true\` is set only for a completed run whose test cases, skip/todo/cancelled state, or approved acceptance coverage failed.
- A completed run that exits abnormally without a repairable test failure is not sent to AI FIXER.

AI FIXER is invoked only when both \`executionStatus === "completed"\` and \`repairable === true\`. If a later repair attempt cannot be tested because sandbox execution is no longer confirmed, the repair loop stops immediately and the pipeline does not mark the project ready or proceed to deployment preparation.
