import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { readZip, yamlField, distilPack, findPack } from "../src/evidence.mjs";
import { formatFeedback } from "../src/engine.mjs";

/** Build a zip (store or deflate) in memory — test helper. */
function makeZip(entries, deflate = false) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// Verbatim shape of a real Kane CLI 0.10.6 step failure.yaml
const STEP_FAILURE = `step: 0-6
status: failed
error:
  message: 'Checkpoint assertion failed: "While the session is running, a button labelled
    "Need help now" is still visible on screen."'
page_state:
  url: http://localhost:3000/mysanctuary/mybreath
  screenshot: steps/6-0-6/screenshot.jpg
title: Emergency help button disappears during breathing session
triage:
  status: triaged
  rca:
    root_cause: Starting the breathing session changes the screen to the active-session
      view, which shows the cycle counter and stop control but does not keep the emergency
      help button visible.
    category: application_issue/ui_state_mismatch
    confidence: 0.9
  verification:
    status: not_verified
  severity: major
  suggested_fix:
    summary: Keep a clearly labelled "Need help now" button visible throughout an
      active breathing session.
`;

const T = "tests/wait-for-the-page-abc";
const TOP = `failures:\n  - test: wait-for-the-page-abc\n    path: ${T}/steps/6-0-6/failure.yaml\n    title: Emergency help button disappears during breathing session\n`;

test("readZip: stored and deflated entries", () => {
  for (const deflate of [false, true]) {
    const files = readZip(makeZip({ "a.txt": "hello", "dir/b.json": '{"x":1}' }, deflate));
    assert.equal(files.get("a.txt").toString(), "hello");
    assert.equal(files.get("dir/b.json").toString(), '{"x":1}');
  }
});

test("yamlField: folded scalars, quotes, nested keys, list items", () => {
  assert.equal(yamlField(STEP_FAILURE, "root_cause"), "Starting the breathing session changes the screen to the active-session view, which shows the cycle counter and stop control but does not keep the emergency help button visible.");
  assert.equal(yamlField(STEP_FAILURE, "message"), 'Checkpoint assertion failed: "While the session is running, a button labelled "Need help now" is still visible on screen."');
  assert.equal(yamlField(STEP_FAILURE, "category"), "application_issue/ui_state_mismatch");
  assert.equal(yamlField(STEP_FAILURE, "confidence"), "0.9");
  assert.equal(yamlField(STEP_FAILURE, "summary"), 'Keep a clearly labelled "Need help now" button visible throughout an active breathing session.');
  assert.equal(yamlField(TOP, "path"), `${T}/steps/6-0-6/failure.yaml`);
  assert.equal(yamlField(STEP_FAILURE, "triage"), null);
});

test("distilPack: triage, failing screenshot, console errors, failed requests", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zl-ev-"));
  const har = { log: { entries: [
    { request: { method: "GET", url: "http://x/ok" }, response: { status: 200 } },
    { request: { method: "POST", url: "http://x/api/checkin?token=SECRET123" }, response: { status: 500 } },
  ] } };
  const pack = path.join(dir, "run.evidence");
  fs.writeFileSync(pack, makeZip({
    "failure.yaml": TOP,
    [`${T}/steps/5-0-5/screenshot.jpg`]: "IMG5",
    [`${T}/steps/6-0-6/screenshot.jpg`]: "IMG6",
    [`${T}/steps/6-0-6/failure.yaml`]: STEP_FAILURE,
    [`${T}/logs/0-console.ndjson`]: [
      '{"level":"debug","text":"[vite] connected."}',
      '{"level":"error","text":"TypeError: Cannot read properties of undefined (reading \'map\')"}',
      '{"level":"error","text":"[vite] hmr failed"}',
    ].join("\n"),
    [`${T}/logs/0-network.har`]: JSON.stringify(har),
  }));
  const out = path.join(dir, "out");
  const ev = distilPack(pack, { outDir: out, baseName: "crisis" });
  assert.equal(ev.title, "Emergency help button disappears during breathing session");
  assert.equal(ev.confidence, 0.9);
  assert.equal(fs.readFileSync(ev.screenshot, "utf8"), "IMG6");
  assert.deepEqual(ev.consoleErrors, ["TypeError: Cannot read properties of undefined (reading 'map')"]);
  assert.deepEqual(ev.failedRequests, ["POST http://x/api/checkin?token=… → 500"]);
  assert.equal(findPack(`{"type":"coverage","pack":${JSON.stringify(pack)}}`, null), pack);
});

test("feedback hands the agent Kane's root cause and the screenshot path", () => {
  const msg = formatFeedback({
    attempt: 1,
    maxAttempts: 3,
    results: [{
      name: "Crisis", file: "kane/c.kane.md", severity: "critical", status: "failed", reason: "assert failed",
      evidence: { rootCause: "Help button not rendered in active session", category: "application_issue/ui_state_mismatch", confidence: 0.9, suggestedFix: "Keep it visible", screenshot: ".zenloop/evidence/r1/crisis.jpg", consoleErrors: ["TypeError: x"], failedRequests: [] },
    }],
  });
  assert.match(msg, /Kane root cause \(confidence 0\.9\): Help button not rendered/);
  assert.match(msg, /Kane suggests: Keep it visible/);
  assert.match(msg, /Screenshot of the failing screen: \.zenloop\/evidence\/r1\/crisis\.jpg/);
  assert.match(msg, /Console error: TypeError: x/);
  assert.doesNotMatch(msg, /suspects the test/);
});

test("when Kane blames the test, the agent is told to escalate, not edit the spec", () => {
  const msg = formatFeedback({
    attempt: 1,
    maxAttempts: 3,
    results: [{ name: "Crisis", file: "k", severity: "critical", status: "failed", evidence: { rootCause: "The test assumed the button stays visible", category: "automation_bug/state_transition_bug" } }],
  });
  assert.match(msg, /suspects the test, not the app/);
  assert.match(msg, /stop and explain that to the human instead of editing the spec/);
});
