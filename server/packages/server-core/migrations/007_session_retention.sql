-- Existing files receive the same upload grace period as a newly uploaded file.
alter table orka.blobs add column if not exists created_at timestamptz not null default now();
create index if not exists blob_retention_age on orka.blobs(project_id,created_at);

-- Remember session hashes after their superseded snapshot rows disappear. The
-- candidate list contains no content and never grants read access.
create table if not exists orka.session_blob_candidates(
  project_id uuid not null references orka.projects on delete cascade,
  hash text not null check(hash ~ '^[0-9a-f]{64}$'),
  primary key(project_id,hash)
);
with documents as (
 select project_id,payload from orka.resources
 union all select project_id,payload from orka.snapshots
 union all select project_id,payload from orka.events
 union all select project_id,payload from orka.receipts
 union all select project_id,payload from orka.conflicts
 union all select project_id,content from orka.review_requests
 union all select project_id,payload from orka.mcp_operations
), hashes as (
 select project_id,h #>> '{}' as hash from documents
 cross join lateral jsonb_path_query(payload,'$.** ? (@.kind == "session").files[*].hash') h
)
insert into orka.session_blob_candidates(project_id,hash)
select distinct project_id,hash from hashes where hash ~ '^[0-9a-f]{64}$'
on conflict do nothing;

create or replace function orka.remember_session_blobs() returns trigger language plpgsql as $$
begin
  -- Project deletion cascades must not recreate rows for a removed parent.
  if OLD.payload->>'kind'='session' and exists(select 1 from orka.projects where id=OLD.project_id) then
    insert into orka.session_blob_candidates(project_id,hash)
    select OLD.project_id,f->>'hash' from jsonb_array_elements(coalesce(OLD.payload->'files','[]'::jsonb)) f
    where f->>'hash' ~ '^[0-9a-f]{64}$' on conflict do nothing;
  end if;
  return OLD;
end;
$$;
create or replace trigger remember_session_blobs before delete on orka.snapshots
for each row execute function orka.remember_session_blobs();

-- Catalog deletion and physical removal are separate durable steps. Retried
-- physical cleanup rechecks the catalog under the project publication lock.
create table if not exists orka.blob_file_cleanup(
  project_id uuid not null references orka.projects on delete cascade,
  hash text not null check(hash ~ '^[0-9a-f]{64}$'),
  size bigint not null,
  primary key(project_id,hash)
);
