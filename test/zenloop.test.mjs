import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter, globToRegExp, selectSpecs, loadSpecs } from "../src/specs.mjs";
import { parseKaneOutput, buildRunArgs } from "../src/kane.mjs";
import { formatFeedback, formatPass, isInfraFlake } from "../src/engine.mjs";

test("pass message flags spec files the agent edited", () => {
  const msg = formatPass({ results: [{ name: "Hub" }], record: { credits: 20 }, changed: ["src/a.tsx", "kane/hub.kane.md"] }, "kane");
  assert.match(msg, /verified 1 spec/);
  assert.match(msg, /changed spec file\(s\) in this task: kane\/hub\.kane\.md/);
  assert.doesNotMatch(formatPass({ results: [{ name: "Hub" }], changed: ["src/a.tsx"] }), /changed spec/);
});

test("infra flakes are distinguished from real app failures", () => {
  assert.ok(isInfraFlake({ status: "failed", reason: "Screenshot failed: TargetClosedError: screenshot: Target page, context or browser has been closed" }));
  assert.ok(!isInfraFlake({ status: "failed", reason: "The Need help now button is not visible" }));
  assert.ok(!isInfraFlake({ status: "passed", reason: "TargetClosedError" }));
});

test("kane conditions: failed assertions surface with observed value", () => {
  const end = {
    type: "run_end",
    status: "failed",
    reason: "Objective not met",
    context: {
      memory: {
        help_visible: { condition: "A button labelled Need help now is visible", extracted_value: "false", reasoning: "value: 'false' -> 'false'; equals 'true' -> FAIL" },
        page_loaded: { condition: "Page loaded", extracted_value: "true", reasoning: "value: 'true' -> 'true'; equals 'true' -> PASS" },
      },
    },
  };
  const r = parseKaneOutput(JSON.stringify(end), 1);
  assert.equal(r.conditions.length, 2);
  assert.equal(r.failedConditions.length, 1);
  assert.equal(r.failedConditions[0].observed, "false");
  const msg = formatFeedback({ attempt: 1, maxAttempts: 3, results: [{ name: "Crisis", file: "k", severity: "critical", ...r }] });
  assert.match(msg, /Assertion failed: A button labelled Need help now is visible \(observed: false\)/);
});
import { mergeStopHook } from "../src/init.mjs";
import { renderReport } from "../src/report.mjs";

test("frontmatter: scalars, inline lists, dash lists, CRLF, BOM", () => {
  const { data, body } = parseFrontmatter("﻿---\r\nname: Crisis\r\nwatch: [src/**, 'kane/*']\r\ntags:\r\n  - safety\r\n  - p0\r\nmax_steps: 20\r\n---\r\nClick it.\r\n");
  assert.equal(data.name, "Crisis");
  assert.deepEqual(data.watch, ["src/**", "kane/*"]);
  assert.deepEqual(data.tags, ["safety", "p0"]);
  assert.equal(data.max_steps, 20);
  assert.equal(body, "Click it.");
});

test("no frontmatter: whole file is the objective", () => {
  assert.deepEqual(parseFrontmatter("Just do it"), { data: {}, body: "Just do it" });
});

test("globs", () => {
  assert.ok(globToRegExp("src/**").test("src/a/b.tsx"));
  assert.ok(globToRegExp("src/**/*.tsx").test("src/App.tsx"));
  assert.ok(globToRegExp("src/*.{ts,tsx}").test("src/x.ts"));
  assert.ok(!globToRegExp("src/*.tsx").test("src/a/b.tsx"));
  assert.ok(!globToRegExp("docs/**").test("src/a.ts"));
});

test("spec selection: unwatched always, watched on match, failing always", () => {
  const specs = [
    { id: "a", watch: [] },
    { id: "b", watch: ["src/safety/**"] },
    { id: "c", watch: ["src/games/**"] },
  ];
  assert.deepEqual(selectSpecs(specs, ["src/safety/Help.tsx"]).map((s) => s.id), ["a", "b"]);
  assert.deepEqual(selectSpecs(specs, ["README.md"], ["c"]).map((s) => s.id), ["a", "c"]);
});

test("loadSpecs reads *.kane.md and ignores others", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zl-"));
  fs.mkdirSync(path.join(dir, "kane"));
  fs.writeFileSync(path.join(dir, "kane", "crisis.kane.md"), "---\nname: Crisis\npath: /x\n---\nDo the thing");
  fs.writeFileSync(path.join(dir, "kane", "notes.md"), "ignored");
  const specs = loadSpecs(dir, "kane");
  assert.equal(specs.length, 1);
  assert.equal(specs[0].id, "crisis");
  assert.equal(specs[0].path, "/x");
  assert.equal(specs[0].file, "kane/crisis.kane.md");
});

test("kane NDJSON: run_end wins, failed step captured", () => {
  const out = [
    '{"v":1,"type":"stream_start"}',
    '{"step":1,"status":"running","remark":"Open page"}',
    '{"step":1,"status":"done","remark":"Opened page"}',
    '{"step":2,"status":"failed","remark":"Button Need help now not found"}',
    "garbage line",
    '{"type":"run_end","status":"failed","reason":"Help button is not visible","one_liner":"Crisis button missing","credits_consumed":11.9,"test_url":"https://x/t/1"}',
  ].join("\n");
  const r = parseKaneOutput(out, 1);
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "Help button is not visible");
  assert.equal(r.lastFailedStep, "Button Need help now not found");
  assert.equal(r.credits, 11.9);
  assert.equal(r.steps.length, 2);
});

test("kane exit codes without run_end", () => {
  assert.equal(parseKaneOutput("", 0).status, "passed");
  assert.equal(parseKaneOutput("", 1).status, "failed");
  assert.equal(parseKaneOutput("", 2).status, "error");
  assert.equal(parseKaneOutput("", 3).status, "timeout");
});

test("run args: objective is one argv entry, url is resolved", () => {
  const { args, url } = buildRunArgs({ objective: 'Click "Need help now"\nthen check', path: "/mysafe" }, "http://localhost:3000", { headless: true });
  assert.equal(url, "http://localhost:3000/mysafe");
  assert.equal(args[1], 'Click "Need help now"\nthen check');
  assert.ok(args.includes("--agent") && args.includes("--headless"));
});

test("feedback tells the agent what failed and forbids weakening specs", () => {
  const msg = formatFeedback({
    attempt: 1,
    maxAttempts: 3,
    changed: ["src/App.tsx"],
    tampered: ["crisis"],
    results: [
      { name: "Crisis", file: "kane/crisis.kane.md", severity: "critical", status: "failed", reason: "button hidden", objective: "Click it", lastFailedStep: "find button" },
      { name: "Home", file: "kane/home.kane.md", severity: "normal", status: "passed" },
    ],
  });
  assert.match(msg, /1 of 2 spec/);
  assert.match(msg, /button hidden/);
  assert.match(msg, /still passing: Home/);
  assert.match(msg, /Spec file\(s\) changed while failing: crisis/);
});

test("Stop hook merge is idempotent and preserves other settings", () => {
  const base = { permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } };
  const once = mergeStopHook(structuredClone(base), 'node "/x/zenloop.mjs" gate');
  assert.equal(once.added, true);
  assert.equal(once.settings.hooks.Stop.length, 2);
  assert.deepEqual(once.settings.permissions, base.permissions);
  const twice = mergeStopHook(once.settings, 'node "/x/zenloop.mjs" gate');
  assert.equal(twice.added, false);
  assert.equal(twice.settings.hooks.Stop.length, 2);
});

test("report renders loops and escapes HTML", () => {
  const html = renderReport([
    { session: "s1", attempt: 1, ts: "2026-11-18T10:00:00Z", passed: false, credits: 10, changed: ["src/a.tsx"], results: [{ name: "<b>x</b>", file: "kane/x.kane.md", status: "failed", reason: "nope" }] },
    { session: "s1", attempt: 2, ts: "2026-11-18T10:05:00Z", passed: true, credits: 10, changed: [], results: [{ name: "ok", file: "kane/x.kane.md", status: "passed" }] },
  ]);
  assert.match(html, /healed in 2 attempts/);
  assert.ok(!html.includes("<b>x</b>"));
});
