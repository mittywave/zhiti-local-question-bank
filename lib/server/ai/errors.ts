export class ProviderError extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 400, public readonly field?: string, public readonly retryAfter?: string | null) { super(message); this.name = 'ProviderError'; }
}
export function invalid(message: string, field?: string): never { throw new ProviderError('INVALID_INPUT', message, 400, field); }
export function conflict(message = '配置已被其他窗口修改。请重新加载后再次编辑；未覆盖已有修改。'): never { throw new ProviderError('REVISION_CONFLICT', message, 409); }
export function errorResponse(error: unknown) {
    if (error instanceof Response) {
        const code = error.status === 401 ? 'UNAUTHORIZED' : error.status === 403 ? 'FORBIDDEN' : 'INVALID_INPUT';
        return Response.json({ error: { code, message: error.status === 401 ? '请先登录。' : '没有权限执行此操作。', retryable: false } }, { status: error.status });
    }
    const known = error instanceof ProviderError ? error : error instanceof SyntaxError ? new ProviderError('INVALID_INPUT', '请求必须为有效 JSON。') : new ProviderError('INTERNAL_ERROR', '操作未完成，请重新加载后重试。', 500);
    return Response.json({ error: { code: known.code, message: known.message, field: known.field, retryable: false } }, { status: known.status, headers: { 'Cache-Control': 'no-store', ...(known.status === 429 ? { 'Retry-After': known.retryAfter || '60' } : {}) } });
}
