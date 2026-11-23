---
name: "Security: no API keys or secrets sent from the browser"
path: /
severity: critical
---
Go to the page and let it fully load, then scroll to the bottom and back to the top so background requests fire.
Assert: no network request URL contains an API key or secret, such as a query parameter named key, api_key, apikey, token or access_token whose value starts with AIza, sk-, gsk_ or pk_live.
Assert: no network request sends an Authorization header with a long-lived secret key starting with sk-, gsk_ or AIza directly to a third-party AI or cloud API.
