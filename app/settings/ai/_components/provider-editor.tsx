'use client';
import {useState} from 'react';
import type {ProviderConfig,ProviderWrite,WireProtocol,EndpointProfile} from '../../../../lib/ai-provider-types';
import {KIND_LABELS,PROTOCOL_LABELS,credentialScope,providerEndpoint} from '../../../../lib/ai-provider-presets';
import css from '../ai-center.module.css';
export function ProviderEditor({draft,saved,change,disabled,fieldError}:{draft:ProviderWrite;saved?:ProviderConfig;change:(p:ProviderWrite)=>void;disabled:boolean;fieldError?:string}) {
  const [show,setShow]=useState(false);
  let changed=false;
  try {changed=Boolean(saved?.hasApiKey&&credentialScope(saved.baseUrl,saved.endpoints)!==credentialScope(draft.baseUrl,draft.endpoints));} catch {changed=Boolean(saved?.hasApiKey);}
  const key=draft.credential.action==='replace'?draft.credential.value:'';
  const efforts=[...new Set(saved?.models.flatMap(m=>m.metadata.effortLevels||[])||[])];
  function path(name:keyof Omit<EndpointProfile,'auth'>){try{return providerEndpoint(draft.baseUrl,draft.endpoints[name],'{model}')||'未配置；允许手动模型';}catch{return '地址或相对路径无效';}}
  return <section aria-label="连接配置"><h2>连接配置</h2><fieldset disabled={disabled}><div className={css.fields}>
    <label>名称<input name="name" maxLength={80} value={draft.name} onChange={e=>change({...draft,name:e.target.value})}/></label>
    <label>接入类型<select aria-label="接入类型" value={draft.kind} onChange={e=>change({...draft,kind:e.target.value as ProviderWrite['kind']})}>{Object.entries(KIND_LABELS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label></div>
    <label>Base URL<input name="baseUrl" aria-invalid={fieldError==='baseUrl'} autoComplete="off" placeholder="https://网关/租户前缀/v1" value={draft.baseUrl} onChange={e=>change({...draft,baseUrl:e.target.value})}/></label>
    {draft.kind==='sub2api'&&<p className={css.hint}>OpenAI 入口通常为 /v1；Antigravity Gemini 通常为 /antigravity/v1beta；Claude 通常为 /antigravity/v1。请按本实例填写完整前缀，系统不会猜测或拼接这些前缀。</p>}
    <div className={css.fields}><label>API 协议<select aria-label="API 协议" name="wireApi" value={draft.wireApi} onChange={e=>change({...draft,wireApi:e.target.value as WireProtocol})}>{Object.entries(PROTOCOL_LABELS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    <label>密钥操作<select aria-label="密钥操作" value={draft.credential.action} onChange={e=>change({...draft,credential:e.target.value==='replace'?{action:'replace',value:''}:{action:e.target.value as 'keep'|'clear'}})}><option value="keep">保留（已保存密钥不会返回浏览器）</option><option value="replace">输入 / 替换</option><option value="clear">清除密钥</option></select></label></div>
    {draft.credential.action==='replace'&&<label>API Key<input name="apiKey" aria-invalid={fieldError==='apiKey'} autoComplete="new-password" type={show?'text':'password'} value={key} onChange={e=>change({...draft,credential:{action:'replace',value:e.target.value}})}/><span><button type="button" onClick={()=>setShow(!show)}>{show?'隐藏输入':'显示本次输入'}</button></span></label>}
    <p className={css.hint}>{saved?.hasApiKey?'已有加密密钥。':'尚未保存密钥。'}复制连接不会复制 Key，清除后需要停用连接。</p>
    {changed&&<p className={css.warning}>地址、租户或认证范围已变化：必须重新输入此地址的 Key，不能复用旧密钥。</p>}
    <label className={css.check}><input type="checkbox" checked={draft.enabled} onChange={e=>change({...draft,enabled:e.target.checked})}/>允许任务使用此连接（保存不自动分配任务）</label>
    <div className={css.endpoints} aria-label="实际端点预览"><small>实际端点预览 · 不自动添加 /v1</small><code>目录：{path('models')}</code>{(draft.wireApi==='auto'?['responses','chat_completions']:[draft.wireApi]).map(p=><code key={p}>{PROTOCOL_LABELS[p as WireProtocol]}：{path(p==='responses'?'responses':p==='chat_completions'?'chat':p==='gemini_generate_content'?'gemini':'messages')}</code>)}</div>
    <details><summary>高级设置</summary><div className={css.fields}>
    <label>请求超时（毫秒）<input name="timeoutMs" type="number" min={1000} max={600000} value={draft.timeoutMs} onChange={e=>change({...draft,timeoutMs:Number(e.target.value)})}/></label>
    <label>目录超时（毫秒）<input name="catalogTimeoutMs" type="number" min={1000} max={60000} value={draft.catalogTimeoutMs} onChange={e=>change({...draft,catalogTimeoutMs:Number(e.target.value)})}/></label>
    <label>结构化输出<select aria-label="结构化输出" value={draft.outputStrategy} onChange={e=>change({...draft,outputStrategy:e.target.value as ProviderWrite['outputStrategy']})}><option value="auto">按证据选择</option><option value="schema">Schema</option><option value="json">JSON mode</option><option value="prompt">仅格式提示 + 本地校验</option></select></label>
    <label>思考档位<input list="ai-efforts" maxLength={40} value={draft.reasoningEffort} onChange={e=>change({...draft,reasoningEffort:e.target.value})} placeholder="留空遵循上游默认"/><datalist id="ai-efforts">{efforts.map(v=><option key={v} value={v}/>)}</datalist><small>建议来自模型目录；Gemini 与 Claude 不发送未声明的思考参数。</small></label>
    <label>认证方案<select aria-label="认证方案" value={draft.endpoints.auth} onChange={e=>change({...draft,endpoints:{...draft.endpoints,auth:e.target.value as EndpointProfile['auth']}})}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="x-goog-api-key">x-goog-api-key</option></select></label>
    {(['models','responses','chat','gemini','messages'] as const).map(n=><label key={n}>{n} 相对路径<input name={n} value={draft.endpoints[n]||''} onChange={e=>change({...draft,endpoints:{...draft.endpoints,[n]:n==='models'&&!e.target.value?null:e.target.value}})}/></label>)}</div><p className={css.hint}>Claude 入口不保证有模型目录；可将 models 留空。仅接受当前 Base URL 内的相对路径。自建地址须由服务器 AI_PROVIDER_ALLOWED_BASES 批准后才能探测。</p></details>
  </fieldset></section>;
}
