/** Bounded, cancellable upstream I/O. No authenticated request follows redirects. */
export class AiTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`AI request exceeded ${timeoutMs / 1000}s; completed pages are preserved`);
    this.name = "AiTimeoutError";
  }
}

export function aiTimeoutMs(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1000 ? Math.min(600_000, Math.floor(number)) : fallback;
}

export async function withAiDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<T> {
  callerSignal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", cancel, { once: true });
  const timeoutError = new AiTimeoutError(timeoutMs);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
  }
}

export async function aiFetch(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("AI Provider 返回了重定向；为保护 API Key 已拒绝跟随，请填写最终 API 地址");
  }
  return response;
}

export async function readAiBody(response: Response, maxBytes = 20_000_000) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new Error("AI Provider 响应过大");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0, output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("AI Provider 响应过大");
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
