alter table orka.mcp_tokens add column if not exists desktop_binding jsonb;
create unique index if not exists mcp_pending_desktop_handoff on orka.mcp_pending((payload->>'desktopHandoffHash')) where payload ? 'desktopHandoffHash';

create table if not exists orka.mcp_connection_proofs(
  hash text primary key,
  access_hash text not null references orka.mcp_tokens(access_hash) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists mcp_connection_proofs_expiry on orka.mcp_connection_proofs(expires_at);
