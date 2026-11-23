// Read Kane CLI `.evidence` packs (zip) and distil what an agent needs to fix a failure:
// Kane's own root-cause triage, the screenshot of the failing step, console errors and
// failed network requests. Dependency-free (minimal zip reader + YAML field extraction).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// ---------- zip ----------

/** Minimal zip reader: central directory, store (0) and deflate (8). Returns Map<name, Buffer>. */
export function readZip(buf) {
  const files = new Map();
  // End of central directory record: signature 0x06054b50, search from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    try {
      files.set(name, method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null);
    } catch {
      files.set(name, null);
    }
  }
  return files;
}

// ---------- tiny YAML field extraction ----------

/**
 * Value of the first `key:` at any depth, including folded continuation lines and quotes.
 * Good enough for Kane's failure.yaml; not a general YAML parser.
 */
export function yamlField(text, key) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^(\\s*)(?:-\\s+)?${key}:\\s?(.*)$`));
    if (!m) continue;
    const indent = m[1].length + (/^\s*-\s+/.test(lines[i]) ? 2 : 0);
    let value = m[2].trim();
    const block = value === "|" || value === ">" || value === "|-" || value === ">-";
    if (value === "") continue; // nested mapping, not a scalar: keep looking deeper
    if (block) value = "";
    // A scalar continues on following lines that are indented deeper than its key.
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || l.match(/^\s*/)[0].length <= indent) break;
      value += " " + l.trim();
    }
    value = value.trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    return value || null;
  }
  return null;
}

// ---------- locate the pack ----------

/** Find the evidence pack for a Kane run from its NDJSON output, falling back to session_dir. */
export function findPack(ndjsonText, sessionDir) {
  const m = ndjsonText && ndjsonText.match(/"pack"\s*:\s*"((?:[^"\\]|\\.)*\.evidence)"/);
  if (m) {
    const p = JSON.parse(`"${m[1]}"`);
    if (fs.existsSync(p)) return p;
  }
  if (sessionDir) {
    const dir = path.join(sessionDir, "evidence");
    try {
      const packs = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".evidence"))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (packs.length) return packs[0];
    } catch {
      /* no pack */
    }
  }
  return null;
}

// ---------- distil ----------

const NOISE = /\[vite\]|Download the React DevTools|React Router Future Flag|favicon\.ico/i;

/**
 * Distil a pack into agent-ready evidence. Optionally copies the failing screenshot to `outDir`.
 * @returns {null | {title, error, rootCause, category, confidence, suggestedFix, url, screenshot, consoleErrors, failedRequests}}
 */
export function distilPack(packPath, { outDir, baseName = "failure" } = {}) {
  let files;
  try {
    files = readZip(fs.readFileSync(packPath));
  } catch {
    return null;
  }
  const text = (name) => (files.get(name) ? files.get(name).toString("utf8") : "");

  const top = text("failure.yaml");
  const stepFailurePath = yamlField(top, "path");
  const stepYaml = stepFailurePath ? text(stepFailurePath) : "";
  if (!stepYaml && !top) return null;

  const testDir = stepFailurePath ? stepFailurePath.split("/steps/")[0] : null;
  const stepDir = stepFailurePath ? stepFailurePath.replace(/\/failure\.yaml$/, "") : null;
  const failStep = yamlField(stepYaml, "step");

  // Prefer Kane's annotated screenshot of the failing step, then its plain screenshot,
  // then the last screenshot taken before the failure.
  let shotName = null;
  if (stepDir) {
    for (const cand of [`${stepDir}/annotated.png`, `${stepDir}/screenshot.jpg`, `${stepDir}/screenshot.png`]) {
      if (files.get(cand)) {
        shotName = cand;
        break;
      }
    }
  }
  if (!shotName && testDir) {
    const shots = [...files.keys()].filter((n) => n.startsWith(`${testDir}/steps/`) && /screenshot\.(jpe?g|png)$/.test(n)).sort();
    shotName = shots[shots.length - 1] || null;
  }
  let screenshot = null;
  if (shotName && outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    screenshot = path.join(outDir, `${baseName}${path.extname(shotName)}`);
    fs.writeFileSync(screenshot, files.get(shotName));
  }

  // Console errors up to and including the failing step.
  const consoleErrors = [];
  if (testDir) {
    for (const line of text(`${testDir}/logs/0-console.ndjson`).split(/\r?\n/)) {
      if (!line.startsWith("{")) continue;
      try {
        const ev = JSON.parse(line);
        if ((ev.level === "error" || ev.level === "pageerror") && ev.text && !NOISE.test(ev.text)) {
          const t = ev.text.replace(/\s+/g, " ").slice(0, 240);
          if (!consoleErrors.includes(t)) consoleErrors.push(t);
        }
      } catch {
        /* skip */
      }
    }
  }

  // Failed network requests (HTTP >= 400 or transport failure).
  const failedRequests = [];
  if (testDir) {
    try {
      const har = JSON.parse(text(`${testDir}/logs/0-network.har`) || "{}");
      for (const e of har?.log?.entries || []) {
        const status = e.response?.status ?? 0;
        if (status >= 400 || e._failed === true) {
          const u = String(e.request?.url || "").replace(/([?&](key|token|apikey|access_token)=)[^&]+/gi, "$1…");
          failedRequests.push(`${e.request?.method || "GET"} ${u.slice(0, 160)} → ${status || "failed"}`);
        }
      }
    } catch {
      /* skip */
    }
  }

  return {
    title: yamlField(stepYaml, "title") || yamlField(top, "title"),
    error: yamlField(stepYaml, "message"),
    rootCause: yamlField(stepYaml, "root_cause"),
    category: yamlField(stepYaml, "category"),
    confidence: Number(yamlField(stepYaml, "confidence")) || null,
    suggestedFix: yamlField(stepYaml, "summary"),
    url: yamlField(stepYaml, "url"),
    step: failStep,
    screenshot,
    consoleErrors: consoleErrors.slice(0, 5),
    failedRequests: [...new Set(failedRequests)].slice(0, 5),
  };
}
