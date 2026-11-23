// Spec files: `kane/*.kane.md`
//
//   ---
//   name: Crisis help is reachable from MyBreath
//   path: /mysanctuary/mybreath
//   watch: [src/**]
//   severity: critical
//   ---
//   Plain-English objective that Kane CLI executes in a real browser.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SPEC_SUFFIX = ".kane.md";

function parseScalar(raw) {
  const v = raw.trim();
  if (v === "") return "";
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter(Boolean);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return unquote(v);
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Minimal YAML-subset frontmatter parser: scalars, inline lists, dash lists. */
export function parseFrontmatter(text) {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return { data: {}, body: src.trim() };
  const end = src.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: src.trim() };
  const head = src.slice(4, end);
  const body = src.slice(end + 4).replace(/^[^\n]*\n/, "").trim();
  const data = {};
  let listKey = null;
  for (const line of head.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      data[listKey].push(unquote(item[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value.trim() === "") {
      data[key] = [];
      listKey = key;
    } else {
      data[key] = parseScalar(value);
      listKey = null;
    }
  }
  return { data, body };
}

export function hashText(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 12);
}

export function loadSpecs(root, specDir) {
  const dir = path.resolve(root, specDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(SPEC_SUFFIX))
    .sort()
    .map((file) => {
      const full = path.join(dir, file);
      const text = fs.readFileSync(full, "utf8");
      const { data, body } = parseFrontmatter(text);
      const id = file.slice(0, -SPEC_SUFFIX.length);
      const watch = data.watch === undefined ? [] : [].concat(data.watch);
      return {
        id,
        file: path.relative(root, full).split(path.sep).join("/"),
        name: data.name || id,
        path: data.path || "/",
        url: data.url || null,
        watch,
        severity: data.severity || "normal",
        deployedOnly: data.deployed_only === true,
        maxSteps: data.max_steps ?? data.maxSteps ?? null,
        timeout: data.timeout ?? null,
        objective: body,
        hash: hashText(text),
      };
    })
    .filter((s) => s.objective.length > 0);
}

/** Glob -> RegExp. Supports **, *, ? and {a,b}. Paths use forward slashes. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close > i) {
        const alts = glob.slice(i + 1, close).split(",").map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&"));
        re += `(?:${alts.join("|")})`;
        i = close;
      } else re += "\\{";
    } else if (".+^$()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when the app under test is a local dev server rather than a deployment. */
export function isLocalUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h) || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Drop `deployed_only` specs when verifying a local dev server. */
export function applicableSpecs(specs, baseUrl) {
  return isLocalUrl(baseUrl) ? specs.filter((s) => !s.deployedOnly) : specs;
}

export function matchesAny(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file));
}

/**
 * Which specs should run for this change set?
 *  - specs with no `watch` always run
 *  - specs whose `watch` globs match a changed file run
 *  - specs that failed last time always re-run (the agent must turn them green)
 */
export function selectSpecs(specs, changedFiles, previouslyFailing = []) {
  return specs.filter(
    (s) =>
      s.watch.length === 0 ||
      previouslyFailing.includes(s.id) ||
      changedFiles.some((f) => matchesAny(f, s.watch)),
  );
}
