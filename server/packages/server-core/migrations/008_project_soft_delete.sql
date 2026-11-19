alter table orka.projects
  add column if not exists deleted_at timestamptz,
  add column if not exists purge_after timestamptz,
  drop constraint if exists project_deletion_window,
  add constraint project_deletion_window check (
    (deleted_at is null and purge_after is null) or
    (deleted_at is not null and archived_at is not null and purge_after is not null and purge_after > deleted_at)
  );
