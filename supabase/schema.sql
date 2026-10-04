-- aistatus cloud hub: database schema for the Supabase Edge Function "aistatus".
-- Run the whole file in the Supabase dashboard: SQL Editor -> New query -> Run.
-- Idempotent: running it again changes nothing (and keeps the data).
--
-- One row per agent session. `state` is the session object of the state
-- machine (src/core.js); the other columns repeat a few of its fields so the
-- table is readable in the Table Editor. By default `state` holds no paths,
-- prompts or messages (only with the function secret AISTATUS_STORE_DETAILS=1:
-- the project folder name and short message snippets).
--
-- Concurrency: the function never holds a lock across its JavaScript step. It
-- reads (state, version), runs the state machine, and writes back with
--   UPDATE ... SET version = <read version> + 1 WHERE id = $1 AND version = <read version>
--   DELETE ...                                  WHERE id = $1 AND version = <read version>
--   INSERT ... (a first write; fails on the primary key if the row appeared)
-- and retries from the read when no row was affected (compare-and-swap).
--
-- Access: only the function, which uses the project's secret (service_role)
-- key. Row Level Security is on and there are no policies, and the anon /
-- authenticated roles have no table privileges at all, so the publishable
-- (anon) key and signed-in users cannot read or change anything.

create table if not exists public.aistatus_sessions (
  id         text        primary key,          -- "<tool>@<machine>:<session id>"
  tool       text        not null,             -- claude | codex
  machine    text        not null,             -- sender's machine name
  session_id text        not null,
  status     text        not null,             -- idle | running | waiting | done
  state      jsonb       not null,             -- full session state (see above)
  version    bigint      not null default 1,   -- +1 on every write (compare-and-swap)
  updated_at timestamptz not null default now(),
  constraint aistatus_sessions_id_length check (char_length(id) <= 512)
);

comment on table public.aistatus_sessions is
  'aistatus hub: one row per Claude Code / Codex session. Written only by the Edge Function "aistatus" (service role).';

alter table public.aistatus_sessions enable row level security;

revoke all on table public.aistatus_sessions from anon, authenticated;
grant select, insert, update, delete on table public.aistatus_sessions to service_role;
