import test from "node:test";
import assert from "node:assert/strict";
import * as rules from "../lib/ai-provider-rules.mjs";

test("normalizes provider base URLs to an OpenAI-compatible v1 base", () => {
  assert.equal(rules.normalizeAiProviderApiBase("https://relay.example.com"), "https://relay.example.com/v1");
  assert.equal(rules.normalizeAiProviderApiBase("https://relay.example.com/v1/"), "https://relay.example.com/v1");
  assert.equal(rules.normalizeAiProviderApiBase("https://relay.example.com/v1/chat/completions"), "https://relay.example.com/v1");
  assert.equal(rules.normalizeAiProviderApiBase("https://relay.example.com/v1/responses"), "https://relay.example.com/v1");
});

test("builds a models endpoint from the normalized API base", () => {
  assert.equal(rules.aiProviderModelsUrl("https://relay.example.com"), "https://relay.example.com/v1/models");
  assert.equal(rules.aiProviderModelsUrl("https://relay.example.com/v1"), "https://relay.example.com/v1/models");
});

test("parses and deduplicates an OpenAI-style model catalog", () => {
  assert.deepEqual(rules.parseAiProviderModelCatalog({ data: [
    { id: "gpt-5.6", display_name: "GPT 5.6" },
    { id: "gemini-3.8-flash-high", displayName: "Gemini Flash" },
    { id: "GPT-5.6" }, { id: "" }, null,
  ] }), [
    { id: "gpt-5.6", displayName: "GPT 5.6" },
    { id: "gemini-3.8-flash-high", displayName: "Gemini Flash" },
  ]);
});

test("normalizes wire API values and falls back to auto", () => {
  assert.equal(rules.normalizeAiProviderWireApi("responses"), "responses");
  assert.equal(rules.normalizeAiProviderWireApi("chat"), "chat_completions");
  assert.equal(rules.normalizeAiProviderWireApi("antigravity_gemini"), "antigravity_gemini");
  assert.equal(rules.normalizeAiProviderWireApi("unknown"), "auto");
});

test("selects a task-specific model with sensible fallbacks", () => {
  const config = { recognitionModel: "vision-a", textModel: "text-a", diagramModel: "", gradingModel: "" };
  assert.equal(rules.selectAiProviderRoleModel(config, "recognition"), "vision-a");
  assert.equal(rules.selectAiProviderRoleModel(config, "text"), "text-a");
  assert.equal(rules.selectAiProviderRoleModel(config, "diagram"), "vision-a");
  assert.equal(rules.selectAiProviderRoleModel(config, "grading"), "vision-a");
});

test("auto protocol retries a generic upstream 500 instead of aborting teacher recognition", () => {
  assert.equal(rules.shouldTryAlternateAiProtocol({ status: 500, retryAfter: null }), true);
});

test("auto protocol does not switch on auth, rate limit, timeout, or explicit retry-after", () => {
  assert.equal(rules.shouldTryAlternateAiProtocol({ status: 401, retryAfter: null }), false);
  assert.equal(rules.shouldTryAlternateAiProtocol({ status: 403, retryAfter: null }), false);
  assert.equal(rules.shouldTryAlternateAiProtocol({ status: 408, retryAfter: null }), false);
  assert.equal(rules.shouldTryAlternateAiProtocol({ status: 429, retryAfter: null }), false);
  assert.equal(rules.shouldTryAlternateAiProtocol({ status: 503, retryAfter: "30" }), false);
});

test("auto protocol adds Antigravity as a final Gemini compatibility path", () => {
  assert.deepEqual(rules.aiProviderAutoProtocolOrder("gemini-3.8-flash-high"), ["responses", "chat_completions", "antigravity_gemini"]);
  assert.deepEqual(rules.aiProviderAutoProtocolOrder("google/gemini-3.8-flash-high"), ["responses", "chat_completions", "antigravity_gemini"]);
  assert.deepEqual(rules.aiProviderAutoProtocolOrder("gpt-5.6"), ["responses", "chat_completions"]);
});
