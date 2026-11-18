#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { gate } from "../src/gate.mjs";
import { init } from "../src/init.mjs";
import { verify, formatFeedback } from "../src/engine.mjs";
import { writeReport } from "../src/report.mjs";
import { findRoot, loadConfig, isReachable, isGitRepo, readState, writeState } from "../src/workspace.mjs";
import { resolveKane } from "../src/kane.mjs";
import { loadSpecs } from "../src/specs.mjs";

const VERSION = "0.1.0";
const [, , cmd, ...rest] = process.argv;
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name) => rest.includes(`--${name}`);

const c = process.stdout.isTTY
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: (s) => s, r: (s) => s, y: (s) => s, d: (s) => s, b: (s) => s };

function requireRoot() {
  const root = findRoot();
  if (!root) {
    console.error("No zenloop.config.json found here or above. Run `zenloop init` in your project first.");
    process.exit(2);
  }
  return root;
}

function openFile(file) {
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
  spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
}

const HELP = `zenloop ${VERSION} — your agent isn't done until Kane CLI says pass.

  zenloop init [--url http://localhost:3000] [--dev "npm run dev"] [--no-hook]
        Opt this project in: config, example spec, Claude Code Stop hook.
        (--no-hook if you installed the ZenLoop Claude Code plugin instead.)
  zenloop run [--spec id[,id]] [--all]
        Verify now (changed-file aware). Exit 0 pass, 1 fail, 2 error.
  zenloop gate
        Claude Code Stop hook entry point (reads hook JSON on stdin).
  zenloop report [--open]
        Write .zenloop/report.html — every loop, attempt and Kane verdict.
  zenloop doctor
        Check kane-cli, login, config, app URL and specs.
  zenloop reset
        Clear loop state (attempt counters, failing list).

Specs live in kane/*.kane.md — plain English, with optional frontmatter:
  ---
  name: Crisis help is reachable
  path: /mysanctuary/mybreath
  watch: [src/**]
  ---
  Click "Need help now" and verify the helpline 14416 is shown.
`;

async function main() {
  switch (cmd) {
    case "gate":
      return gate();

    case "init": {
      const root = process.cwd();
      for (const line of init(root, { baseUrl: flag("url"), devCommand: flag("dev"), hook: !has("no-hook") })) console.log(c.g("✓ ") + line);
      console.log(`\nNext: write specs in ${c.b("kane/")}, then ${c.b("zenloop doctor")}. Claude Code now can't finish a task until they pass.`);
      return;
    }

    case "run": {
      const root = requireRoot();
      const cfg = loadConfig(root);
      const only = flag("spec") ? flag("spec").split(",") : null;
      const out = await verify(root, cfg, {
        session: "manual",
        only,
        force: has("all") || !!only,
        log: (m) => console.log(c.d(m)),
      });
      if (out.skipped) {
        console.log(c.y(`skipped: ${out.skipped}`) + c.d("  (use --all to force)"));
        return;
      }
      for (const r of out.results) {
        const mark = r.status === "passed" ? c.g("✓") : c.r("✗");
        console.log(`${mark} ${c.b(r.name)} ${c.d(r.status)}${r.oneLiner ? c.d(" — " + r.oneLiner) : ""}`);
        if (r.status !== "passed") {
          if (r.reason) console.log("   " + c.r(r.reason));
          if (r.lastFailedStep) console.log("   " + c.d("failed at: " + r.lastFailedStep));
        }
        if (r.testUrl) console.log("   " + c.d(r.testUrl));
      }
      const bad = out.results.filter((r) => r.status !== "passed");
      if (bad.length && has("feedback")) console.log("\n" + formatFeedback({ ...out, maxAttempts: cfg.maxAttempts }));
      process.exitCode = bad.length ? (bad.every((r) => r.status === "error") ? 2 : 1) : 0;
      // manual runs shouldn't consume the agent's attempt budget
      const st = readState(root);
      delete st.sessions.manual;
      writeState(root, st);
      return;
    }

    case "report": {
      const root = requireRoot();
      const file = writeReport(root);
      console.log(c.g("✓ ") + file);
      if (has("open")) openFile(file);
      return;
    }

    case "reset": {
      const root = requireRoot();
      writeState(root, { lastGreen: null, failing: [], sessions: {}, specHashes: {} });
      console.log(c.g("✓ ") + "loop state cleared");
      return;
    }

    case "doctor": {
      let ok = true;
      const check = (good, label, hint) => {
        console.log(`${good ? c.g("✓") : c.r("✗")} ${label}${!good && hint ? c.d("  → " + hint) : ""}`);
        if (!good) ok = false;
      };
      const k = resolveKane();
      let who = "";
      try {
        who = execFileSync(k.cmd, [...k.pre, "whoami"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        who = String(e.stdout || "") + String(e.stderr || "");
      }
      check(k.cmd !== "kane-cli" || who.length > 0, `kane-cli found${k.version ? " (v" + k.version + ")" : ""}`, "npm install -g @testmuai/kane-cli");
      check(!/not logged in/i.test(who) && who.length > 0, "kane-cli logged in", "kane-cli login --oauth");
      const root = findRoot();
      check(!!root, "zenloop.config.json", "zenloop init");
      if (root) {
        const cfg = loadConfig(root);
        check(isGitRepo(root), "git repository (for changed-file detection)", "git init");
        const specs = loadSpecs(root, cfg.specs);
        check(specs.length > 0, `${specs.length} spec(s) in ${cfg.specs}/`, `add ${cfg.specs}/*.kane.md`);
        check(await isReachable(cfg.baseUrl), `app reachable at ${cfg.baseUrl}`, cfg.devServer?.command ? "will auto-start: " + cfg.devServer.command : "start your dev server");
      }
      process.exitCode = ok ? 0 : 1;
      return;
    }

    case "--version":
    case "-v":
      console.log(VERSION);
      return;

    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(e?.stack || e);
  // A crashing hook must never trap the agent.
  process.exit(cmd === "gate" ? 0 : 2);
});
