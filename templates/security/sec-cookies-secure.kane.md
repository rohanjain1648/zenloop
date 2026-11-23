---
name: "Security: every cookie has the Secure flag"
path: /
severity: normal
deployed_only: true
---
Go to the page and let it fully load.
Assert: no cookie is set without the Secure flag.
