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
    if (ev.type === "run_end") end = ev;
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
    errors,
    warnings,
  };
}

/** Run one spec through Kane CLI. Resolves (never rejects) with a parsed result. */
export function runSpec(spec, baseUrl, kaneCfg = {}, { logFile, onEvent } = {}) {
  const { cmd, pre } = resolveKane();
  const { args, url } = buildRunArgs(spec, baseUrl, kaneCfg);
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let buf = "";
    const child = spawn(cmd, [...pre, ...args], {
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
