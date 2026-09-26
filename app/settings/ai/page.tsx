"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { canReuseAiProviderKey } from "../../../lib/ai-provider-rules.mjs";

type WireApi = "auto" | "responses" | "chat_completions" | "antigravity_gemini";
type Model = { id: string; displayName?: string };
type ProviderConfig = {
  name: string; baseUrl: string; wireApi: WireApi; modelCatalog: Model[];
  recognitionModel: string; textModel: string; diagramModel: string; gradingModel: string;
  enabled: boolean; hasApiKey: boolean; updatedAt: number;
};
type Draft = Omit<ProviderConfig, "hasApiKey" | "updatedAt"> & { apiKey: string };
const emptyDraft: Draft = { name: "AI Provider", baseUrl: "", apiKey: "", wireApi: "auto", modelCatalog: [], recognitionModel: "", textModel: "", diagramModel: "", gradingModel: "", enabled: true };
const pageStyle: React.CSSProperties = { maxWidth: 920, overflowWrap: "anywhere", margin: "0 auto", padding: "36px 24px 64px", fontFamily: "system-ui, sans-serif" };
const cardStyle: React.CSSProperties = { border: "1px solid #ddd", borderRadius: 14, padding: 20, marginTop: 18 };
const fieldStyle: React.CSSProperties = { display: "grid", gap: 7, marginTop: 14 };
const inputStyle: React.CSSProperties = { width: "100%", minWidth: 0, boxSizing: "border-box", padding: "10px 12px", border: "1px solid #bbb", borderRadius: 8, fontSize: 14 };
const buttonStyle: React.CSSProperties = { border: 0, borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontWeight: 650 };

export default function AiSettingsPage() {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [savedBaseUrl, setSavedBaseUrl] = useState("");
  const [encryptionReady, setEncryptionReady] = useState(true);
  const endpointChanged = hasSavedKey && !canReuseAiProviderKey(savedBaseUrl, draft.baseUrl);
  const needsKey = !hasSavedKey || endpointChanged;
  const hasModel = [draft.recognitionModel, draft.textModel, draft.diagramModel, draft.gradingModel].some(model => model.trim());
  const [environmentFallback, setEnvironmentFallback] = useState<{ configured?: boolean; baseUrl?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [manualModel, setManualModel] = useState("");
  const modelOptions = useMemo(() => {
    const models = [...draft.modelCatalog];
    for (const id of [draft.recognitionModel, draft.textModel, draft.diagramModel, draft.gradingModel]) {
      if (id && !models.some(model => model.id === id)) models.push({ id });
    }
    return models;
  }, [draft.modelCatalog, draft.recognitionModel, draft.textModel, draft.diagramModel, draft.gradingModel]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    fetch("/api/admin/ai-provider", { cache: "no-store", signal })
      .then(async response => {
        const payload = await response.json() as { config?: ProviderConfig | null; encryptionReady?: boolean; environmentFallback?: { configured?: boolean; baseUrl?: string }; error?: string };
        if (signal.aborted) return;
        if (!response.ok) throw new Error(payload.error || "读取 AI Provider 配置失败");
        if (payload.config) {
          const { hasApiKey, updatedAt, ...config } = payload.config;
          void updatedAt;
          setDraft({ ...config, apiKey: "" });
          setHasSavedKey(hasApiKey);
          setSavedBaseUrl(config.baseUrl);
        }
        setEnvironmentFallback(payload.environmentFallback ?? null);
        setEncryptionReady(payload.encryptionReady !== false);
      })
      .catch(value => { if (!signal.aborted) setError(value instanceof Error ? value.message : "读取失败"); })
      .finally(() => { if (!signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function fetchModels() {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/ai-provider/models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: draft.baseUrl, apiKey: draft.apiKey, wireApi: draft.wireApi }),
        signal: AbortSignal.timeout(25_000),
      });
      const payload = await response.json() as { models?: Model[]; latencyMs?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || "获取模型失败");
      const models = payload.models ?? [];
      setDraft((current) => ({ ...current, modelCatalog: models }));
      setNotice(`已从上游获取 ${models.length} 个模型${typeof payload.latencyMs === "number" ? ` · ${payload.latencyMs} ms` : ""}`);
    } catch (value) { setError(value instanceof Error ? value.message : "获取模型失败"); }
    finally { setBusy(false); }
  }
  function addManualModel() {
    const id = manualModel.trim();
    if (!id) return;
    setDraft((current) => current.modelCatalog.some((item) => item.id.toLowerCase() === id.toLowerCase()) ? current : { ...current, modelCatalog: [...current.modelCatalog, { id }] });
    setManualModel("");
  }
  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/ai-provider", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft), signal: AbortSignal.timeout(25_000),
      });
      const payload = await response.json() as { config?: ProviderConfig; error?: string };
      if (!response.ok || !payload.config) throw new Error(payload.error || "保存失败");
      const { hasApiKey, updatedAt, ...config } = payload.config;
      void updatedAt;
      setDraft({ ...config, apiKey: "" }); setHasSavedKey(hasApiKey); setSavedBaseUrl(config.baseUrl);
      setNotice(config.enabled ? "AI Provider 已保存，后续请求使用所选任务模型。" : "数据库 Provider 已停用，将使用环境变量配置（如有）。");
    } catch (value) { setError(value instanceof Error ? value.message : "保存失败"); }
    finally { setBusy(false); }
  }
  const modelSelect = (label: string, key: "recognitionModel" | "textModel" | "diagramModel" | "gradingModel") => (
    <label style={fieldStyle}>
      <span>{label}</span>
      <select aria-label={label} style={inputStyle} value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}>
        <option value="">自动回退到其他已选模型</option>
        {modelOptions.map((model) => <option key={model.id} value={model.id}>{model.displayName ? `${model.displayName} · ${model.id}` : model.id}</option>)}
      </select>
    </label>
  );
  return <main style={pageStyle}>
    <Link href="/" style={{ textDecoration: "none" }}>← 返回题库</Link>
    <h1 style={{ marginBottom: 6 }}>AI Provider</h1>
    <p style={{ color: "#666", marginTop: 0 }}>管理员统一配置中转站并从上游拉取模型。API Key 只发送到本站 Worker，不会从保存接口返回浏览器。</p>
    {loading ? <p>正在读取配置…</p> : <>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <section style={cardStyle}>
        <label style={{ display: "flex", gap: 9, alignItems: "center" }}>
          <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
          启用数据库中的 Provider 配置
        </label>
        <label style={fieldStyle}><span>名称</span><input style={inputStyle} value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：灵算 / Sub2API / OpenRouter" /></label>
        <label style={fieldStyle}><span>Base URL</span><input style={inputStyle} value={draft.baseUrl} onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://relay.example.com/v1" /></label>
        <label style={fieldStyle}><span>API Key</span><input style={inputStyle} type="password" autoComplete="off" value={draft.apiKey} onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))} placeholder={needsKey ? "请填写该地址对应的 API Key" : "已保存密钥；留空表示保持不变"} /></label>
        <label style={fieldStyle}><span>API 协议</span><select aria-label="API 协议" style={inputStyle} value={draft.wireApi} onChange={(event) => setDraft((current) => ({ ...current, wireApi: event.target.value as WireApi }))}><option value="auto">自动：Responses → Chat Completions（Gemini 可再尝试 Antigravity）</option><option value="responses">Responses</option><option value="chat_completions">Chat Completions</option><option value="antigravity_gemini">Antigravity Gemini</option></select></label>
        <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}><button style={{ ...buttonStyle, background: "#eee" }} disabled={busy || !draft.baseUrl.trim() || (needsKey && !draft.apiKey.trim())} onClick={() => void fetchModels()}>{busy ? "处理中…" : "获取上游模型"}</button></div>
      </section>
      <section style={cardStyle}>
        <h2 style={{ marginTop: 0 }}>模型目录 <small style={{ fontSize: 14, color: "#777" }}>({draft.modelCatalog.length})</small></h2>
        <div style={{ display: "flex", gap: 8 }}><input style={inputStyle} value={manualModel} onChange={(event) => setManualModel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManualModel(); } }} placeholder="上游不提供 /models 时，可手动添加模型 ID" /><button style={{ ...buttonStyle, background: "#eee", flexShrink: 0 }} onClick={addManualModel}>添加</button></div>
        {draft.modelCatalog.length > 0 && <div style={{ maxHeight: 180, overflow: "auto", marginTop: 12, border: "1px solid #eee", borderRadius: 8, padding: 10 }}>{draft.modelCatalog.map((model) => <div key={model.id} style={{ padding: "4px 2px", fontFamily: "ui-monospace, monospace", fontSize: 13 }}>{model.id}</div>)}</div>}
        {modelSelect("截图 / 文件识题", "recognitionModel")}
        {modelSelect("文字优化 / 解析", "textModel")}
        {modelSelect("几何图重绘", "diagramModel")}
        {modelSelect("作业批改", "gradingModel")}
      </section>
      </fieldset>
      <section style={cardStyle}>
        <strong>兼容回退：</strong>{environmentFallback?.configured ? ` 已检测到环境变量 Provider（${environmentFallback.baseUrl || "已配置"}）` : " 未检测到 OPENAI_API_KEY"}。当上面的 Provider 未配置或停用时，系统继续使用原有 `.env.local` / Cloudflare Secret。
      </section>
      {endpointChanged && <p role="status" style={{ color: "#b42318" }}>Base URL 已变化，必须重新输入该地址的 API Key；旧密钥不会发送到新地址。</p>}
      {draft.enabled && !hasModel && <p role="status">请至少选择一个任务模型后再启用 Provider。未指定的任务将使用其他已选模型。</p>}
      {!encryptionReady && <p role="alert">生产环境尚未设置 AI_PROVIDER_ENCRYPTION_KEY Worker Secret，暂时不能保存新密钥。</p>}
      {error && <p style={{ color: "#b42318", fontWeight: 650 }}>{error}</p>}
      {notice && <p style={{ color: "#067647", fontWeight: 650 }}>{notice}</p>}
      <button style={{ ...buttonStyle, marginTop: 18, background: "#111", color: "white", minWidth: 140 }} disabled={busy || !draft.baseUrl.trim() || (needsKey && !draft.apiKey.trim()) || (draft.enabled && !hasModel) || (!encryptionReady && Boolean(draft.apiKey.trim()))} onClick={() => void save()}>{busy ? "保存中…" : "保存配置"}</button>
    </>}
  </main>;
}
