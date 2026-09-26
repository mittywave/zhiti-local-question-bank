# AI Provider Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:test-driven-development and verification-before-completion while executing this plan.

**Goal:** Add a global administrator-managed AI relay and model selector without breaking the existing environment-based configuration.

**Architecture:** D1 stores one encrypted global provider row. Admin-only Worker APIs save configuration and discover upstream models. A runtime resolver feeds one structured AI gateway used by recognition, text optimization, diagram reconstruction and homework grading. Existing `OPENAI_*` values remain the fallback.

**Tech Stack:** TypeScript, Vinext/Vite, Cloudflare Workers, D1, Web Crypto AES-GCM, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-14-ai-provider-manager-design.md`

### Task 1: Pure provider rules

**Files:** `lib/ai-provider-rules.mjs`, `lib/ai-provider-rules.d.mts`, `tests/ai-provider-rules.test.mjs`

1. Write failing tests for Base URL normalization, `/models`, catalog parsing, protocol normalization and task-model fallback.
2. Run `node --test tests/ai-provider-rules.test.mjs` and verify RED.
3. Implement the rules.
4. Re-run and verify GREEN.

### Task 2: D1 persistence and secret encryption

**Files:** `migrations/0014_ai_provider_config.sql`, `lib/server/ai-provider.ts`

1. Add a single-row global provider table.
2. Encrypt API keys with AES-GCM using `AI_PROVIDER_ENCRYPTION_KEY`; allow a local-only development key when `LOCAL_ADMIN_MODE=true`.
3. Expose public configuration without returning plaintext keys.
4. Resolve database provider first and environment fallback second.

### Task 3: Unified structured AI gateway

**Files:** `lib/server/ai-gateway.ts`, `lib/server/recognition-model.ts`, `lib/server/homework-model.ts`

1. Centralize Responses, Chat Completions and Antigravity request logic.
2. Preserve auto fallback and Retry-After behavior.
3. Resolve the model by task role.

### Task 4: Admin APIs and UI

**Files:** `lib/server/auth.ts`, `app/api/admin/ai-provider/route.ts`, `app/api/admin/ai-provider/models/route.ts`, `app/settings/ai/page.tsx`

1. Add `requireAdmin`.
2. Add admin-only configuration read/write API.
3. Add server-side model discovery.
4. Build `/settings/ai` with provider credentials, protocol selector, model discovery and four role selectors.

### Task 5: Migrate AI callers

**Files:** recognition routes, optimization route, diagram reconstruction route, homework grading.

1. Remove direct route-level `OPENAI_API_KEY` dependence.
2. Route all structured AI calls through the unified gateway.
3. Keep deterministic homework-report fallback when AI is unavailable.

### Task 6: Documentation and verification

1. Document the new settings page and production encryption secret.
2. Run `npm run lint`.
3. Run `npm test`.
4. Locally apply migrations with `npx wrangler d1 migrations apply zhiti-question-bank --local` and test `/settings/ai` before any production deployment.
