import type { CapabilityEvidence, CapabilityName, CapabilityState, ModelCapabilities, ProviderConfig, ProviderModel } from '../../ai-provider-types';
import { ProviderError } from './errors';
export const CAPABILITIES = ['text', 'vision', 'structured'] as const;
export function unknownCapabilities(source: CapabilityEvidence['source'] = 'manual'): ModelCapabilities {
    return Object.fromEntries(CAPABILITIES.map(name => [name, { state: 'unknown', source, observedAt: 0, configurationFingerprint: '' }])) as ModelCapabilities;
}
export function capabilityState(provider: ProviderConfig, model: ProviderModel, name: CapabilityName): CapabilityState {
    const item = model.capabilities[name];
    return item?.configurationFingerprint === provider.fingerprint ? item.state : 'unknown';
}
export function requireCapabilities(provider: ProviderConfig, model: ProviderModel, images: boolean, allowLegacy = false) {
    for (const name of ['text', 'structured', ...(images ? ['vision'] : [])] as CapabilityName[]) {
        const state = capabilityState(provider, model, name);
        if (state === 'unsupported' || state === 'unknown' && !(allowLegacy && provider.legacy && model.legacyCompatible))
            throw new ProviderError('CAPABILITY_MISMATCH', `模型 ${model.id} 的${name === 'vision' ? '图片输入' : name === 'text' ? '文本' : '结构化输出'}能力${state === 'unsupported' ? '不受支持' : '尚未确认，请先测试或明确标注'}。`, 422, 'modelId');
    }
}
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown) => Array.isArray(value) ? value.filter((i): i is string => typeof i === 'string' && i.length <= 100).slice(0, 64) : undefined;
export function parseCatalog(payload: unknown, fingerprint: string): ProviderModel[] {
    const root = object(payload), entries = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
    const seen = new Set<string>(), now = Date.now();
    return entries.slice(0, 1000).flatMap(value => {
        const item = object(value);
        const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' && item.name.startsWith('models/') ? item.name.slice(7) : '';
        if (!id.trim() || id.length > 200 || [...id].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || seen.has(id))
            return [];
        seen.add(id);
        const inputModalities = strings(item.input_modalities), outputModalities = strings(item.output_modalities), effort = object(item.effort), api = object(item.api_capabilities);
        const capabilities = unknownCapabilities('catalog');
        const evidence = (state: CapabilityState): CapabilityEvidence => ({ state, source: 'catalog', observedAt: now, configurationFingerprint: fingerprint });
        if (inputModalities) {
            capabilities.text = evidence(inputModalities.includes('text') ? 'supported' : 'unsupported');
            capabilities.vision = evidence(inputModalities.includes('image') ? 'supported' : 'unsupported');
        }
        if (typeof api.structured_outputs === 'boolean')
            capabilities.structured = evidence(api.structured_outputs ? 'supported' : 'unsupported');
        // Preserve bounded descriptive per-protocol metadata without interpreting names as capabilities.
        const safeApi = JSON.stringify(api).length <= 8000 ? api : {};
        const name = typeof item.display_name === 'string' ? item.display_name : typeof item.displayName === 'string' ? item.displayName : typeof item.name === 'string' && !item.name.startsWith('models/') ? item.name : id;
        return [{ id, displayName: name.slice(0, 200), capabilities, metadata: { inputModalities, outputModalities, effortLevels: strings(effort.supported_levels), defaultEffort: typeof effort.default_level === 'string' ? effort.default_level.slice(0, 100) : undefined, apiCapabilities: safeApi }, catalogPresent: true, manual: false, legacyCompatible: false, updatedAt: now }];
    });
}
export function mergeCatalog(existing: ProviderModel[], discovered: ProviderModel[], fingerprint: string) {
    const models = new Map(existing.map(m => [m.id, { ...m, catalogPresent: false }]));
    for (const incoming of discovered) {
        const model = structuredClone(incoming), old = models.get(model.id);
        if (old) {
            model.manual = old.manual;
            if (old.metadata.reasoningEffort !== undefined) model.metadata.reasoningEffort = old.metadata.reasoningEffort;
            model.legacyCompatible = old.legacyCompatible;
            for (const name of CAPABILITIES) {
                const prior = old.capabilities[name];
                if (model.capabilities[name].state !== 'unsupported' && prior?.configurationFingerprint === fingerprint && prior.state !== 'unknown' && (prior.source === 'manual' || prior.source === 'probe'))
                    model.capabilities[name] = prior;
            }
        }
        models.set(model.id, model);
    }
    return [...models.values()];
}
