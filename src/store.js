// Node entry point of the session state machine. The logic itself lives in
// src/core.js (pure, dependency-free, shared with the Supabase Edge Function);
// this module keeps the historical import path and class name for the daemon.
import { SessionState } from './core.js';

export * from './core.js';

/** The daemon's long-lived store: emits 'change' after every real mutation. */
export class SessionStore extends SessionState {}
