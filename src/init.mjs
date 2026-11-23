// `zenloop init` — opt a project in with one command.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, DEFAULT_CONFIG } from "./workspace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "..", "bin", "zenloop.mjs");

const EXAMPLE_SPEC = `---
name: Home page loads without errors
path: /
severity: critical
---
Wait for the page to finish loading. Verify the main heading is visible and the page is not blank.
Verify no error message, stack trace or "something went wrong" screen is shown.
`;

function hookCommand() {
  // Absolute path: works for global installs and local clones, on every OS.
  const bin = BIN.split(path.sep).join("/");
  return `node "${bin}" gate`;
}

export function mergeStopHook(settings, command) {
  const s = settings && typeof settings === "object" ? settings : {};
  s.hooks ||= {};
  s.hooks.Stop ||= [];
  const already = s.hooks.Stop.some((m) => (m.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("zenloop")));
  if (!already) {
    s.hooks.Stop.push({ hooks: [{ type: "command", command, timeout: 1800 }] });
  }
  return { settings: s, added: !already };
}

export const PACKS_DIR = path.resolve(HERE, "..", "templates");

export function listPacks() {
  try {
    return fs.readdirSync(PACKS_DIR).filter((d) => fs.statSync(path.join(PACKS_DIR, d)).isDirectory());
  } catch {
    return [];
  }
}

/** Copy a spec pack (e.g. `security`) into the project's specs dir. Never overwrites. */
export function addPack(root, specDir, pack) {
  const src = path.join(PACKS_DIR, pack);
  if (!fs.existsSync(src)) throw new Error(`unknown pack "${pack}". Available: ${listPacks().join(", ")}`);
  const dest = path.resolve(root, specDir);
  fs.mkdirSync(dest, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith(".kane.md"))) {
    const target = path.join(dest, f);
    if (fs.existsSync(target)) out.push(`kept existing ${specDir}/${f}`);
    else {
      fs.copyFileSync(path.join(src, f), target);
      out.push(`added ${specDir}/${f}`);
    }
  }
  return out;
}

export function init(root, { baseUrl, devCommand, hook = true } = {}) {
  const done = [];
  const cfgPath = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(cfgPath)) {
    const cfg = {
      baseUrl: baseUrl || DEFAULT_CONFIG.baseUrl,
      specs: "kane",
      maxAttempts: 3,
      trigger: "changes",
      devServer: devCommand ? { command: devCommand, readyTimeout: 90 } : null,
      kane: { headless: true, timeout: 240, maxSteps: 30 },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    done.push(`created ${CONFIG_FILE}`);
  } else done.push(`kept existing ${CONFIG_FILE}`);

  const specDir = path.join(root, "kane");
  if (!fs.existsSync(specDir)) {
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "home-loads.kane.md"), EXAMPLE_SPEC);
    done.push("created kane/home-loads.kane.md");
  }

  const gi = path.join(root, ".gitignore");
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  if (!/^\.zenloop\/?$/m.test(giText)) {
    fs.writeFileSync(gi, giText + (giText.endsWith("\n") || !giText ? "" : "\n") + ".zenloop/\n");
    done.push("added .zenloop/ to .gitignore");
  }

  if (!hook) {
    done.push("skipped settings hook (--no-hook: the ZenLoop Claude Code plugin provides it)");
    return done;
  }
  const settingsPath = path.join(root, ".claude", "settings.json");
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8").replace(/^﻿/, "") || "{}");
  }
  const { settings: merged, added } = mergeStopHook(settings, hookCommand());
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  done.push(added ? "installed Claude Code Stop hook in .claude/settings.json" : "Stop hook already installed");
  return done;
}
