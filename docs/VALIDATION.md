# Validation

Checked on 2026-10-07 using an isolated source copy, existing local dependencies and synthetic fixtures. No real meeting data, recording, paid model request or fresh dependency installation was used.

| Check | Result | Scope |
| --- | --- | --- |
| Frontend production build | PASS | Vite 8.3.0; 1,877 modules transformed |
| Swift release build | PASS | Swift 6.3.2; no external Swift dependencies |
| JavaScript/native integration suite | PASS | Node 23.9.0; 45 tests passed, zero failures or skips |
| Native recovery | PASS within the 45-test suite | Seven synthetic helper self-checks; no microphone/system recording needed |
| Provider regression suite after schema notices | PASS | 11 tests, including schema version/checksum checks; no validating schema constraints changed |
| Electron UI smoke | FAILED AT LAUNCH | No fresh screenshot or successful interaction evidence |
| Local-model workflow | BLOCKED AT SETUP | Local endpoint access denied in the execution environment; no model-stage acceptance claimed |
| Fresh install, packaging and real calls | NOT RUN | Clean-machine, endurance, sleep/device and output-quality acceptance remains open |

## Reproduce the checks

After reviewing and installing the documented dependencies:

```sh
npm run native:build
npm test
npm run build
npm run test:ui
# Requires running, already provisioned local models:
npm run test:workflow
```

The tests use temporary synthetic vaults and mocked inference. Build the native helper first: its recovery test skips when the helper is absent. The UI harness uses an isolated temporary Electron profile. A successful synthetic suite is not proof of live-call reliability.

For the recorded frontend check, `vite build --configLoader native` avoided writing a configuration cache through a read-only dependency link. Swift used a separate build cache and completed despite warnings about unavailable user-level caches. No dependency update was performed.

## UI and local inference limits

Electron failed at launch. Diagnostic output reported process-control `EPERM`; independent loopback bind and connection checks were also denied with `EPERM`. These observations do not identify a rendering defect or establish missing Screen Recording, Accessibility or Microphone permissions. Local model files were present, so the workflow's unavailable-model message should not be read as proof that weights are missing.

No permission changes or alternative execution bypass were attempted. UI interactions, screenshot review and actual local inference still need validation in a suitable ordinary desktop session. No screenshot is included as evidence of a passed test.

## Source and schema checks

Local heuristic scans and source review identified no credential-pattern matches in the proposed source release. The three endpoint matches were intentional local Ollama/test URLs. This check is not a complete security audit; generated reports, recordings and private vault contents must stay outside source control.

The six third-party schemas were compared with the pinned public Codex release. Five matched byte-for-byte; the initialization schema matched its documented extraction. The later notice/comment change preserved all validation constraints and passed the provider regression suite. The broader 45-test suite and builds preceded that non-validating comment and documentation update. See [schema provenance](../server/providers/protocol/README.md).
