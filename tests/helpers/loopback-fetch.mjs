import {request as httpRequest} from 'node:http';
/** Isolated E2E transport: never resolve test hosts externally or reuse a stale
 * keep-alive socket while synchronous D1 inspection blocks the test process.
 * Application failures remain visible; only the explicitly recognized local
 * Wrangler proxy restart response is retried once, as in the original suite.
 */
function loopbackOnce(input, options = {}) {
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', 'public.localtest.me'].includes(url.hostname)) {
    throw new Error('E2E transport only supports local HTTP workers');
  }
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(options.headers));
    headers.host = url.host;
    if (options.body !== undefined) headers['content-length'] = String(Buffer.byteLength(options.body));
    const req = httpRequest({hostname:'127.0.0.1', port:url.port, path:url.pathname + url.search,
      method:options.method || 'GET', headers, agent:false}, res => {
      const chunks=[];
      res.on('data', chunk=>chunks.push(chunk));
      res.on('error',reject);
      res.on('end',()=>resolve(new Response([204,205,304].includes(res.statusCode) ? null : Buffer.concat(chunks),
        {status:res.statusCode,headers:res.headers})));
    });
    const abort=()=>req.destroy(options.signal.reason);
    options.signal?.addEventListener('abort',abort,{once:true});
    req.on('close',()=>options.signal?.removeEventListener('abort',abort));
    req.on('error',reject);
    req.setTimeout(10_000,()=>req.destroy(new Error(`E2E request timeout: ${options.method || 'GET'} ${url.pathname}`)));
    req.end(options.body);
  });
}

export async function loopbackFetch(input, options = {}) {
  const response = await loopbackOnce(input, options);
  if (response.status !== 503) return response;
  const body = await response.clone().text();
  if (!/(?:worker restarted mid-request|network connection lost)/i.test(body)) return response;
  console.warn(`Retrying one local Wrangler proxy restart: ${options.method || 'GET'} ${new URL(input).pathname}`);
  await new Promise(resolve => setTimeout(resolve, 75));
  return loopbackOnce(input, options);
}
