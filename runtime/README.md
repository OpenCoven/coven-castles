# Runtime manifest

`manifest.json` pins the runtime a #3 run expects on the bound sandbox. Bootstrap is **snapshot verification only** ([OpenCoven/coven-agents#300](https://github.com/OpenCoven/coven-agents/issues/300)). Castles installs, resets and starts nothing. The runtime is whatever the pinned upstream snapshot is built from.

- **Pins.** Every pin is upstream source policy at `OpenCoven/coven-agents@0696af127207fb82cce734cd8c4ffa437d6f3502`:
  - the snapshot name;
  - the harness package and version;
  - the adapter, capability-contract and credential-boundary versions;
  - the server-selected SDK version.
- **Measured fact.** Only the observed snapshot name is measured, and it comes from provider metadata that the owner reads. **Nothing is measured inside the guest**, so a compatible result does not show which harness binary is installed.
- **Contract hashes.** `contracts` records the SHA-256 of the two upstream contract files at that revision: the sandbox-inspection schema and the run contract. The owner does not report these hashes at run time. They pin the contract that Castles was written against.

`verifyRuntime` in `src/run.ts` compares a server-owned report with this manifest:

| Report | Result |
| --- | --- |
| Not v1's exact shape | `unreadable` |
| A pin differs | `incompatible`, naming each field that differs |
| Every pin matches | `compatible` |

The comparison is pure: the same report always gives the same result. `tests/run.test.ts` holds `manifest.json` to `RUNTIME_MANIFEST` and to `RUNTIME_MANIFEST_SHA256`, so any change to the file must also update the pinned digest.

This directory is owned by issue #3.
