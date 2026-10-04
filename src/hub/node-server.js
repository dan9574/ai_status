// Mount the runtime-neutral hub handler (src/hub/handler.js) on a Node HTTP
// server, the way the Supabase platform mounts it: requests arrive under
// /functions/v1/aistatus. Used by the tests and the end-to-end script; it is
// not part of the daemon and never listens on anything but what you pass.
import http from 'node:http';
import { Readable } from 'node:stream';

/** Convert a Node request to a web Request and the web Response back. */
export function nodeAdapter(handler) {
  return async (req, res) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) for (const x of v) headers.append(k, x);
        else if (v != null) headers.set(k, v);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`http://${req.headers.host || '127.0.0.1'}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: 'half',
      });
      const response = await handler(request);
      const body = Buffer.from(await response.arrayBuffer());
      const out = Object.fromEntries(response.headers);
      out['content-length'] = String(body.length);
      res.writeHead(response.status, out);
      res.end(body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  };
}

/**
 * Start a local hub on host:port (port 0 = any free port). Resolves to
 * { server, port, url, requests, close() } where url is the base URL
 * (…/functions/v1/aistatus) and `requests` counts every request ("invocations").
 */
export async function startLocalHub({ handler, host = '127.0.0.1', port = 0 } = {}) {
  const adapt = nodeAdapter(handler);
  const stats = { requests: 0, byPath: {} };
  const server = http.createServer((req, res) => {
    stats.requests++;
    const p = String(req.url).split('?')[0];
    stats.byPath[p] = (stats.byPath[p] || 0) + 1;
    adapt(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    server,
    port: actual,
    url: `http://${host}:${actual}/functions/v1/aistatus`,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
