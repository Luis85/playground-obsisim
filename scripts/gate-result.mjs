// Shared by the ratchet gates (check-loc.mjs, check-css-important.mjs): both
// end with the same "print failures and exit 1, else print ok" shape. Pulled
// out once fallow's clone detector flagged the duplicate — see
// docs/build-ci/quality-gates.md's ratchet section.
export function reportGateResult(gateName, failures, okMessage) {
  if (failures.length) {
    console.error(`${gateName} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(okMessage);
}
