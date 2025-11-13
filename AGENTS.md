# Repository Guidelines

## Project Structure & Module Organization
Schema Explorer is a Bun/TypeScript service rooted at `index.ts`, which wires Daydreams contexts, Lucid Agent Kit routes, and OpenRouter completions. `index.html` offers a minimal chat surface for manual QA, while `README.md` documents curls and env vars—keep both synchronized when interfaces change. Config artifacts (`tsconfig.json`, `bun.lock`, `package.json`) live at the root so editors resolve modules automatically; place future tests in `tests/` and static payloads in `fixtures/` to keep the runtime entry lean.

## Build, Test, and Development Commands
- `bun install` — install runtime deps and Bun types.
- `bun run index.ts` — boots the Hono server; expect `http://localhost:3000`.
- `bun --watch run index.ts` — hot-reloads during handler work.
- `bunx tsc --noEmit` — current type-only CI gate.
- `curl http://localhost:3000/entrypoints | jq` and `curl -X POST http://localhost:3000/entrypoints/explore/invoke -d '{"input":{"message":"ping"}}'` — smoke the manifest and paid entrypoint after edits.

## Coding Style & Naming Conventions
Stick to 2-space indentation, ESM imports, and `const` functions. Favor descriptive names (`supportMemory`, `resolveLogLevel`) and colocate helpers next to their consumers. Use the structured `logger` already defined in `index.ts`; no ad-hoc `console.log`. Uppercase env constants, prefer `z` schemas for any user input, and keep `index.ts` declarative by exporting new utilities from dedicated modules.

## Testing Guidelines
Until a richer suite exists, run `bunx tsc --noEmit` plus the curls above for every change. Add future specs under `tests/*.spec.ts` and execute with `bun test`; mirror the request payloads used in production so schema changes are caught early. When mocking external services (x402 facilitator, OpenRouter), document the stub behavior in the test file header.

## Commit & Pull Request Guidelines
History shows short, imperative subjects (`add headers`, `simplify stringy responses`); keep that pattern (<50 chars, no trailing period). PRs should describe the behavior change, list any new env vars, and paste the curl/console evidence you used for verification. Link relevant issues and drop screenshots when `index.html` UX changes.

## Environment & Security Tips
Secrets such as `OPENROUTER_API_KEY`, facilitator URLs, and wallets stay in your shell or `.env.local`; never commit them. For local work, set `SCHEMAAGENT_DISABLE_PAYMENTS=true`, but validate paywall configs (`FACILITATOR_URL`, `PAYMENTS_RECEIVABLE_ADDRESS`, `NETWORK`, `SCHEMAAGENT_DEFAULT_PRICE`) before pushing. Keep `DAYDREAMS_LOG_LEVEL` at `info` in shared environments to avoid leaking session transcripts; only raise it briefly when debugging.
