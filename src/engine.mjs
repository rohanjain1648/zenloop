// The verify engine shared by `zenloop run` (human) and `zenloop gate` (agent hook).

import path from "node:path";
import { spawn } from "node:child_process";
import { loadSpecs, selectSpecs, matchesAny } from "./specs.mjs";
import { runSpec } from "./kane.mjs";
import {
  changedFiles,
  fingerprint,
  diffStat,
  isReachable,
  readState,
  writeState,
  appendRun,
  isGitRepo,
} from "./workspace.mjs";

const INFRA_PATTERNS =
  /TargetClosedError|browser (has been )?closed|Target page, context or browser|Connection closed while reading|reading from the driver|ECONNRESET|CDP .*timed? ?out|Chrome .*(crash|failed to launch)|Screenshot failed/i;

/** A failure caused by the browser/tooling rather than by the app under test. */
export function isInfraFlake(r) {
  if (r.status === "passed") return false;
  // Kane exited without ever producing a verdict: tooling problem, not an app bug.
  if (r.status === "error") return true;
  const text = [r.reason, r.summary, ...(r.errors || [])].filter(Boolean).join(" ");
  return INFRA_PATTERNS.test(text);
}

async function ensureServer(root, cfg, log) {
  if (await isReachable(cfg.baseUrl)) return { ok: true };
  const ds = cfg.devServer;
  if (!ds?.command) {
    return { ok: false, reason: `App is not reachable at ${cfg.baseUrl}. Start the dev server (or set "devServer.command" in zenloop.config.json).` };
  }
  log(`starting dev server: ${ds.command}`);
  const child = spawn(ds.command, {
    cwd: path.resolve(root, ds.cwd || "."),
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + (ds.readyTimeout ?? 90) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await isReachable(cfg.baseUrl)) return { ok: true, started: true };
  }
  return { ok: false, reason: `Started "${ds.command}" but ${cfg.baseUrl} never became reachable.` };
}

/**
 * Verify the current working tree.
 * @returns {Promise<{skipped?:string, results:Array, selected:Array, changed:string[], fp:string, record:object}>}
 */
export async function verify(root, cfg, { session = "manual", only = null, force = false, log = () => {}, onEvent } = {}) {
  const git = isGitRepo(root);
  const changed = git ? changedFiles(root).filter((f) => !matchesAny(f, cfg.ignore)) : [];
  const fp = git ? fingerprint(root, changed, cfg.ignore, matchesAny) : String(Date.now());
  const state = readState(root);

  if (!force && cfg.trigger === "changes" && git && state.lastGreen === fp && !(state.failing || []).length) {
    return { skipped: "no changes since last green run", results: [], selected: [], changed, fp };
  }

  const specs = loadSpecs(root, cfg.specs);
  if (!specs.length) return { skipped: `no specs found in ${cfg.specs}/ (*.kane.md)`, results: [], selected: [], changed, fp };

  let selected = only
    ? specs.filter((s) => only.includes(s.id))
    : force || !git
      ? specs
      : selectSpecs(specs, changed, state.failing || []);
  if (!selected.length) {
    return { skipped: "no spec watches the changed files", results: [], selected, changed, fp };
  }

  // Spec integrity: a spec that was failing must not be edited to make it pass.
  const tampered = (state.failing || []).filter((id) => {
    const s = specs.find((x) => x.id === id);
    return s && state.specHashes?.[id] && state.specHashes[id] !== s.hash;
  });

  const server = await ensureServer(root, cfg, log);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const results = [];

  if (!server.ok) {
    for (const s of selected) {
      results.push({ spec: s.id, name: s.name, file: s.file, severity: s.severity, status: "error", reason: server.reason, steps: [], credits: 0 });
    }
  } else {
    // Bounded parallelism: each Kane run drives its own Chrome.
    const limit = Math.max(1, Math.min(Number(cfg.parallel) || 1, selected.length));
    const slots = new Array(selected.length);
    let next = 0;
    const worker = async () => {
      while (next < selected.length) {
        const i = next++;
        const s = selected[i];
        log(`kane ▸ ${s.name}`);
        const logFile = path.join(root, ".zenloop", "runs", runId, `${s.id}.ndjson`);
        let r = await runSpec(s, cfg.baseUrl, cfg.kane, { logFile, onEvent });
        if (isInfraFlake(r)) {
          // Browser/infra hiccup is not the agent's bug: retry once before reporting.
          log(`kane ↻ ${s.name}: infrastructure flake (${String(r.reason || r.summary).slice(0, 80)}), retrying once`);
          const retry = await runSpec(s, cfg.baseUrl, cfg.kane, { logFile: logFile.replace(/\.ndjson$/, ".retry.ndjson"), onEvent });
          r = { ...retry, retried: true };
          if (isInfraFlake(r)) r = { ...r, status: "error" };
        }
        slots[i] = { spec: s.id, name: s.name, file: s.file, severity: s.severity, objective: s.objective, ...r };
        log(`kane ◂ ${s.name}: ${r.status}${r.oneLiner ? " — " + r.oneLiner : ""}`);
      }
    };
    await Promise.all(Array.from({ length: limit }, worker));
    results.push(...slots);
  }

  const failing = results.filter((r) => r.status !== "passed").map((r) => r.spec);
  const sess = (state.sessions[session] ||= { attempts: 0, started: new Date().toISOString() });
  sess.attempts += 1;

  const record = {
    runId,
    ts: new Date().toISOString(),
    session,
    attempt: sess.attempts,
    fingerprint: fp,
    changed,
    diffStat: git ? diffStat(root) : "",
    tampered,
    passed: failing.length === 0,
    credits: results.reduce((a, r) => a + (r.credits || 0), 0),
    results: results.map(({ objective, steps, ...rest }) => ({ ...rest, steps: (steps || []).slice(-12) })),
  };
  appendRun(root, record);

  // Remember spec hashes while a spec is failing, so edits to it are detectable.
  state.specHashes ||= {};
  for (const s of specs) {
    if (failing.includes(s.id) && !state.specHashes[s.id]) state.specHashes[s.id] = s.hash;
    if (!failing.includes(s.id)) delete state.specHashes[s.id];
  }
  const prevFailing = new Set(state.failing || []);
  for (const r of results) prevFailing.delete(r.spec);
  state.failing = [...prevFailing, ...failing];
  if (state.failing.length === 0) {
    state.lastGreen = fp;
    sess.attempts = 0;
  }
  writeState(root, state);

  return { results, selected, changed, fp, record, tampered, attempt: record.attempt };
}

/** The message Claude reads when the Stop hook blocks. Pure; unit-tested. */
export function formatFeedback({ results, attempt, maxAttempts, changed, tampered = [] }) {
  const failed = results.filter((r) => r.status === "failed" || r.status === "timeout");
  const errored = results.filter((r) => r.status === "error");
  const lines = [];
  lines.push(
    `ZenLoop ✗ Kane CLI checked your change in a real browser: ${failed.length} of ${results.length} spec(s) did not pass (attempt ${attempt}/${maxAttempts}).`,
  );
  lines.push("You are not done yet. Fix the application code so these behaviours hold, then finish again; ZenLoop re-verifies automatically.");
  lines.push("");
  for (const r of failed) {
    lines.push(`✗ [${r.severity}] ${r.name}  (${r.file})`);
    if (r.objective) lines.push(`  What must be true: ${r.objective.replace(/\s+/g, " ").slice(0, 600)}`);
    lines.push(`  Kane verdict: ${r.status}${r.reason ? " — " + r.reason : ""}`);
    if (r.lastFailedStep) lines.push(`  Failed at step: ${r.lastFailedStep}`);
    for (const fc of r.failedConditions || []) {
      lines.push(`  ✗ Assertion failed: ${fc.condition}${fc.observed !== null ? ` (observed: ${fc.observed})` : ""}`);
    }
    if (r.summary && r.summary !== r.reason) lines.push(`  Summary: ${String(r.summary).slice(0, 500)}`);
    if (r.url) lines.push(`  Page: ${r.url}`);
    if (r.testUrl) lines.push(`  Evidence: ${r.testUrl}`);
    lines.push("");
  }
  const passed = results.filter((r) => r.status === "passed");
  if (passed.length) lines.push(`✓ still passing: ${passed.map((r) => r.name).join("; ")}`);
  if (errored.length) lines.push(`… Kane could not verify (tooling issue, not your bug — ignore): ${errored.map((r) => r.name).join("; ")}`);
  if (changed?.length) lines.push(`Files changed vs HEAD: ${changed.slice(0, 15).join(", ")}${changed.length > 15 ? " …" : ""}`);
  if (tampered.length) {
    lines.push("");
    lines.push(`⚠ Spec file(s) changed while failing: ${tampered.join(", ")}. Do not weaken specs to make them pass; fix the app. Revert spec edits unless the human asked for them.`);
  }
  lines.push("Rules: do not edit files under the specs directory to make a check pass, and do not disable ZenLoop.");
  return lines.join("\n");
}

export function formatPass({ results, record, changed = [] }, specDir = "kane") {
  const credits = record?.credits ? ` · ${record.credits.toFixed(1)} credits` : "";
  const editedSpecs = changed.filter((f) => f.startsWith(specDir.replace(/\/$/, "") + "/") && f.endsWith(".kane.md"));
  const note = editedSpecs.length ? `\n⚠ The agent changed spec file(s) in this task: ${editedSpecs.join(", ")} — review the diff before merging.` : "";
  return `ZenLoop ✓ Kane CLI verified ${results.length} spec(s) in a real browser${credits}: ${results.map((r) => r.name).join("; ")}${note}`;
}
