#!/usr/bin/env node
// A local stand-in for the Supabase function, for trying cloud mode without a
// Supabase project: the same hub handler, in-memory storage, served at
//   http://127.0.0.1:<port>/functions/v1/aistatus
// Usage:
//   AISTATUS_READ_TOKEN=… AISTATUS_HOOK_TOKEN=… node scripts/hub-local.mjs [--port 17810] [--details]
// then, in a scratch HOME or for real:
//   aistatus cloud setup --url http://127.0.0.1:17810/functions/v1/aistatus --hook-token … --read-token …
// (plain http is accepted only for 127.0.0.1 / localhost). Ctrl-C stops it; nothing is persisted.
import { createHubHandler } from '../src/hub/handler.js';
import { MemoryStorage } from '../src/hub/memory-storage.js';
import { startLocalHub } from '../src/hub/node-server.js';

const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
const port = i >= 0 ? Number(argv[i + 1]) : 17810;
const readToken = process.env.AISTATUS_READ_TOKEN || '';
const hookToken = process.env.AISTATUS_HOOK_TOKEN || '';
if (readToken.length < 16 && hookToken.length < 16) {
  console.error('set AISTATUS_READ_TOKEN (and AISTATUS_HOOK_TOKEN), at least 16 characters each');
  process.exit(2);
}
const handler = createHubHandler({
  storage: new MemoryStorage(),
  readToken,
  hookToken,
  storeDetails: argv.includes('--details'),
  log: (m) => console.log(`${new Date().toISOString()} ${m}`),
});
const hub = await startLocalHub({ handler, port });
console.log(`local hub on ${hub.url} (in memory; Ctrl-C to stop)`);
const stop = async () => {
  await hub.close();
  console.log(`${hub.stats.requests} requests served`);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
