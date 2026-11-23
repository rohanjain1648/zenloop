---
name: "Security: deployed build doesn't call staging, localhost or debug endpoints"
path: /
severity: critical
deployed_only: true
---
Go to the page and let it fully load, then open one main navigation link.
Assert: no network request was made to a staging, localhost, 127.0.0.1 or debug URL.
