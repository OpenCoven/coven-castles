/**
 * castles check [--json] [--fixture <case.json>]
 *
 * One read-only command. It reads the CASTLES_* binding from the environment
 * (or, with --fixture, entirely from one synthetic case file), never looks
 * up a provider or harness credential, and writes only to stdout and stderr.
 *
 * Exit codes: 0 ready from a live provider read, 1 any other status, 2 usage
 * error, 3 a fixture replay that reported ready. A fixture never exits 0, so
 * a caller gating on the exit code cannot mistake synthetic input for
 * readiness. No live client exists yet, so 0 is currently unreachable.
 */
import process from "node:process";
import { parseArgs } from "node:util";
import {
  createFixtureInspectionClient,
  isLiveReady,
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

exit codes: 0 ready (live provider read only), 1 not ready, 2 usage error,
            3 fixture replay reported ready (synthetic; never readiness)
`;

const EXIT_FIXTURE_READY = 3;

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

function bindingEnvironment(): Record<string, string | undefined> {
  try {
    // Optional operator convenience; existing variables take precedence. The
    // file is resolved from the current working directory, so the binding
    // follows where the command is run (`pnpm check` runs at the package
    // root). `loadEnvFile` loads EVERY key of that file into this process's
    // environment; only the four binding keys below are consumed.
    process.loadEnvFile(".env.local");
  } catch {
    // No local file is the normal case.
  }
  // Only the binding keys are consumed. Any other variable, whether exported
  // or loaded from the file, including a provider or harness credential, is
  // present in the process environment but is never looked up, copied, or
  // forwarded.
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
    result = await runPreflight(bindingEnvironment(), null);
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
      createFixtureInspectionClient(fixture)
    );
  }

  process.stdout.write(
    parsed.values.json ? renderJson(result) : renderHuman(result)
  );
  if (isLiveReady(result)) {
    process.exitCode = 0;
  } else if (result.status === "ready") {
    process.exitCode = EXIT_FIXTURE_READY;
  } else {
    process.exitCode = 1;
  }
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
