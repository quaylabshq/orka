-- The relay stores transcript bytes. The API owns eligibility and fences delayed
-- requests with a durable record of every started or explicitly stopped episode.
create table if not exists orka.live_sessions (
  project_id uuid not null,
  resource_id uuid not null,
  episode_id uuid not null,
  owner_id uuid not null,
  device_id uuid not null,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  start_request text,
  stopped_at timestamptz,
  primary key(project_id,resource_id,episode_id),
  foreign key(project_id,resource_id) references orka.resources on delete cascade
);
create unique index if not exists live_sessions_one_active on orka.live_sessions(project_id,resource_id) where stopped_at is null;
