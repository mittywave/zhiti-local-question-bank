import { aiProviderModelsUrl } from "../ai-provider-rules.mjs";
import { aiFetch, readAiBody } from "./ai-http";
export type AntigravityResult = { text?: string; error?: string; status: number; retryAfter?: string | null };

type JsonSchema = Record<string, unknown>;

function geminiResponseSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiResponseSchema);
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const anyOf = Array.isArray(input.anyOf) ? input.anyOf as Array<Record<string, unknown>> : null;
  if (anyOf) {
    const nonNull = anyOf.filter((variant) => variant.type !== "null");
    if (nonNull.length === 1 && nonNull.length !== anyOf.length) {
      return { ...(geminiResponseSchema(nonNull[0]) as Record<string, unknown>), nullable: true };
    }
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(input)) {
    if (key === "type" && Array.isArray(nested)) {
      const nonNull = nested.filter((type) => type !== "null");
      output.type = nonNull.length === 1 ? nonNull[0] : nonNull;
      if (nonNull.length !== nested.length) output.nullable = true;
      continue;
    }
    output[key] = geminiResponseSchema(nested);
  }
  return output;
}

export function antigravityApiBase(configuredBase: string) {
  return aiProviderModelsUrl(configuredBase, "antigravity_gemini").replace(/\/models$/, "");
}

function inlineImage(image: string) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(image);
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

function responseText(payload: Record<string, unknown>) {
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }>
    : [];
  const parts = candidates[0]?.content?.parts ?? [];
  const text = parts.map((part) => part.text).filter((part): part is string => typeof part === "string").join("");
  return text || undefined;
}

function thinkingLevel(effort: string) {
  if (effort === "none") return "MINIMAL";
  if (effort === "low") return "LOW";
  if (effort === "medium") return "MEDIUM";
  return "HIGH";
}

export async function callAntigravityGemini(
  configuredBase: string,
  apiKey: string,
  model: string,
  prompt: string,
  images: string[],
  schema: JsonSchema,
  reasoningEffort = "high",
  signal?: AbortSignal,
): Promise<AntigravityResult> {
  const imageParts = images.map(inlineImage).filter((part): part is NonNullable<typeof part> => Boolean(part));
  const endpoint = `${antigravityApiBase(configuredBase)}/models/${encodeURIComponent(model)}:generateContent`;
  const response = await aiFetch(endpoint, {
    signal,
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }, ...imageParts] }],
      generationConfig: {
        thinkingConfig: { thinkingLevel: thinkingLevel(reasoningEffort) },
        responseMimeType: "application/json",
        responseSchema: geminiResponseSchema(schema),
      },
    }),
  });
  const retryAfter = response.headers.get("retry-after");
  const raw = await readAiBody(response);
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { status: response.status, retryAfter, error: `Antigravity 返回了非 JSON 响应（HTTP ${response.status}）` };
  }
  const error = payload.error as { message?: string } | undefined;
  return {
    status: response.status,
    retryAfter,
    text: response.ok ? responseText(payload) : undefined,
    error: error?.message || (!response.ok ? `Antigravity 请求失败（${response.status}）` : undefined),
  };
}
