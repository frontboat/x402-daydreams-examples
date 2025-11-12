# Schema Explorer agent

This is a simple example that demonstrates usage of the daydreamsai/core library, the lucid-agents/agent-kit package, and openrouter/ai-sdk-provider. 

Paid (or optionally free) concierge template you can point at any API surface. It is optimized for exploring x402-protected resources, surfacing any `accepts` or schema metadata even when the upstream returns `402 Payment Required`. The agent combines:

- **Daydreams contexts** for per-session memory (request count, rolling transcript, last user message)
- **OpenRouter LLM** for the actual support responses
- **Agent Kit** for the HTTP surface, manifest, and x402 paywalling

## Install

```bash
bun install
```

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | ✅ | API key passed to `@openrouter/ai-sdk-provider` |
| `OPENROUTER_MODEL` |  | Defaults to `google/gemini-2.5-flash` |
| `OPENROUTER_TEMPERATURE` |  | Float, defaults to `0.2` |
| `DAYDREAMS_LOG_LEVEL` |  | `debug` for verbose context logs |
| `SCHEMAAGENT_DISABLE_PAYMENTS` |  | Set to `true` to bypass the x402 paywall (dev only) |
| `FACILITATOR_URL` | ✅* | x402 facilitator endpoint |
| `PAYMENTS_RECEIVABLE_ADDRESS` | ✅* | Wallet/address receiving payments |
| `NETWORK` | ✅* | x402 network id (e.g., `base-sepolia`) |
| `DEFAULT_PRICE` / `SCHEMAAGENT_DEFAULT_PRICE` | ✅* | Per-invoke price (string, e.g., `"$0.01"` or `"0.001"`) |
| `PORT` |  | Bun server port (defaults to `3000`) |

\*Set `SCHEMAAGENT_DISABLE_PAYMENTS=true` locally if you want to skip the x402 paywall. Otherwise the resolved payment config is enforced for both GET and POST routes.

## Run locally

```bash
bun run index.ts
```

You should see:

```
Schema agent running on http://localhost:3000
```

## Interacting with the agent

Health/manifests are the usual Agent Kit routes:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/entrypoints | jq
curl http://localhost:3000/.well-known/agent.json | jq
```

Invoke the paid (or free, if payments disabled) entrypoint:

```bash
curl -s \
  -H 'content-type: application/json' \
  -X POST http://localhost:3000/entrypoints/support/invoke \
  -d '{"input":{"message":"How do I prep a request payload? to http://localhost:3000/entrypoints/support/invoke ?"}}' \
  | jq
```

Need the schema without paying? `GET http://localhost:3000/entrypoints/support/invoke` returns the same description plus input/output field metadata so tools like x402scan can introspect the endpoint.

The agent is intentionally exploratory: if a user references an unfamiliar x402 resource it will call `fetch-schema`, inspect the HTTP status/body (even 402 errors), and describe any payment headers, networks, or schema fields that appear.

### Sessions & memory

- Include `sessionId` in the request body to bind to a context container. If omitted, the server generates a UUID and returns it in the response.
- Daydreams stores the transcript + counters per session. We keep only the most recent 20 utterances to avoid bloat.
- The server logs `[schema-agent] session=<id>` for each invocation; set `DAYDREAMS_LOG_LEVEL=debug` for full Daydreams context traces.

### Daydreams actions (tools)

- `fetch-schema`: performs an empty JSON POST against the provided URL so the agent can read schema or pricing metadata (including 402 responses). The action always returns the HTTP status code and parsed body, so even paywalled endpoints that include `accepts` data are visible to the model.
  - The action executes inside the active Daydreams context, so results stay scoped to that session. Callers never see another user’s action history.
  - You can persist snippets (e.g., `ctx.memory.lastJobCheck = jobId`) if you want longer-term recall within the same `sessionId`.

### Payments

- Set the x402 env vars plus `SCHEMAAGENT_DEFAULT_PRICE`/`DEFAULT_PRICE` to enforce payment. Agent Kit’s middleware will reject requests unless the payment proof covers the configured price.
- During development you can leave `payments: false` (as currently checked in) or temporarily point the price to a minimal value such as `"0.0001"`.

## Testing

Type check the project:

```bash
bunx tsc --noEmit
```
