// `zenloop report` — a self-contained HTML timeline of every verify attempt.

import fs from "node:fs";
import path from "node:path";
import { readRuns, STATE_DIR } from "./workspace.mjs";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function groupLoops(runs) {
  // A loop = consecutive attempts in one session, ending at a green run (or the latest run).
  const loops = [];
  let cur = null;
  for (const r of runs) {
    if (!cur || cur.session !== r.session || cur.closed) {
      cur = { session: r.session, attempts: [], closed: false };
      loops.push(cur);
    }
    cur.attempts.push(r);
    if (r.passed) cur.closed = true;
  }
  return loops.reverse();
}

function badge(status) {
  const cls = status === "passed" ? "ok" : status === "failed" ? "bad" : "warn";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

export function renderReport(runs, { project = "" } = {}) {
  const loops = groupLoops(runs);
  const totalRuns = runs.reduce((a, r) => a + r.results.length, 0);
  const caught = runs.reduce((a, r) => a + r.results.filter((x) => x.status === "failed").length, 0);
  const healed = loops.filter((l) => l.attempts.length > 1 && l.closed).length;
  const credits = runs.reduce((a, r) => a + (r.credits || 0), 0);

  const loopHtml = loops
    .map((loop, i) => {
      const first = loop.attempts[0];
      const last = loop.attempts[loop.attempts.length - 1];
      const verdict = loop.closed
        ? loop.attempts.length > 1
          ? `<span class="badge ok">healed in ${loop.attempts.length} attempts</span>`
          : `<span class="badge ok">green first try</span>`
        : `<span class="badge bad">open</span>`;
      const attempts = loop.attempts
        .map((a) => {
          const rows = a.results
            .map(
              (r) => `<li class="spec ${r.status === "passed" ? "p" : "f"}">
              <div class="spec-head">${badge(r.status)}<strong>${esc(r.name)}</strong><code>${esc(r.file)}</code></div>
              ${r.status !== "passed" && r.reason ? `<p class="reason">${esc(r.reason)}</p>` : ""}
              ${r.status !== "passed" && r.lastFailedStep ? `<p class="step">Failed at: ${esc(r.lastFailedStep)}</p>` : ""}
              ${r.status === "passed" && r.oneLiner ? `<p class="step">${esc(r.oneLiner)}</p>` : ""}
              <p class="meta">${r.durationMs ? (r.durationMs / 1000).toFixed(0) + "s" : ""}${r.credits ? " · " + r.credits.toFixed(1) + " credits" : ""}${
                r.testUrl ? ` · <a href="${esc(r.testUrl)}" target="_blank" rel="noopener">Kane evidence ↗</a>` : ""
              }</p>
            </li>`,
            )
            .join("");
          return `<div class="attempt ${a.passed ? "green" : "red"}">
            <div class="attempt-head"><span class="dot"></span>Attempt ${a.attempt} · ${esc(new Date(a.ts).toLocaleString())}
            ${a.tampered?.length ? `<span class="badge warn">spec edited while failing</span>` : ""}</div>
            ${a.changed?.length ? `<p class="files">Changed: ${a.changed.slice(0, 12).map((f) => `<code>${esc(f)}</code>`).join(" ")}</p>` : ""}
            <ul>${rows}</ul>
          </div>`;
        })
        .join("");
      return `<section class="loop">
        <header><h2>Loop ${loops.length - i}</h2>${verdict}<span class="muted">${esc(new Date(first.ts).toLocaleString())} → ${esc(
          new Date(last.ts).toLocaleTimeString(),
        )} · session ${esc(String(loop.session).slice(0, 8))}</span></header>
        <div class="timeline">${attempts}</div>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZenLoop Report</title>
<style>
:root{--bg:#f7f6f2;--card:#fff;--ink:#1d1b18;--muted:#6b665e;--line:#e4e0d8;--ok:#1f7a4d;--okbg:#e3f3ea;--bad:#b42318;--badbg:#fde8e6;--warn:#8a5a00;--warnbg:#fdf1d6;--accent:#4b3fb8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121110;--card:#1c1a18;--ink:#eeeae3;--muted:#a39d93;--line:#2e2b27;--ok:#5fd39a;--okbg:#14301f;--bad:#ff8a7e;--badbg:#3a1714;--warn:#f2c46b;--warnbg:#33270c;--accent:#a99cff}}
:root[data-theme="dark"]{--bg:#121110;--card:#1c1a18;--ink:#eeeae3;--muted:#a39d93;--line:#2e2b27;--ok:#5fd39a;--okbg:#14301f;--bad:#ff8a7e;--badbg:#3a1714;--warn:#f2c46b;--warnbg:#33270c;--accent:#a99cff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:40px 16px 80px}
h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}.sub{color:var(--muted);margin:0 0 28px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:32px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}.stat b{display:block;font-size:26px;font-variant-numeric:tabular-nums}.stat span{color:var(--muted);font-size:13px}
.loop{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:18px}
.loop header{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px}.loop h2{font-size:18px;margin:0}
.muted{color:var(--muted);font-size:13px}
.timeline{border-left:2px solid var(--line);margin-left:6px;padding-left:18px}
.attempt{position:relative;margin-bottom:16px}.attempt-head{font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dot{position:absolute;left:-25px;top:6px;width:12px;height:12px;border-radius:50%;background:var(--bad);border:2px solid var(--card)}.green .dot{background:var(--ok)}
.attempt ul{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:8px}
.spec{border:1px solid var(--line);border-radius:12px;padding:10px 12px}.spec.f{border-color:color-mix(in srgb,var(--bad) 40%,var(--line))}
.spec-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.spec code,.files code{font-size:12px;color:var(--muted)}
.reason{margin:6px 0 0;color:var(--bad)}.step{margin:4px 0 0;color:var(--muted);font-size:14px}.meta{margin:4px 0 0;font-size:12px;color:var(--muted)}
.files{margin:6px 0 0;font-size:13px;color:var(--muted)}
a{color:var(--accent)}
.badge{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px}.ok{color:var(--ok);background:var(--okbg)}.bad{color:var(--bad);background:var(--badbg)}.warn{color:var(--warn);background:var(--warnbg)}
.empty{color:var(--muted);text-align:center;padding:60px 0}
</style></head><body><main>
<h1>ZenLoop</h1><p class="sub">Agent writes → Kane CLI verifies in a real browser → failures go back to the agent. ${esc(project)}</p>
<div class="stats">
<div class="stat"><b>${loops.length}</b><span>verify loops</span></div>
<div class="stat"><b>${totalRuns}</b><span>Kane runs</span></div>
<div class="stat"><b>${caught}</b><span>failures caught</span></div>
<div class="stat"><b>${healed}</b><span>loops healed by the agent</span></div>
<div class="stat"><b>${credits.toFixed(0)}</b><span>Kane credits</span></div>
</div>
${loopHtml || `<p class="empty">No runs yet. Run <code>zenloop run</code> or let your agent finish a task.</p>`}
</main></body></html>`;
}

export function writeReport(root) {
  const runs = readRuns(root);
  const out = path.join(root, STATE_DIR, "report.html");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderReport(runs, { project: path.basename(root) }));
  return out;
}
