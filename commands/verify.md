---
description: Run ZenLoop's Kane CLI specs now and fix anything that fails
---

Run `zenloop run --all --feedback` in the project root (fall back to `node "${CLAUDE_PLUGIN_ROOT}/bin/zenloop.mjs" run --all --feedback` if `zenloop` is not on PATH).

If any spec fails, read Kane's verdict, fix the application code (never the files in `kane/`), and run it again until every spec passes. Finish with `zenloop report` and tell the user where the report is.
