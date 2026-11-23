# ZenLoop

**Your coding agent doesn't get to say "done" until Kane CLI says pass.**

ZenLoop is a Claude Code Stop hook that sits between your agent and the word "done". Every time the agent tries to finish a task, ZenLoop runs your plain-English browser specs through [Kane CLI](https://github.com/LambdaTest/kane-cli) against your running app. If Kane reports a failure, the agent is told it is not finished, and it gets Kane's exact verdict: the failed assertion, the observed value, the step it broke on and an evidence link. It fixes the code, tries to finish again, and Kane re-verifies. The loop runs with no human in it.

```
  you: "add a focus mode to the breathing screen"
   │
   ▼
 Claude Code ── edits code ──► tries to stop
                                   │
                         ZenLoop Stop hook
                                   │  which specs cover the changed files?
                                   ▼
                    kane-cli run "<spec>" --agent --headless
                                   │  real Chrome, NDJSON verdict
                     ┌─────────────┴──────────────┐
                  passed                        failed
                     │                            │
          "✓ Kane verified 3 specs"   {"decision":"block","reason":
           agent may stop               "✗ Need help now button not visible
                                         (observed: false) … evidence: …"}
                                                  │
                                       Claude fixes, tries again ─┐
                                                  ▲               │
                                                  └───────────────┘
                                        (max 3 attempts, then hands back to you)
```

Agents write code fast but can't check their own work in a browser. Kane CLI can. ZenLoop wires the two together.

---

## Install (one command)

Requirements: Node 18+, Chrome, [Kane CLI](https://www.testmuai.com/support/docs/kane-cli-introduction/) logged in (`npm i -g @testmuai/kane-cli && kane-cli login --oauth`).

```bash
npm i -g github:rohanjain1648/zenloop && cd your-app && zenloop init --url http://localhost:3000 --dev "npm run dev"
```

`zenloop init` does the following:

- creates `zenloop.config.json`
- creates `kane/` with an example spec
- adds `.zenloop/` to `.gitignore`
- merges a Stop hook into `.claude/settings.json`, leaving your existing settings and hooks untouched

Then run:

```bash
zenloop doctor     # checks kane-cli, login, config, git, app URL, specs
zenloop run --all  # verify everything once by hand
```

From now on, Claude Code in that project can't finish a task while a spec is red.

**As a Claude Code plugin** (the hook comes from the plugin instead):

```
/plugin marketplace add rohanjain1648/zenloop
/plugin install zenloop@zenloop
```

Then run `zenloop init --no-hook` in your project to create the config and specs.

---

## Specs: plain English, versioned with your code

`kane/crisis-help-during-breathing.kane.md`

```markdown
---
name: Crisis help stays reachable during a breathing session
path: /mysanctuary/mybreath
severity: critical
---
Click the "Begin Session" button to start a breathing session.
Verify the session has started: a "Cycles Completed" counter is visible.
While the session is running, verify a button labelled "Need help now" is still visible on screen.
Click it and verify a dialog titled "You are not alone" shows the helpline number 14416.
```

| frontmatter | meaning |
|---|---|
| `name` | Human-readable name, shown to the agent and in the report |
| `path` / `url` | Where Kane starts. `path` is resolved against `baseUrl` |
| `watch` | Globs. The spec runs only when a matching file changed. Leave it out to run the spec on every change |
| `severity` | `critical` / `normal`, shown to the agent |
| `max_steps`, `timeout` | Per-spec Kane limits |

The body is passed to `kane-cli run` unchanged.

## The agent sees what Kane saw

When a spec fails, ZenLoop opens Kane's `.evidence` pack and gives the agent more than a "failed". It passes on:

- **Kane's own root-cause triage**: `root_cause`, `category` (e.g. `application_issue/ui_state_mismatch`), `confidence` and `suggested_fix`.
- **The screenshot of the failing step**, copied to `.zenloop/evidence/…`. Claude is told to open it with its Read tool, so it can see the broken screen.
- **Console errors and failed network requests** captured at the moment of failure. Credentials in query strings are redacted.

```
✗ [critical] Crisis help stays reachable during a breathing session  (kane/crisis-help-during-breathing.kane.md)
  ✗ Assertion failed: A button labelled "Need help now" is visible on screen. (observed: false)
  Kane root cause (confidence 0.9): Starting the breathing session changes the screen to the
    active-session view, which … does not keep the emergency help button visible.
  Category: application_issue/ui_state_mismatch
  Kane suggests: Keep a clearly labelled "Need help now" button visible throughout an active session…
  Screenshot of the failing screen: .zenloop/evidence/2026-…/crisis-help-during-breathing.jpg
    ← open it with your Read tool to see exactly what Kane saw
```

The HTML report (`zenloop report`) shows the same root cause, suggested fix and a screenshot thumbnail for every failed attempt.

## Spec packs: security checks in one command

```bash
zenloop add security
```

This adds five plain-English Kane specs, based on the Kane CLI cookbook:

| spec | catches |
|---|---|
| `sec-no-keys-in-network` | API keys or secrets (`AIza…`, `sk-…`, `gsk_…`) sent from the browser |
| `sec-no-secrets-in-storage` | Passwords, tokens or keys in `localStorage` |
| `sec-no-env-leak` *(deployed only)* | A production build calling staging, localhost or debug endpoints |
| `sec-cookies-secure` *(deployed only)* | Cookies without the `Secure` flag |
| `sec-green-page-no-errors` | Hidden 5xx responses or console errors behind a page that looks fine |

Specs marked `deployed_only: true` are skipped against a local dev server and run with `zenloop run --url https://your-deploy`.

## Cheaper runs: `kaneMode: "testmd"`

Set `"kaneMode": "testmd"` in `zenloop.config.json`. Each spec is then compiled to a Kane `_test.md`, one step per line, and run with `kane-cli testmd run`. We measured the same crisis-button spec on the same machine:

| mode | credits per run | regression caught? |
|---|---|---|
| `kane-cli run` (default) | 23–27 | ✓ |
| `kane-cli testmd run` (`kaneMode: "testmd"`) | **8–11** | ✓ (button hidden → failed: "Need help now is still visible on screen") |

Kane's record-once/replay caching for `_test.md` commits recordings through its cloud test manager (`--push` and the lock API), so ZenLoop doesn't rely on it. Every run is a full, fresh verification.

## Why the loop stays honest

- **Change-aware.** It hashes the working tree against `HEAD`. If nothing changed since the last green run, it runs nothing and spends no credits. Only specs whose `watch` globs match the changed files run, plus any spec that failed last time.
- **Rich feedback, not just "failed".** Kane writes a verdict for each assertion (`context.memory`). ZenLoop turns that into lines like `✗ Assertion failed: A button labelled "Need help now" is visible (observed: false)`, so the agent knows what to fix.
- **No cheating.** ZenLoop remembers each failing spec's content hash. If the agent edits a spec while it's red, ZenLoop says so, and the feedback tells the agent to fix the app instead.
- **Infrastructure flakes aren't the agent's bug.** Browser crashes and `TargetClosedError` are retried once and reported as `error`, never as an app failure the agent should fix.
- **It can never trap a session.** There are at most `maxAttempts` attempts (default 3), and after that it hands back to you with a summary. If the config is broken or ZenLoop crashes, it never blocks. `ZENLOOP_DISABLE=1` turns it off.
- **Agent attempts are separate from your manual runs.** `zenloop run` doesn't use up the agent's attempt budget.

## Commands

| command | what it does |
|---|---|
| `zenloop init` | Opts a project in (config, specs dir, Stop hook) |
| `zenloop run [--all] [--spec a,b] [--feedback]` | Verifies now. Exit code 0 pass / 1 fail / 2 error, so it's CI-friendly |
| `zenloop run --url https://your-preview.vercel.app` | Runs the same specs against a deployed preview or production URL |
| `zenloop approve-specs` | The human signs off on an intentional edit to a failing spec, so it isn't flagged as tampering |
| `zenloop gate` | The Stop-hook entry point. Reads Claude Code's hook JSON on stdin |
| `zenloop report [--open]` | Writes `.zenloop/report.html`: every loop, attempt, assertion and Kane evidence link |
| `zenloop doctor` | Checks the environment |
| `zenloop reset` | Clears attempt counters and failing state |

## Config (`zenloop.config.json`)

```json
{
  "baseUrl": "http://localhost:3000",
  "specs": "kane",
  "maxAttempts": 3,
  "parallel": 1,
  "trigger": "changes",
  "devServer": { "command": "npm run dev", "readyTimeout": 90 },
  "kane": { "headless": true, "timeout": 240, "maxSteps": 30, "bugDetection": null, "extraArgs": [] }
}
```

If the app isn't reachable and `devServer.command` is set, ZenLoop starts the dev server before verifying.

## Demo: MyZenn Check-in

The demo target is **MyZenn Check-in**, a mental-health web app built from the MySanctuary toolkit of [MyZenn](https://myzenn.com): breathing, grounding, meditation, games and MySafe professional search. For a wellness app, the most important behaviour is a **"Need help now" crisis button** that must be reachable on every screen, including during an immersive breathing session.

### What happened in real runs (18 Nov 2026, real Kane CLI 0.10.6, real Claude Code sessions)

| run | what the agent was asked | what Kane did | outcome |
|---|---|---|---|
| Hand-made regression | Crisis button hidden on tool pages | ✗ `"Need help now" is visible (observed: false)` → **block** | Fixed → green on attempt 2 |
| Agent run 1 | "Hide every floating/fixed overlay during MyBreath focus mode" | Agent read `kane/` and kept crisis help. Kane ✓ confirmed | Green first try |
| Agent run 2 | "Daily mood check-in using our shadcn Dialog" | Agent saw a Radix modal would make crisis help unclickable and used `modal={false}`. Kane ✓ confirmed | Green first try (agent edited a spec, which ZenLoop now flags) |
| Agent run 3 | "Add 10/20 min sessions and a Body Relaxation theme to MyPeace" | ✗ Caught a **pre-existing silent failure**: "Begin Session" did nothing when the mic was denied → **block** | Agent fixed 2 real bugs (silent error, plus failed connect reported as "completed") → green, then green on **production** |

Along the way Kane also taught ZenLoop two things:
- **Running Kane sessions in parallel on one machine makes the browsers interfere with each other**, so specs run one at a time by default and browser crashes are retried.
- **"Either A or B" assertions are evaluated as two separate checks**, so write specs deterministically. Kane's own summary pointed this out ("The test incorrectly treated that valid response as a failure"). Spec changes are a human decision (`zenloop approve-specs`), never the agent's.

The demo app's code predates this hackathon and isn't part of this submission. It's the codebase ZenLoop protects, the same way you'd point ZenLoop at your own app. Everything in this repo was written during the hackathon.

## How it was built

ZenLoop was built with **Claude Code**, and Kane CLI checked it from the first run: every spec, the parser and the feedback format were developed against real `kane-cli run --agent` NDJSON output.

## License

MIT
