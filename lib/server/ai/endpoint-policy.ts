import { normalizeProviderBase } from '../../ai-provider-presets';
import { localMode, setting } from './credentials';
import { ProviderError } from './errors';
function within(base: string, trusted: string) {
    try {
        const normalized = normalizeProviderBase(trusted);
        return base === normalized || base.startsWith(`${normalized}/`);
    }
    catch {
        return false;
    }
}
/** Server-managed destination allowlist, not a claim of DNS-resolving SSRF filtering.
 * A migrated endpoint retains its previous administrator trust ONLY while its
 * original credential scope is unchanged. Redirects are always refused by aiFetch.
 */
export function assertTrustedDestination(value: string, migratedTrust = false) {
    const base = normalizeProviderBase(value), url = new URL(base);
    // Separate local transport permission from LOCAL_ADMIN_MODE: integration tests
    // must exercise real member/admin authentication, never enable the admin bypass.
    const localTestHttp = setting('AI_PROVIDER_LOCAL_HTTP') === 'true' && ['127.0.0.1', '[::1]'].includes(url.hostname)
        && setting('AI_PROVIDER_ALLOWED_BASES').split(',').some(item => item.trim() && within(base, item.trim()));
    if (url.protocol !== 'https:' && !localMode() && !localTestHttp)
        throw new ProviderError('DESTINATION_NOT_ALLOWED', '生产环境只允许 HTTPS。', 400, 'baseUrl');
    if (['169.254.169.254', 'metadata.google.internal', '100.100.100.200'].includes(url.hostname))
        throw new ProviderError('DESTINATION_NOT_ALLOWED', '不允许访问云元数据地址。', 400, 'baseUrl');
    const allowed = ['https://api.openai.com', 'https://api.deepseek.com', ...setting('AI_PROVIDER_ALLOWED_BASES').split(',')];
    const environmentBase = setting('OPENAI_BASE_URL');
    if (environmentBase)
        allowed.push(environmentBase);
    if (!migratedTrust && !allowed.some(item => item.trim() && within(base, item.trim())))
        throw new ProviderError('DESTINATION_NOT_ALLOWED', '请先在服务器 AI_PROVIDER_ALLOWED_BASES 中批准此接入地址（逗号分隔，含租户前缀）。连接草稿仍可保存。', 400, 'baseUrl');
    return base;
}
