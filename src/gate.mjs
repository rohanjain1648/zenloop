// Claude Code Stop hook.
//
// Claude Code pipes a JSON payload on stdin ({session_id, cwd, stop_hook_active, ...}).
// We answer on stdout:
//   {"decision":"block","reason":"..."}  -> Claude keeps working, reading `reason`
//   {"systemMessage":"..."}               -> Claude may stop; message shown to the human
// Any internal failure exits 0 so ZenLoop can never trap a session.

import { findRoot, loadConfig } from "./workspace.mjs";
import { verify, formatFeedback, formatPass } from "./engine.mjs";

async function readStdin() {
  if (process.stdin.isTTY) return {};
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    // Windows shells may prepend a BOM when piping.
    return JSON.parse(data.replace(/^﻿/, "").trim() || "{}");
  } catch {
    return {};
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

export async function gate() {
  const input = await readStdin();
  if (process.env.ZENLOOP_DISABLE === "1") return;

  const root = findRoot(input.cwd || process.cwd());
  if (!root) return; // project not opted in

  let cfg;
  try {
    cfg = loadConfig(root);
  } catch (e) {
    emit({ systemMessage: `ZenLoop: could not read zenloop.config.json (${e.message}); skipping verification.` });
    return;
  }

  const session = input.session_id || "hook";
  const log = (m) => process.stderr.write(`[zenloop] ${m}\n`);

  let out;
  try {
    out = await verify(root, cfg, { session, log });
  } catch (e) {
    emit({ systemMessage: `ZenLoop: verification crashed (${e.message}); not blocking.` });
    return;
  }

  if (out.skipped) {
    if (out.skipped !== "no changes since last green run") emit({ systemMessage: `ZenLoop: skipped (${out.skipped}).` });
    return;
  }

  const failed = out.results.filter((r) => r.status !== "passed");
  if (!failed.length) {
    emit({ systemMessage: formatPass(out, cfg.specs) });
    return;
  }

  // Infra problems (not logged in, server down) are not the agent's bug: tell it once, don't loop.
  const infraOnly = failed.every((r) => r.status === "error");
  const max = cfg.maxAttempts ?? 3;

  if (out.attempt > max) {
    emit({
      systemMessage: `ZenLoop: still failing after ${max} attempts — handing back to you. Failing: ${failed
        .map((r) => r.name)
        .join("; ")}. Run \`zenloop report\` to see every attempt.`,
    });
    return;
  }

  if (infraOnly && input.stop_hook_active) {
    emit({ systemMessage: `ZenLoop: Kane could not run (${failed[0].reason}). Not blocking.` });
    return;
  }

  emit({
    decision: "block",
    reason: formatFeedback({ results: out.results, attempt: out.attempt, maxAttempts: max, changed: out.changed, tampered: out.tampered }),
  });
}
