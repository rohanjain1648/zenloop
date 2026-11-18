// Project config, git change detection and persistent loop state.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const CONFIG_FILE = "zenloop.config.json";
export const STATE_DIR = ".zenloop";

export const DEFAULT_CONFIG = {
  baseUrl: "http://localhost:3000",
  specs: "kane",
  maxAttempts: 3,
  parallel: 1,
  trigger: "changes",
  ignore: [".zenloop/**", "node_modules/**", "dist/**", ".git/**"],
  devServer: null,
  kane: { headless: true, timeout: 240, maxSteps: 30 },
};

/** Walk up from `start` to find the directory containing zenloop.config.json. */
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(root) {
  const raw = fs.readFileSync(path.join(root, CONFIG_FILE), "utf8").replace(/^﻿/, "");
  const user = JSON.parse(raw);
  return {
    ...DEFAULT_CONFIG,
    ...user,
    kane: { ...DEFAULT_CONFIG.kane, ...(user.kane || {}) },
    ignore: [...DEFAULT_CONFIG.ignore, ...(user.ignore || [])],
  };
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function isGitRepo(root) {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/** Files that differ from HEAD (modified, staged, untracked). Forward slashes. */
export function changedFiles(root) {
  try {
    const out = git(root, ["status", "--porcelain", "-uall"]);
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^"|"$/g, ""))
      .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p))
      .map((p) => p.split(path.sep).join("/"));
  } catch {
    return [];
  }
}

/**
 * Content fingerprint of the working tree relative to HEAD.
 * Same fingerprint == nothing changed since the last verification.
 */
export function fingerprint(root, files, ignoreGlobs, matchesAny) {
  const h = crypto.createHash("sha1");
  try {
    h.update(git(root, ["rev-parse", "HEAD"]).trim());
  } catch {
    h.update("no-head");
  }
  for (const f of [...files].sort()) {
    if (matchesAny(f, ignoreGlobs)) continue;
    h.update("\0" + f + "\0");
    try {
      h.update(fs.readFileSync(path.join(root, f)));
    } catch {
      h.update("<deleted>");
    }
  }
  return h.digest("hex").slice(0, 16);
}

export function diffStat(root) {
  try {
    return git(root, ["diff", "HEAD", "--stat", "--", ".", ":(exclude).zenloop"]).trim();
  } catch {
    return "";
  }
}

// ---------- state ----------

export function statePath(root) {
  return path.join(root, STATE_DIR, "state.json");
}

export function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(statePath(root), "utf8"));
  } catch {
    return { lastGreen: null, failing: [], sessions: {}, specHashes: {} };
  }
}

export function writeState(root, state) {
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2));
}

export function appendRun(root, record) {
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  fs.appendFileSync(path.join(root, STATE_DIR, "runs.jsonl"), JSON.stringify(record) + "\n");
}

export function readRuns(root) {
  try {
    return fs
      .readFileSync(path.join(root, STATE_DIR, "runs.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ---------- dev server ----------

export async function isReachable(url, timeoutMs = 4000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    clearTimeout(t);
    return res.status > 0;
  } catch {
    return false;
  }
}
