/** Refusal-only operator entrypoint. No live implementation or provider capability. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BINDING_ENVIRONMENT_KEYS, parseBinding } from "../src/profile.ts";

type RefusalReason = "unsupported_arguments" | "explicit_opt_in_required" |
  "budget_required" | "budget_invalid" | "binding_invalid" |
  "exact_target_required" | "target_mismatch" | "canonical_capabilities_unavailable";

export type SmokeRefusal = Readonly<{
  schema: "castles.smoke-refusal.v1";
  status: "blocked";
  evidence: "none";
  reason: RefusalReason;
  providerCalls: 0;
}>;

/** Input validation grants no authority. Even apparently complete input refuses. */
export function smokeRefusal(
  args: string[], environment: Readonly<Record<string, string | undefined>>,
): SmokeRefusal {
  const refuse = (reason: RefusalReason): SmokeRefusal => ({
    schema: "castles.smoke-refusal.v1", status: "blocked", evidence: "none",
    reason, providerCalls: 0,
  });
  let values;
  try {
    const parsed = parseArgs({args, strict: true, allowPositionals: false, options: {
      live: {type: "boolean"}, "sandbox-id": {type: "string"},
      "max-spend-usd": {type: "string"}, "max-seconds": {type: "string"},
    }});
    // Duplicate options are ambiguous operator intent, not last-value-wins.
    for (const name of Object.keys(parsed.values))
      if (args.filter(arg => arg === `--${name}` || arg.startsWith(`--${name}=`)).length !== 1)
        return refuse("unsupported_arguments");
    values = parsed.values;
  } catch {
    return refuse("unsupported_arguments");
  }
  if (values.live !== true) return refuse("explicit_opt_in_required");
  const dollars = values["max-spend-usd"];
  const seconds = values["max-seconds"];
  if (dollars === undefined || seconds === undefined) return refuse("budget_required");
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(dollars) || Number(dollars) <= 0 ||
      !/^[1-9]\d{0,2}$/.test(seconds) || Number(seconds) > 900)
    return refuse("budget_invalid");
  const parsed = parseBinding(environment);
  if (!parsed.ok) return refuse("binding_invalid");
  const target = values["sandbox-id"];
  if (!target) return refuse("exact_target_required");
  if (target !== parsed.binding.sandboxId) return refuse("target_mismatch");
  // #296 inspection, #3 admission and #4 recovery are unavailable. No endpoint,
  // token format, provider client, credential lookup or fixture fallback exists.
  return refuse("canonical_capabilities_unavailable");
}

/**
 * Prefer Node's main metadata. Older supported Node versions resolve the
 * supplied entry as a module URL, including symlinks and tsx's implicit .ts
 * extension. A module import has a different entry, or no entry under eval.
 * No provider lookup, directory scan or env-file read is involved.
 */
export function runsAsProgram(main: unknown): boolean {
  if (main !== undefined) return main !== false;
  const argument = process.argv[1];
  if (!argument) return false;
  const entry = pathToFileURL(resolve(argument)).href;
  return [entry, `${entry}.ts`].some(candidate => {
    try { return import.meta.resolve(candidate) === import.meta.url; }
    catch { return false; }
  });
}

if (runsAsProgram((import.meta as { main?: unknown }).main)) {
  const environment: Record<string, string | undefined> = {};
  for (const key of BINDING_ENVIRONMENT_KEYS) environment[key] = process.env[key];
  process.stdout.write(`${JSON.stringify(smokeRefusal(process.argv.slice(2), environment))}\n`);
  process.exitCode = 1;
}
