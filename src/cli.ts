/**
 * castles check [--json] [--fixture <case.json>]
 *
 * One read-only command. It reads the CASTLES_* binding from the environment
 * (or, with --fixture, entirely from one synthetic case file), never reads a
 * provider or harness credential, and writes nothing but its own stdout.
 *
 * Exit codes: 0 ready, 1 any other status, 2 usage error.
 */
import process from "node:process";
import { parseArgs } from "node:util";
import {
  createFixtureInspectionClient,
  loadFixtureCase,
  type PreflightResult,
  renderHuman,
  renderJson,
  runPreflight,
} from "./preflight";
import { BINDING_ENVIRONMENT_KEYS } from "./profile";

const USAGE = `usage: castles check [--json] [--fixture <case.json>]

  check       read-only preflight of the one configured sandbox
  --json      machine-readable output (schema castles.preflight.v1)
  --fixture   replay one synthetic case from fixtures/preflight/cases/
`;

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

function bindingEnvironment(): Record<string, string | undefined> {
  try {
    // Optional operator convenience; existing variables take precedence.
    process.loadEnvFile(".env.local");
  } catch {
    // No local file is the normal case.
  }
  // Only the binding keys are ever read. Provider and harness credentials in
  // the ambient environment are not looked at, copied, or forwarded.
  const environment: Record<string, string | undefined> = {};
  for (const key of BINDING_ENVIRONMENT_KEYS) {
    environment[key] = process.env[key];
  }
  return environment;
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments();
  } catch {
    usage();
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "check") {
    usage();
  }

  let result: PreflightResult;
  if (parsed.values.fixture === undefined) {
    // No live client exists: the upstream read-only seam is not available.
    result = await runPreflight(bindingEnvironment(), null, {
      evidence: "none",
    });
  } else {
    let fixture: ReturnType<typeof loadFixtureCase>;
    try {
      fixture = loadFixtureCase(parsed.values.fixture);
    } catch {
      process.stderr.write("castles: not a readable synthetic fixture case\n");
      process.exit(2);
    }
    result = await runPreflight(
      fixture.env,
      createFixtureInspectionClient(fixture),
      { evidence: "fixture" }
    );
  }

  process.stdout.write(
    parsed.values.json ? renderJson(result) : renderHuman(result)
  );
  process.exitCode = result.status === "ready" ? 0 : 1;
}

function parseArguments() {
  return parseArgs({
    allowPositionals: true,
    options: {
      fixture: { type: "string" },
      json: { default: false, type: "boolean" },
    },
    strict: true,
  });
}

await main();
