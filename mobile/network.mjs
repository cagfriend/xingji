function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted', 'AbortError');
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function timeoutError() {
  const error = new Error('The network request timed out');
  error.name = 'TimeoutError';
  return error;
}

/** Bound waiting even on native transports that cannot be cancelled once started. */
export function withRequestDeadline(operation, {signal, timeout=90000}={}) {
  const limit = Number.isFinite(Number(timeout)) && Number(timeout) > 0 ? Number(timeout) : 90000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, signal?.reason ?? abortError());
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, {once:true});
    timer = setTimeout(() => finish(reject, timeoutError()), limit);
    // Promise.race-style handlers remain attached after a deadline, so late native
    // failures are observed and cannot become unhandled rejections.
    Promise.resolve().then(operation).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}

export function createNetworkRequest({native=false, capacitorHttp, fetchImpl=globalThis.fetch, baseUrl='http://localhost/'}={}) {
  return async function networkRequest({url, method='GET', headers={}, data, signal, redirect='follow', timeout=90000}={}) {
    const parsed = new URL(url, baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('仅支持安全的 HTTP(S) 网络请求');
    return withRequestDeadline(async () => {
      if (!native) {
        const response = await fetchImpl(parsed.href, {
          method, headers, signal, redirect,
          ...(data === undefined ? {} : {body:typeof data === 'string' ? data : JSON.stringify(data)}),
        });
        return {status:response.status, data:await response.text()};
      }
      if (!capacitorHttp?.request) throw new Error('原生网络请求不可用');
      const deadline = Number.isFinite(Number(timeout)) && Number(timeout) > 0 ? Number(timeout) : 90000;
      const result = await capacitorHttp.request({
        url:parsed.href, method, headers,
        connectTimeout:Math.min(15000, deadline),
        readTimeout:deadline,
        disableRedirects:redirect === 'manual',
        ...(data === undefined ? {} : {data}),
      });
      return {status:result.status, data:result.data};
    }, {signal, timeout});
  };
}
