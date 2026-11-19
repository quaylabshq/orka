-- A tombstone tells a former member's device that a purged project is gone for
-- good. It deliberately has no foreign key: it must outlive the project row.
create table if not exists orka.project_tombstones(
  user_id uuid not null,
  project_id uuid not null,
  deleted_at timestamptz not null,
  expires_at timestamptz not null,
  primary key(user_id,project_id)
);
create index if not exists project_tombstone_expiry on orka.project_tombstones(expires_at);
create index if not exists project_purge_due on orka.projects(purge_after) where purge_after is not null;
