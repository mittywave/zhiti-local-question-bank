import { env } from "cloudflare:workers";
import {
  aiProviderModelsUrl,
  canReuseAiProviderKey,
  normalizeAiProviderApiBase,
  normalizeAiProviderWireApi,
  parseAiProviderModelCatalog,
  selectAiProviderRoleModel,
  type AiProviderModel,
  type AiProviderRole,
  type AiProviderWireApi,
} from "../ai-provider-rules.mjs";

import { aiFetch, aiTimeoutMs, readAiBody, withAiDeadline } from "./ai-http";

export class AiProviderInputError extends Error {}

type ProviderEnv = {
  DB: D1Database;
  AI_PROVIDER_ENCRYPTION_KEY?: string;
  LOCAL_ADMIN_MODE?: string;
};

type ProviderRow = {
  id: string;
  name: string;
  base_url: string;
  api_key_encrypted: string;
  wire_api: string;
  model_catalog_json: string;
  recognition_model: string;
  text_model: string;
  diagram_model: string;
  grading_model: string;
  enabled: number;
  updated_at: number;
};

export type AiProviderPublicConfig = {
  name: string;
  baseUrl: string;
  wireApi: AiProviderWireApi;
  modelCatalog: AiProviderModel[];
  recognitionModel: string;
  textModel: string;
  diagramModel: string;
  gradingModel: string;
  enabled: boolean;
  hasApiKey: boolean;
  updatedAt: number;
};

export type AiProviderSaveInput = Omit<AiProviderPublicConfig, "hasApiKey" | "updatedAt" | "modelCatalog"> & {
  apiKey?: string;
  modelCatalog?: AiProviderModel[];
};

export type AiRuntime = {
  source: "database" | "environment";
  providerName: string;
  baseUrl: string;
  apiKey: string;
  wireApi: AiProviderWireApi;
  model: string;
};

const GLOBAL_PROVIDER_ID = "global";
const LOCAL_DEVELOPMENT_ENCRYPTION_SECRET = "zhiti-local-ai-provider-development-key-v1-only";

function providerEnv(): ProviderEnv {
  const bindings = env as unknown as ProviderEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings;
}

function isMissingProviderTable(error: unknown) {
  return error instanceof Error && /no such table:\s*ai_provider_config/i.test(error.message);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encryptionSecret() {
  const bindings = providerEnv();
  const configured = (bindings.AI_PROVIDER_ENCRYPTION_KEY || process.env.AI_PROVIDER_ENCRYPTION_KEY || "").trim();
  if (configured) return configured;
  if (bindings.LOCAL_ADMIN_MODE === "true") return LOCAL_DEVELOPMENT_ENCRYPTION_SECRET;
  throw new Error("线上保存 AI Provider 前请先配置 AI_PROVIDER_ENCRYPTION_KEY Worker Secret");
}

async function encryptionKey() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptionSecret()));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptApiKey(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), new TextEncoder().encode(value));
  return JSON.stringify({ v: 1, iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) });
}

async function decryptApiKey(value: string) {
  const payload = JSON.parse(value) as { v?: number; iv?: string; data?: string };
  if (payload.v !== 1 || !payload.iv || !payload.data) throw new Error("AI Provider API Key 密文格式无效");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    await encryptionKey(),
    base64ToBytes(payload.data),
  );
  return new TextDecoder().decode(decrypted);
}

function parseCatalog(value: string): AiProviderModel[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        id: typeof item?.id === "string" ? item.id.trim() : "",
        displayName: typeof item?.displayName === "string" ? item.displayName.trim() : undefined,
      }))
      .filter((item) => item.id)
      .slice(0, 500);
  } catch {
    return [];
  }
}

async function providerRow(): Promise<ProviderRow | null> {
  try {
    return await providerEnv().DB.prepare("SELECT * FROM ai_provider_config WHERE id = ?")
      .bind(GLOBAL_PROVIDER_ID).first<ProviderRow>();
  } catch (error) {
    if (isMissingProviderTable(error)) return null;
    throw error;
  }
}

function rowToPublic(row: ProviderRow): AiProviderPublicConfig {
  return {
    name: row.name,
    baseUrl: row.base_url,
    wireApi: normalizeAiProviderWireApi(row.wire_api),
    modelCatalog: parseCatalog(row.model_catalog_json),
    recognitionModel: row.recognition_model,
    textModel: row.text_model,
    diagramModel: row.diagram_model,
    gradingModel: row.grading_model,
    enabled: Boolean(row.enabled),
    hasApiKey: Boolean(row.api_key_encrypted),
    updatedAt: Number(row.updated_at) || 0,
  };
}

function validateRemoteBaseUrl(baseUrl: string) {
  let normalized: string;
  try { normalized = normalizeAiProviderApiBase(baseUrl); }
  catch { throw new AiProviderInputError("请输入有效的 HTTP(S) Base URL，且不能包含用户名或密码"); }
  const url = new URL(normalized);
  if (url.protocol === "http:" && providerEnv().LOCAL_ADMIN_MODE !== "true") {
    throw new AiProviderInputError("线上 AI Provider 必须使用 HTTPS Base URL");
  }
  return normalized;
}

function cleanModelCatalog(input: AiProviderModel[] | undefined) {
  const seen = new Set<string>();
  return (input ?? []).flatMap((item) => {
    const id = item.id?.trim();
    if (!id) return [];
    const key = id.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const displayName = item.displayName?.trim();
    return [{ id, ...(displayName ? { displayName } : {}) }];
  }).slice(0, 500);
}

export async function getAiProviderConfig() {
  const row = await providerRow();
  return row ? rowToPublic(row) : null;
}

export async function saveAiProviderConfig(input: AiProviderSaveInput) {
  const existing = await providerRow();
  const name = input.name.trim().slice(0, 80) || "AI Provider";
  const baseUrl = validateRemoteBaseUrl(input.baseUrl);
  const wireApi = normalizeAiProviderWireApi(input.wireApi);
  const modelCatalog = cleanModelCatalog(input.modelCatalog);
  if (input.enabled && !selectAiProviderRoleModel(input, "recognition")) {
    throw new AiProviderInputError("启用 Provider 时必须至少选择一个任务模型");
  }
  let encryptedKey = existing?.api_key_encrypted ?? "";
  const suppliedKey = input.apiKey?.trim() ?? "";
  if (!suppliedKey && existing?.api_key_encrypted && !canReuseAiProviderKey(existing.base_url, baseUrl)) {
    throw new AiProviderInputError("Base URL 已变化，请重新输入该 Provider 的 API Key；不会复用旧地址的密钥");
  }
  if (suppliedKey) encryptedKey = await encryptApiKey(suppliedKey);
  if (!encryptedKey) throw new AiProviderInputError("请填写 API Key");
  const now = Date.now();
  await providerEnv().DB.prepare(`
    INSERT INTO ai_provider_config
      (id, name, base_url, api_key_encrypted, wire_api, model_catalog_json, recognition_model, text_model, diagram_model, grading_model, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      base_url = excluded.base_url,
      api_key_encrypted = excluded.api_key_encrypted,
      wire_api = excluded.wire_api,
      model_catalog_json = excluded.model_catalog_json,
      recognition_model = excluded.recognition_model,
      text_model = excluded.text_model,
      diagram_model = excluded.diagram_model,
      grading_model = excluded.grading_model,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).bind(
    GLOBAL_PROVIDER_ID,
    name,
    baseUrl,
    encryptedKey,
    wireApi,
    JSON.stringify(modelCatalog),
    input.recognitionModel.trim().slice(0, 200),
    input.textModel.trim().slice(0, 200),
    input.diagramModel.trim().slice(0, 200),
    input.gradingModel.trim().slice(0, 200),
    input.enabled ? 1 : 0,
    now,
  ).run();
  const saved = await providerRow();
  if (!saved) throw new Error("AI Provider 保存失败");
  return rowToPublic(saved);
}

function legacyModel(role: AiProviderRole) {
  const vision = process.env.OPENAI_VISION_MODEL || "gemini-3.8-flash-high";
  if (role === "text") return process.env.OPENAI_TEXT_MODEL || vision;
  if (role === "grading") return process.env.HOMEWORK_GRADING_MODEL || vision;
  return vision;
}

function legacyRuntime(role: AiProviderRole): AiRuntime | null {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  return {
    source: "environment",
    providerName: "Environment fallback",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey,
    wireApi: normalizeAiProviderWireApi(process.env.OPENAI_API_MODE || "auto"),
    model: legacyModel(role),
  };
}

export async function resolveAiRuntime(role: AiProviderRole): Promise<AiRuntime | null> {
  const row = await providerRow();
  if (row?.enabled) {
    const config = rowToPublic(row);
    const model = selectAiProviderRoleModel(config, role);
    if (!model || !row.api_key_encrypted) throw new Error("已启用的 AI Provider 缺少模型或密钥，请在 AI 设置中修正或停用；未切换到其他供应商");
    if (model) {
      return {
        source: "database",
        providerName: config.name,
        baseUrl: validateRemoteBaseUrl(config.baseUrl),
        apiKey: await decryptApiKey(row.api_key_encrypted),
        wireApi: config.wireApi,
        model,
      };
    }
  }
  return legacyRuntime(role);
}

export function environmentAiFallbackSummary() {
  return {
    configured: Boolean((process.env.OPENAI_API_KEY || "").trim()),
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    wireApi: normalizeAiProviderWireApi(process.env.OPENAI_API_MODE || "auto"),
    recognitionModel: process.env.OPENAI_VISION_MODEL || "gemini-3.8-flash-high",
    textModel: process.env.OPENAI_TEXT_MODEL || process.env.OPENAI_VISION_MODEL || "gemini-3.8-flash-high",
    gradingModel: process.env.HOMEWORK_GRADING_MODEL || process.env.OPENAI_VISION_MODEL || "gemini-3.8-flash-high",
  };
}

export function aiProviderEncryptionReady() {
  const bindings = providerEnv();
  return bindings.LOCAL_ADMIN_MODE === "true" || Boolean((bindings.AI_PROVIDER_ENCRYPTION_KEY || process.env.AI_PROVIDER_ENCRYPTION_KEY || "").trim());
}

export async function discoverAiProviderModels(input: { baseUrl?: string; apiKey?: string; wireApi?: string; signal?: AbortSignal }) {
  input.signal?.throwIfAborted();
  const stored = await providerRow();
  const baseUrl = validateRemoteBaseUrl(input.baseUrl?.trim() || stored?.base_url || "");
  const suppliedKey = input.apiKey?.trim() ?? "";
  if (!suppliedKey && stored?.api_key_encrypted && !canReuseAiProviderKey(stored.base_url, baseUrl)) {
    throw new AiProviderInputError("Base URL 已变化，请重新输入该 Provider 的 API Key；不会向新地址发送旧密钥");
  }
  const apiKey = suppliedKey || (stored?.api_key_encrypted ? await decryptApiKey(stored.api_key_encrypted) : "");
  if (!apiKey) throw new AiProviderInputError("请先填写或保存 API Key");
  const wireApi = normalizeAiProviderWireApi(input.wireApi ?? stored?.wire_api);
  const startedAt = Date.now();
  try {
    return await withAiDeadline(async signal => {
      const response = await aiFetch(aiProviderModelsUrl(baseUrl, wireApi), {
        signal,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
      const text = await readAiBody(response, 2_000_000);
      let payload: unknown = {};
      try { payload = JSON.parse(text); }
      catch { throw new Error(`上游模型目录返回了非 JSON 响应（HTTP ${response.status}）；可手动添加模型 ID`); }
      if (!response.ok) {
        const message = typeof (payload as { error?: { message?: unknown } })?.error?.message === "string"
          ? (payload as { error: { message: string } }).error.message
          : `获取模型失败（HTTP ${response.status}）`;
        throw new Error(`${message}；上游不提供模型目录时可手动添加模型 ID`);
      }
      const models = parseAiProviderModelCatalog(payload);
      if (!models.length) throw new Error("上游没有返回可用模型；可手动添加模型 ID");
      return { models, latencyMs: Date.now() - startedAt };
    }, aiTimeoutMs(process.env.AI_MODELS_TIMEOUT_MS, 15_000), input.signal);
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (error instanceof Error && error.message.includes(apiKey)) throw new Error(error.message.split(apiKey).join("[redacted]"));
    throw error;
  }
}
