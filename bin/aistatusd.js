#!/usr/bin/env node
// aistatusd — foreground daemon (used by launchd and `aistatus daemon`).
import { runDaemon } from '../src/daemon.js';

runDaemon().catch((e) => {
  console.error(`aistatusd: ${e.message}`);
  process.exit(1);
});
