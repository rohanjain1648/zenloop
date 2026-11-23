// Thin, dependency-free wrapper around `kane-cli run ... --agent`.
// Kane streams NDJSON on stdout; the last line of a started run is `run_end`.

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let cachedCommand = null;

/**
 * Resolve how to launch kane-cli without a shell, so long plain-English
 * objectives (quotes, newlines) are passed through untouched on every OS.
 */
export function resolveKane() {
  if (cachedCommand) return cachedCommand;
  const override = process.env.ZENLOOP_KANE_BIN;
  if (override) {
    cachedCommand = override.endsWith("js") || override.endsWith(".cjs")
      ? { cmd: process.execPath, pre: [override] }
      : { cmd: override, pre: [] };
    return cachedCommand;
  }
  try {
    const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const pkgDir = path.join(root, "@testmuai", "kane-cli");
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["kane-cli"];
    const bin = path.join(pkgDir, binRel);
    if (fs.existsSync(bin)) {
      cachedCommand = { cmd: process.execPath, pre: [bin], version: pkg.version };
      return cachedCommand;
    }
  } catch {
    /* fall through */
  }
  cachedCommand = { cmd: "kane-cli", pre: [] };
  return cachedCommand;
}

export function buildRunArgs(spec, baseUrl, kaneCfg = {}) {
  const url = spec.url || new URL(spec.path || "/", baseUrl).toString();
  const args = [
    "run",
    spec.objective,
    "--url", url,
    "--agent",
    "--mode", "testing",
    "--max-steps", String(spec.maxSteps ?? kaneCfg.maxSteps ?? 30),
    "--timeout", String(spec.timeout ?? kaneCfg.timeout ?? 240),
  ];
  if (kaneCfg.headless !== false) args.push("--headless");
  if (kaneCfg.bugDetection) args.push("--bug-detection", kaneCfg.bugDetection);
  if (Array.isArray(kaneCfg.extraArgs)) args.push(...kaneCfg.extraArgs);
  return { args, url };
}

/**
 * Convert a ZenLoop spec into a Kane `_test.md` so it can be recorded once and replayed
 * (no LLM cost on replay). One spec line = one Kane step. Pure; unit-tested.
 */
export function specToTestmd(spec) {
  const steps = spec.objective
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const fm = ["---", "mode: testing", `max_steps: ${spec.maxSteps ?? 30}`];
  if (spec.timeout) fm.push(`timeout: ${spec.timeout}`);
  fm.push("---", "", `# ${spec.name}`, "");
  return [...fm, ...steps.flatMap((s, i) => [`## Step ${i + 1}`, s, ""])].join("\n");
}

/** Args for `kane-cli testmd run` (replay mode). */
export function buildTestmdArgs(file, url, kaneCfg = {}) {
  const args = ["testmd", "run", file, "--url", url, "--agent", "--mode", "testing"];
  if (kaneCfg.timeout) args.push("--timeout", String(kaneCfg.timeout));
  if (kaneCfg.headless !== false) args.push("--headless");
  return args;
}

/** Parse Kane NDJSON output into a compact result. Pure; unit-tested. */
export function parseKaneOutput(stdout, exitCode) {
  const steps = [];
  const errors = [];
  const warnings = [];
  let end = null;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.type === "run_end" || ev.type === "test_md_done") end = { ...(end || {}), ...ev };
    else if (ev.type === "error") errors.push(ev.message || ev.error || JSON.stringify(ev));
    else if (ev.type === "warning") warnings.push(ev.message || ev.code || "");
    else if (!ev.type && ev.step !== undefined) {
      const existing = steps.find((s) => s.step === ev.step);
      if (existing) Object.assign(existing, ev);
      else steps.push({ ...ev });
    }
  }

  let status;
  if (end?.status) status = end.status === "passed" ? "passed" : "failed";
  else if (exitCode === 0) status = "passed";
  else if (exitCode === 1) status = "failed";
  else if (exitCode === 3) status = "timeout";
  else status = "error";

  const failedSteps = steps.filter((s) => s.status === "failed");
  const lastFailed = failedSteps[failedSteps.length - 1] || null;

  // Kane records one verdict per assertion in run_end.context.memory.
  const conditions = Object.entries(end?.context?.memory || {})
    .filter(([, m]) => m && typeof m === "object" && (m.condition || m.reasoning))
    .map(([key, m]) => {
      const reasoning = String(m.reasoning || "");
      const verdict = /->\s*FAIL\b|\bFAIL(ED)?\b/.test(reasoning) ? "fail" : /->\s*PASS\b/.test(reasoning) ? "pass" : "unknown";
      return { key, condition: m.condition || m.human_description || key, verdict, observed: m.extracted_value ?? null, reasoning };
    });

  return {
    status,
    exitCode,
    reason: end?.reason || errors[0] || null,
    summary: end?.summary || null,
    oneLiner: end?.one_liner || null,
    finalState: end?.final_state ?? null,
    credits: Number(end?.credits_consumed ?? end?.credits ?? 0) || 0,
    duration: end?.duration ?? null,
    testUrl: end?.test_url || null,
    sessionDir: end?.session_dir || null,
    steps: steps.map((s) => ({ step: s.step, status: s.status, remark: s.remark })),
    lastFailedStep: lastFailed ? lastFailed.remark : null,
    conditions,
    failedConditions: conditions.filter((c) => c.verdict === "fail"),
    reasonCode: end?.reason_code || null,
    errors,
    warnings,
  };
}

/**
 * Run one spec through Kane CLI. Resolves (never rejects) with a parsed result.
 * With `replayDir`, the spec runs as a recorded `_test.md` (record once, replay cheaply).
 */
export function runSpec(spec, baseUrl, kaneCfg = {}, { logFile, onEvent, replayDir } = {}) {
  const { cmd, pre } = resolveKane();
  let { args, url } = buildRunArgs(spec, baseUrl, kaneCfg);
  let cwd;
  if (replayDir) {
    fs.mkdirSync(replayDir, { recursive: true });
    const file = `${spec.id}_test.md`;
    const full = path.join(replayDir, file);
    const content = specToTestmd(spec);
    const stamp = path.join(replayDir, `.${spec.id}.hash`);
    // Spec changed since it was recorded: drop the old recording so Kane re-authors it.
    if (!fs.existsSync(stamp) || fs.readFileSync(stamp, "utf8") !== spec.hash) {
      fs.rmSync(path.join(replayDir, `output-${spec.id}_test`), { recursive: true, force: true });
      fs.writeFileSync(full, content);
      fs.writeFileSync(stamp, spec.hash);
    }
    args = buildTestmdArgs(file, url, kaneCfg);
    cwd = replayDir;
  }
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let buf = "";
    const child = spawn(cmd, [...pre, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, KANE_CLI_USER_AGENT: "zenloop" },
      windowsHide: true,
    });
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      if (onEvent) {
        buf += s;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            onEvent(JSON.parse(line));
          } catch {
            /* not json */
          }
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on("error", (err) => {
      resolve({
        ...parseKaneOutput("", 2),
        status: "error",
        reason: `Could not launch kane-cli (${err.code || err.message}). Install it: npm install -g @testmuai/kane-cli`,
        url,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      if (logFile) {
        try {
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.writeFileSync(logFile, stdout);
        } catch {
          /* best effort */
        }
      }
      const parsed = parseKaneOutput(stdout, code);
      if (parsed.status === "error" && !parsed.reason) {
        const tail = stderr
          .split(/\r?\n/)
          .filter((l) => l.trim() && !/bundled Node runtime/.test(l))
          .slice(-5)
          .join(" | ");
        parsed.reason = tail || `kane-cli exited with code ${code}`;
      }
      resolve({ ...parsed, url, durationMs: Date.now() - started });
    });
  });
}
