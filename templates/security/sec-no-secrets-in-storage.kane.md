---
name: "Security: no secrets in localStorage"
path: /
severity: critical
---
Go to the page and let it fully load.
Assert: localStorage has no key named 'password', 'secret', 'api_key', 'card_number' or 'ssn'.
Assert: no localStorage value looks like an API key or secret (a value starting with AIza, sk-, gsk_ or pk_live).
