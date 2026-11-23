---
name: "Reliability: no hidden 5xx or console errors behind a green page"
path: /
severity: normal
---
Go to the page and let it fully load.
Assert: no network request returned a 5xx status.
Assert: there are no console errors.
