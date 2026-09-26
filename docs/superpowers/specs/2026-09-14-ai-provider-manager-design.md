# AI Provider Manager Design

## Goal

Replace hard-coded relay configuration as the primary AI configuration path with an administrator-managed global provider, while keeping the existing `OPENAI_*` / Wrangler Secret configuration as a safe fallback.

## Architecture

The browser never calls a relay directly. The administrator configures provider name, Base URL, API key, protocol and task models in `/settings/ai`. Same-origin admin APIs validate the input, fetch the upstream `/models` endpoint from the Worker, and persist the global configuration in D1.

The API key is encrypted with AES-GCM before D1 storage. Production encryption uses the `AI_PROVIDER_ENCRYPTION_KEY` Worker Secret. Local development may use a development-only key only when `LOCAL_ADMIN_MODE=true`.

A server-side runtime resolver chooses the database provider first. If it is missing or disabled, the resolver falls back to the existing environment variables. This keeps current local and Cloudflare deployments functional during migration.

## Model roles

The global provider assigns models independently for:

- screenshot / document recognition;
- text optimization;
- diagram reconstruction;
- homework grading.

Empty role selections fall back to the recognition model, then another configured role model.

## Protocols

Supported modes are `auto`, `responses`, `chat_completions`, and the existing `antigravity_gemini` adapter. `auto` tries Responses first and then Chat Completions, preserving current behavior.

## Security

- Provider write, model discovery and configuration read APIs require an admin user.
- API keys are never returned to the browser after saving; only `hasApiKey` is exposed.
- Relay calls originate from the Worker, avoiding browser CORS and key exposure.
- Production rejects plain HTTP provider URLs.
- Existing environment secrets remain available only server-side as a fallback.

## Compatibility

Existing AI routes keep their current public contracts. Recognition, optimization, diagram reconstruction and homework grading are switched to one server-side gateway. If no D1 provider exists, behavior remains driven by the current environment variables.
