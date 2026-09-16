-- =====================================================================
-- UTNC Toronto Scavenger Hunt: Supabase setup
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to re-run: it will not duplicate teams, items or the config row.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists config (
  id               int primary key default 1 check (id = 1),
  admin_code       text not null,
  hunt_start       timestamptz,          -- submissions refused before this (null = open)
  hunt_end         timestamptz,          -- submissions refused after this (null = open)
  campus_cap       int not null default 8,        -- max campus stops that count per team
  decay            numeric not null default 0.15, -- value lost per extra team at a spot
  floor_mult       numeric not null default 0.5,  -- a spot never drops below this share
  show_leaderboard boolean not null default true
);

alter table config add column if not exists crowd_scaled boolean not null default true;

create table if not exists teams (
  id   text primary key,
  name text not null,
  code text not null unique,
  sort int  not null default 0
);

create table if not exists items (
  id           text primary key,
  kind         text not null check (kind in ('checkpoint', 'anywhere')),
  zone         text not null,
  campus       boolean not null default false,
  name         text not null,
  task         text not null,
  base_points  int  not null,
  popularity   boolean not null default true,  -- only applies to checkpoints
  max_claims   int  not null default 1,
  bonus_label  text,
  bonus_points int  not null default 0,
  answer       text,                           -- organizer-only
  note         text,
  sort         int  not null default 0
);

create table if not exists submissions (
  id            uuid primary key default gen_random_uuid(),
  team_id       text not null references teams(id) on delete cascade,
  item_id       text not null references items(id) on delete cascade,
  photo_path    text not null,
  bonus_claimed boolean not null default false,
  bonus_answer  text,
  note          text,
  status        text not null default 'ok' check (status in ('ok', 'rejected')),
  bonus_ok      boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists submissions_team_item on submissions (team_id, item_id);

create table if not exists adjustments (
  id         uuid primary key default gen_random_uuid(),
  team_id    text not null references teams(id) on delete cascade,
  points     int  not null,
  reason     text not null,
  created_at timestamptz not null default now()
);

-- Lock every table. Nothing is readable or writable directly with the
-- public key; the page only talks to the functions below.
alter table config      enable row level security;
alter table teams       enable row level security;
alter table items       enable row level security;
alter table submissions enable row level security;
alter table adjustments enable row level security;

-- ---------------------------------------------------------------------
-- Scoring (internal)
-- ---------------------------------------------------------------------

-- Share of a checkpoint's base value each claimant earns when n teams claim it.
-- Scaled mode (default): every team claiming a spot lands exactly on the floor,
-- so the penalty adapts to however many teams are playing.
-- Fixed mode: lose `decay` per extra team, down to the floor.
create or replace function hunt_crowd_mult(p_n int)
returns numeric
language sql stable security definer set search_path = public
as $$
  select case
    when p_n <= 1 then 1::numeric
    when cfg.crowd_scaled then
      greatest(cfg.floor_mult,
               1 - (1 - cfg.floor_mult) * (p_n - 1)::numeric / greatest((select count(*) from teams) - 1, 1))
    else greatest(cfg.floor_mult, 1 - cfg.decay * (p_n - 1))
  end
  from config cfg where cfg.id = 1;
$$;

-- Current value of every item, given how many teams have claimed it.
-- value_now:    what each claiming team currently earns
-- value_if_new: what every claimant would earn if one more team claimed it
create or replace function hunt_item_values()
returns table (item_id text, teams_claimed int, value_now int, value_if_new int)
language sql stable security definer set search_path = public
as $$
  with claims as (
    select s.item_id as iid, count(distinct s.team_id)::int as n
    from submissions s
    where s.status = 'ok'
    group by s.item_id
  )
  select
    i.id,
    coalesce(c.n, 0),
    case when i.popularity and i.kind = 'checkpoint'
      then round(i.base_points * hunt_crowd_mult(greatest(coalesce(c.n, 0), 1)))::int
      else i.base_points end,
    case when i.popularity and i.kind = 'checkpoint'
      then round(i.base_points * hunt_crowd_mult(coalesce(c.n, 0) + 1))::int
      else i.base_points end
  from items i
  left join claims c on c.iid = i.id;
$$;

create or replace function hunt_scores()
returns table (team_id text, team_name text, checkpoint_pts int, anywhere_pts int,
               bonus_pts int, adjust_pts int, campus_counted int, total int)
language sql stable security definer set search_path = public
as $$
  with cfg as (select * from config where id = 1),
  ok as (select s.* from submissions s where s.status = 'ok'),
  vals as (
    select i.id, i.kind, i.campus, v.value_now
    from items i join hunt_item_values() v on v.item_id = i.id
  ),
  team_cp as (
    select t.tid, vals.value_now as value, vals.campus,
           row_number() over (partition by t.tid, vals.campus
                              order by vals.value_now desc, vals.id) as rn
    from (select distinct ok.team_id as tid, ok.item_id as iid from ok) t
    join vals on vals.id = t.iid and vals.kind = 'checkpoint'
  ),
  cp as (
    select tc.tid,
           sum(tc.value)::int as pts,
           count(*) filter (where tc.campus)::int as campus_n
    from team_cp tc cross join cfg
    where not tc.campus or tc.rn <= cfg.campus_cap
    group by tc.tid
  ),
  aw as (
    select x.tid, sum(least(x.cnt, x.max_claims) * x.base_points)::int as pts
    from (
      select ok.team_id as tid, i.id, i.max_claims, i.base_points, count(*) as cnt
      from ok join items i on i.id = ok.item_id and i.kind = 'anywhere'
      group by ok.team_id, i.id, i.max_claims, i.base_points
    ) x
    group by x.tid
  ),
  bn as (
    select y.tid, sum(y.bp)::int as pts
    from (
      select distinct ok.team_id as tid, ok.item_id, i.bonus_points as bp
      from ok join items i on i.id = ok.item_id
      where ok.bonus_claimed and ok.bonus_ok and i.bonus_points > 0
    ) y
    group by y.tid
  ),
  adj as (
    select a.team_id as tid, sum(a.points)::int as pts
    from adjustments a group by a.team_id
  )
  select
    tm.id, tm.name,
    coalesce(cp.pts, 0), coalesce(aw.pts, 0), coalesce(bn.pts, 0), coalesce(adj.pts, 0),
    coalesce(cp.campus_n, 0),
    coalesce(cp.pts, 0) + coalesce(aw.pts, 0) + coalesce(bn.pts, 0) + coalesce(adj.pts, 0)
  from teams tm
  left join cp  on cp.tid  = tm.id
  left join aw  on aw.tid  = tm.id
  left join bn  on bn.tid  = tm.id
  left join adj on adj.tid = tm.id
  order by 8 desc, tm.sort;
$$;

-- ---------------------------------------------------------------------
-- Team functions (called from index.html with a team code)
-- ---------------------------------------------------------------------

create or replace function team_login(p_code text)
returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('id', id, 'name', name)
  from teams where code = upper(trim(p_code));
$$;

create or replace function team_board(p_code text)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  t   teams;
  cfg config;
  result json;
begin
  select * into t from teams where code = upper(trim(p_code));
  if not found then raise exception 'bad_code'; end if;
  select * into cfg from config where id = 1;

  select json_build_object(
    'team', json_build_object('id', t.id, 'name', t.name),
    'now', now(),
    'hunt_start', cfg.hunt_start,
    'hunt_end', cfg.hunt_end,
    'campus_cap', cfg.campus_cap,
    'show_leaderboard', cfg.show_leaderboard,
    'items', (
      select coalesce(json_agg(json_build_object(
        'id', i.id, 'kind', i.kind, 'zone', i.zone, 'campus', i.campus,
        'name', i.name, 'task', i.task, 'note', i.note,
        'base', i.base_points,
        'popularity', (i.popularity and i.kind = 'checkpoint'),
        'max_claims', i.max_claims,
        'bonus_label', i.bonus_label, 'bonus_points', i.bonus_points,
        'teams_claimed', v.teams_claimed,
        'value_now', v.value_now,
        'value_if_new', v.value_if_new,
        'mine_ok', (select count(*) from submissions s
                    where s.team_id = t.id and s.item_id = i.id and s.status = 'ok'),
        'mine_rejected', (select count(*) from submissions s
                          where s.team_id = t.id and s.item_id = i.id and s.status = 'rejected')
      ) order by i.sort), '[]'::json)
      from items i join hunt_item_values() v on v.item_id = i.id
    ),
    'my_score', (select row_to_json(sc) from hunt_scores() sc where sc.team_id = t.id),
    'leaderboard', case when cfg.show_leaderboard
                     then (select json_agg(row_to_json(sc)) from hunt_scores() sc)
                     else null end
  ) into result;

  return result;
end;
$$;

create or replace function team_submit(
  p_code text,
  p_item text,
  p_photo_path text,
  p_bonus boolean default false,
  p_bonus_answer text default null,
  p_note text default null
)
returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  t   teams;
  cfg config;
  it  items;
  existing int;
  new_id uuid;
begin
  select * into t from teams where code = upper(trim(p_code));
  if not found then raise exception 'bad_code'; end if;

  select * into cfg from config where id = 1;
  if cfg.hunt_start is not null and now() < cfg.hunt_start then raise exception 'not_started'; end if;
  if cfg.hunt_end   is not null and now() > cfg.hunt_end   then raise exception 'hunt_over';   end if;

  select * into it from items where id = p_item;
  if not found then raise exception 'bad_item'; end if;

  if p_photo_path is null or p_photo_path not like t.id || '/%' then
    raise exception 'bad_photo';
  end if;

  -- one team at a time, so two phones on the same team can't double-claim
  perform pg_advisory_xact_lock(hashtext(t.id || ':' || it.id));

  select count(*) into existing
  from submissions where team_id = t.id and item_id = it.id and status = 'ok';
  if existing >= it.max_claims then raise exception 'already_claimed'; end if;

  insert into submissions (team_id, item_id, photo_path, bonus_claimed, bonus_answer, note)
  values (t.id, it.id, p_photo_path,
          coalesce(p_bonus, false) and it.bonus_points > 0,
          left(p_bonus_answer, 200), left(p_note, 300))
  returning id into new_id;

  return json_build_object('id', new_id);
end;
$$;

-- ---------------------------------------------------------------------
-- Organizer functions (called from admin.html with the admin code)
-- ---------------------------------------------------------------------

create or replace function admin_check(p_admin text)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_admin is null or not exists (select 1 from config where id = 1 and admin_code = p_admin) then
    raise exception 'bad_admin';
  end if;
end;
$$;

create or replace function admin_dashboard(p_admin text)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  cfg config;
  result json;
begin
  perform admin_check(p_admin);
  select * into cfg from config where id = 1;

  select json_build_object(
    'now', now(),
    'config', json_build_object(
      'hunt_start', cfg.hunt_start, 'hunt_end', cfg.hunt_end,
      'campus_cap', cfg.campus_cap, 'decay', cfg.decay, 'floor_mult', cfg.floor_mult,
      'crowd_scaled', cfg.crowd_scaled,
      'show_leaderboard', cfg.show_leaderboard),
    'teams', (
      select coalesce(json_agg(json_build_object(
        'id', t.id, 'name', t.name, 'code', t.code,
        'photos', (select count(*) from submissions s where s.team_id = t.id)
      ) order by t.sort), '[]'::json)
      from teams t
    ),
    'items', (
      select coalesce(json_agg(json_build_object(
        'id', i.id, 'kind', i.kind, 'zone', i.zone, 'campus', i.campus, 'name', i.name,
        'base', i.base_points, 'max_claims', i.max_claims,
        'bonus_label', i.bonus_label, 'bonus_points', i.bonus_points, 'answer', i.answer,
        'teams_claimed', v.teams_claimed, 'value_now', v.value_now
      ) order by i.sort), '[]'::json)
      from items i join hunt_item_values() v on v.item_id = i.id
    ),
    'submissions', (
      select coalesce(json_agg(json_build_object(
        'id', s.id, 'team_id', s.team_id, 'item_id', s.item_id,
        'photo_path', s.photo_path, 'bonus_claimed', s.bonus_claimed,
        'bonus_answer', s.bonus_answer, 'bonus_ok', s.bonus_ok,
        'note', s.note, 'status', s.status, 'created_at', s.created_at
      ) order by s.created_at desc), '[]'::json)
      from submissions s
    ),
    'scores', (select coalesce(json_agg(row_to_json(sc)), '[]'::json) from hunt_scores() sc),
    'adjustments', (
      select coalesce(json_agg(json_build_object(
        'id', a.id, 'team_id', a.team_id, 'points', a.points,
        'reason', a.reason, 'created_at', a.created_at
      ) order by a.created_at desc), '[]'::json)
      from adjustments a
    )
  ) into result;

  return result;
end;
$$;

create or replace function admin_set_submission(p_admin text, p_id uuid, p_status text default null, p_bonus_ok boolean default null)
returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform admin_check(p_admin);
  if p_status is not null and p_status not in ('ok', 'rejected') then raise exception 'bad_status'; end if;
  update submissions
     set status   = coalesce(p_status, status),
         bonus_ok = coalesce(p_bonus_ok, bonus_ok)
   where id = p_id;
end;
$$;

create or replace function admin_add_adjustment(p_admin text, p_team text, p_points int, p_reason text)
returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform admin_check(p_admin);
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  insert into adjustments (team_id, points, reason) values (p_team, p_points, left(p_reason, 120));
end;
$$;

create or replace function admin_delete_adjustment(p_admin text, p_id uuid)
returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform admin_check(p_admin);
  delete from adjustments where id = p_id;
end;
$$;

drop function if exists admin_update_config(text, timestamptz, timestamptz, boolean, int);

create or replace function admin_update_config(
  p_admin text,
  p_hunt_start timestamptz,
  p_hunt_end timestamptz,
  p_show_leaderboard boolean,
  p_campus_cap int,
  p_crowd_scaled boolean default null
)
returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform admin_check(p_admin);
  update config
     set hunt_start = p_hunt_start,
         hunt_end = p_hunt_end,
         show_leaderboard = coalesce(p_show_leaderboard, show_leaderboard),
         campus_cap = greatest(0, coalesce(p_campus_cap, campus_cap)),
         crowd_scaled = coalesce(p_crowd_scaled, crowd_scaled)
   where id = 1;
end;
$$;

-- ---- Team management ---------------------------------------------------

create or replace function admin_new_code()
returns text
language plpgsql volatile security definer set search_path = public
as $$
declare v_code text;
begin
  loop
    v_code := upper(encode(gen_random_bytes(3), 'hex'));
    exit when not exists (select 1 from teams where code = v_code);
  end loop;
  return v_code;
end;
$$;

create or replace function admin_add_team(p_admin text, p_name text)
returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_name text := left(trim(coalesce(p_name, '')), 40);
  v_base text;
  v_id   text;
  v_code text;
  i int := 1;
begin
  perform admin_check(p_admin);
  if v_name = '' then raise exception 'name_required'; end if;
  v_base := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  if v_base = '' then v_base := 'team'; end if;
  v_id := v_base;
  while exists (select 1 from teams where id = v_id) loop
    i := i + 1;
    v_id := v_base || '-' || i;
  end loop;
  v_code := admin_new_code();
  insert into teams (id, name, code, sort)
  values (v_id, v_name, v_code, coalesce((select max(sort) from teams), 0) + 1);
  return json_build_object('id', v_id, 'code', v_code);
end;
$$;

create or replace function admin_rename_team(p_admin text, p_id text, p_name text)
returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform admin_check(p_admin);
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required'; end if;
  update teams set name = left(trim(p_name), 40) where id = p_id;
end;
$$;

create or replace function admin_regenerate_code(p_admin text, p_id text)
returns text
language plpgsql volatile security definer set search_path = public
as $$
declare v_code text;
begin
  perform admin_check(p_admin);
  v_code := admin_new_code();
  update teams set code = v_code where id = p_id;
  return v_code;
end;
$$;

create or replace function admin_delete_team(p_admin text, p_id text, p_force boolean default false)
returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform admin_check(p_admin);
  if not coalesce(p_force, false) and exists (select 1 from submissions where team_id = p_id) then
    raise exception 'team_has_photos';
  end if;
  delete from teams where id = p_id;  -- also removes its submissions and adjustments
end;
$$;

-- Wipe all submissions and adjustments (for after a test run).
create or replace function admin_reset_hunt(p_admin text, p_confirm text)
returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform admin_check(p_admin);
  if p_confirm <> 'RESET' then raise exception 'confirm_required'; end if;
  delete from submissions where true;
  delete from adjustments where true;
end;
$$;

-- Internal helpers are not callable from the browser.
revoke execute on function hunt_item_values() from public, anon, authenticated;
revoke execute on function hunt_scores()      from public, anon, authenticated;
revoke execute on function admin_check(text)  from public, anon, authenticated;
revoke execute on function hunt_crowd_mult(int) from public, anon, authenticated;
revoke execute on function admin_new_code()     from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Photo storage
-- ---------------------------------------------------------------------
-- Public bucket with random file names: anyone with an exact link can view
-- a photo, but nobody can list the bucket. Uploads are images only, 5 MB max.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hunt-photos', 'hunt-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "hunt photos upload" on storage.objects;
create policy "hunt photos upload"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'hunt-photos');

-- ---------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------

insert into config (id, admin_code)
values (1, upper(encode(gen_random_bytes(6), 'hex')))
on conflict (id) do nothing;

-- Starter teams, only created on a brand new database. After that, add,
-- rename and remove teams from the organizer page (Settings tab).
insert into teams (id, name, code, sort)
select v.id, v.name, upper(encode(gen_random_bytes(3), 'hex')), v.sort
from (values
  ('men',   'Team Men',   1),
  ('kote',  'Team Kote',  2),
  ('do',    'Team Dō',    3),
  ('sune',  'Team Sune',  4),
  ('tsuki', 'Team Tsuki', 5)
) as v(id, name, sort)
where not exists (select 1 from teams);

-- Items. Re-running updates text and points but keeps any submissions.
insert into items (id, kind, zone, campus, name, task, base_points, popularity, max_claims, bonus_label, bonus_points, answer, note, sort) values
-- Campus (10 each, only the best 8 count per team)
('hart-house',       'checkpoint', 'Campus', true, 'Hart House', 'Find the entrance you would use to get to the Lower Gym for practice.', 10, true, 1, null, 0, null, null, 101),
('philosophers-walk','checkpoint', 'Campus', true, 'Philosopher''s Walk', 'Team photo, everyone gazing thoughtfully at the pool noodle.', 10, true, 1, null, 0, null, null, 102),
('taddle-creek',     'checkpoint', 'Campus', true, 'The buried creek', 'On Philosopher''s Walk, a newcomer explains on video what is buried under the ravine.', 10, true, 1, null, 0, 'Taddle Creek', 'Veterans may whisper hints.', 103),
('alexandra-gates',  'checkpoint', 'Campus', true, 'Alexandra Gates', 'Dramatic team entrance photo through the gates at the Bloor end of Philosopher''s Walk.', 10, true, 1, null, 0, null, null, 104),
('robarts',          'checkpoint', 'Campus', true, 'Robarts Library', 'Photo that shows off the building''s bird-like shape.', 10, true, 1, null, 0, null, null, 105),
('con-hall',         'checkpoint', 'Campus', true, 'Convocation Hall', 'Best graduation pose on the steps.', 10, true, 1, null, 0, null, null, 106),
('kings-college',    'checkpoint', 'Campus', true, 'King''s College Circle', 'Photo with University College behind you.', 10, true, 1, null, 0, null, null, 107),
('uc-axe',           'checkpoint', 'Campus', true, 'The UC ghost story', 'Hunt for the legendary axe mark from the Ivan Reznikoff ghost story. Photo of your best candidate.', 10, true, 1, null, 0, 'Campus folklore, honour system', null, 108),
('knox',             'checkpoint', 'Campus', true, 'Knox College', 'Moody photo, as if you are filming a period drama.', 10, true, 1, null, 0, null, null, 109),
('soldiers-tower',   'checkpoint', 'Campus', true, 'Soldiers'' Tower', 'Quietly read one plaque together. It''s a memorial, so no silly poses here.', 10, true, 1, null, 0, null, null, 110),
('back-campus',      'checkpoint', 'Campus', true, 'Back Campus', 'Team photo by the fields.', 10, true, 1, null, 0, null, null, 111),
('varsity',          'checkpoint', 'Campus', true, 'Varsity Stadium', 'Victory pose with the noodle naginata outside the stadium.', 10, true, 1, null, 0, null, null, 112),
('frye-statue',      'checkpoint', 'Campus', true, 'Northrop Frye statue', 'Sit on the bench beside him outside Victoria College and read together.', 10, true, 1, null, 0, null, null, 113),
('bata',             'checkpoint', 'Campus', true, 'Bata Shoe Museum', 'Photo that shows why the building looks like a shoebox.', 10, true, 1, null, 0, null, null, 114),
('king-edward',      'checkpoint', 'Campus', true, 'King Edward VII statue', 'At the north end of Queen''s Park, everyone copies the horse''s pose.', 10, true, 1, null, 0, null, null, 115),
('queens-park',      'checkpoint', 'Campus', true, 'Queen''s Park', '15-second speech on why UTNC deserves more gym time.', 10, true, 1, null, 0, null, null, 116),
('st-george-stn',    'checkpoint', 'Campus', true, 'St. George station', 'A newcomer explains on video which line gets you to Union.', 10, true, 1, null, 0, 'Line 1, southbound', null, 117),

-- Near (20)
('lillian-h-smith',  'checkpoint', 'Near', false, 'Lillian H. Smith Library', 'Photo with both bronze griffins at the College St entrance.', 20, true, 1, 'Name both griffins', 5, 'Edgar (the lion) and Judith (the eagle)', null, 201),
('kensington',       'checkpoint', 'Near', false, 'Kensington Market', 'Share a fruit or vegetable someone on the team has never eaten (under $5).', 20, true, 1, null, 0, null, 'Pedestrian Sundays in 2026: Sept 27 and Oct 25.', 202),
('chinatown',        'checkpoint', 'Near', false, 'Chinatown', 'Split one bakery item near Spadina and Dundas. Photo of everyone mid-bite.', 20, true, 1, null, 0, null, null, 203),
('koreatown',        'checkpoint', 'Near', false, 'Koreatown', 'Toast with a Korean snack under $5 near Bloor and Christie.', 20, true, 1, null, 0, null, null, 204),
('ago-facade',       'checkpoint', 'Near', false, 'AGO facade', 'Team reflection selfie in the long glass and wood front of the Art Gallery of Ontario on Dundas St.', 20, true, 1, null, 0, null, null, 205),
('reference-library','checkpoint', 'Near', false, 'Toronto Reference Library', 'Photo in the atrium looking up at the curved balconies (Yonge and Bloor).', 20, true, 1, null, 0, null, 'Check weekend hours before you go.', 206),
('little-italy',     'checkpoint', 'Near', false, 'Little Italy', 'Split a gelato or pastry under $5 on College St west of Bathurst.', 20, true, 1, null, 0, null, null, 207),
('christie-pits',    'checkpoint', 'Near', false, 'Christie Pits Park', 'Team photo from the top of the hill, looking down into the pit.', 20, true, 1, null, 0, null, null, 208),

-- Mid (30)
('graffiti-alley',   'checkpoint', 'Mid', false, 'Graffiti Alley', 'Find a mural with an animal and copy its pose. It''s a working laneway, so watch for cars.', 30, true, 1, null, 0, null, null, 301),
('sankofa',          'checkpoint', 'Mid', false, 'Sankofa Square', 'Photo with the spinning Sam the Record Man sign behind you.', 30, true, 1, 'The square''s old name', 5, 'Yonge-Dundas Square', null, 302),
('eaton-centre',     'checkpoint', 'Mid', false, 'Eaton Centre geese', 'Team photo under Michael Snow''s flying geese.', 30, true, 1, 'How many geese?', 5, '60', null, 303),
('old-city-hall',    'checkpoint', 'Mid', false, 'Old City Hall', 'Photograph at least one letter of the architect''s name carved under the eaves.', 30, true, 1, 'Whose name is it?', 5, 'E.J. Lennox (EJ LENNOX ARCHITECT AD 1898)', null, 304),
('nathan-phillips',  'checkpoint', 'Mid', false, 'Nathan Phillips Square', 'Each teammate poses in a different letter of the TORONTO sign.', 30, true, 1, null, 0, null, null, 305),
('allan-gardens',    'checkpoint', 'Mid', false, 'Allan Gardens Conservatory', 'Calm team photo beside the koi pond.', 30, true, 1, null, 0, null, 'Free, 10 to 5 daily, last entry 4:45. No food or drink inside.', 306),
('osgoode-hall',     'checkpoint', 'Mid', false, 'Osgoode Hall fence', 'Get the whole team through one of the narrow iron gates on Queen St, one at a time.', 30, true, 1, 'Why are the gates so narrow, according to legend?', 5, 'To keep cows out', 'If the gates are closed, a photo at the fence counts.', 307),
('church-wellesley', 'checkpoint', 'Mid', false, 'Church-Wellesley Village', 'Photo with a rainbow crosswalk behind you, taken from the sidewalk.', 30, true, 1, null, 0, null, null, 308),
('union-station',    'checkpoint', 'Mid', false, 'Union Station Great Hall', 'Team photo under the tall windows of the Great Hall.', 30, true, 1, null, 0, null, null, 309),
('yorkville-rock',   'checkpoint', 'Mid', false, 'Village of Yorkville Park', 'Whole team on or beside the giant granite rock.', 30, true, 1, null, 0, null, 'Confirm the rock on your scouting walk.', 310),
('massey-hall',      'checkpoint', 'Mid', false, 'Massey Hall', 'Photo under the Massey Hall sign on Shuter St.', 30, true, 1, null, 0, null, null, 311),
('tiff-lightbox',    'checkpoint', 'Mid', false, 'TIFF Lightbox', 'Red-carpet pose outside the building at King and John.', 30, true, 1, null, 0, null, null, 312),

-- Far (45)
('berczy',           'checkpoint', 'Far', false, 'Berczy Park dog fountain', 'Every dog stares at the golden bone. Photograph what the cat is looking at instead.', 45, true, 1, 'How many dogs?', 5, 'The cat watches birds on a nearby lamppost; 27 dogs', 'No climbing on the sculptures.', 401),
('st-lawrence',      'checkpoint', 'Far', false, 'St. Lawrence Market', 'Split a peameal bacon sandwich (or any Ontario-grown snack) so everyone gets a bite.', 45, true, 1, null, 0, null, 'South Market: Sat 7 to 5, Sun 10 to 5.', 402),
('trinity-bellwoods','checkpoint', 'Far', false, 'Trinity Bellwoods Park', 'Photo with a squirrel in frame.', 45, true, 1, 'It''s the legendary white squirrel', 15, 'Honour system, check the photo', null, 403),
('baldwin-steps',    'checkpoint', 'Far', false, 'Baldwin Steps and Casa Loma', 'Photo with the skyline behind you. Skipping the stairs is fine.', 45, true, 1, 'Which architect links Casa Loma to Old City Hall?', 5, 'E.J. Lennox', null, 404),
('distillery',       'checkpoint', 'Far', false, 'Distillery District', 'Team photo on the cobblestones between the old brick buildings.', 45, true, 1, null, 0, null, null, 405),
('riverdale-farm',   'checkpoint', 'Far', false, 'Riverdale Farm', 'Photo with a farm animal in the background.', 45, true, 1, null, 0, null, 'Free, in Cabbagetown. Check hours on your scouting walk.', 406),
('roundhouse',       'checkpoint', 'Far', false, 'Roundhouse Park', 'Photo with the old steam locomotive, next to the CN Tower.', 45, true, 1, 'What does a railway turntable do?', 5, 'Turns a locomotive to line it up with another track', null, 407),
('harbourfront',     'checkpoint', 'Far', false, 'Harbourfront', 'Team photo with Lake Ontario right behind you.', 45, true, 1, null, 0, null, 'Stay back from the edge.', 408),

-- Legendary
('high-park-zoo',    'checkpoint', 'Legendary', false, 'High Park Zoo', 'Photo with a capybara in the background.', 100, true, 1, 'Nicknames of the 2016 escapees', 5, 'Bonnie and Clyde', 'Free. Line 2 to High Park station, then about 20 minutes on foot.', 501),
('island-ferry',     'checkpoint', 'Legendary', false, 'Toronto Island ferry', 'Team photo on the ferry with the skyline behind you.', 130, true, 1, null, 0, null, 'Roughly $10 return per adult. Weekend lines can run 30 to 60 minutes.', 502),
('brick-works',      'checkpoint', 'Legendary', false, 'Evergreen Brick Works', 'Team photo with the old brick factory chimney.', 100, true, 1, null, 0, null, 'Line 2 to Broadview, then check Evergreen''s website for the current bus or walking route.', 503),
('beaches',          'checkpoint', 'Legendary', false, 'The Beaches boardwalk', 'Team photo on the boardwalk with the lake behind you.', 120, true, 1, null, 0, null, '501 Queen streetcar east, 40+ minutes each way.', 504),

-- Anywhere (no popularity penalty)
('streetcar',        'anywhere', 'Anywhere', false, 'TTC streetcar', 'Spot a streetcar.', 5, false, 1, null, 0, null, null, 601),
('black-squirrel',   'anywhere', 'Anywhere', false, 'Black squirrel', 'Spot a black squirrel.', 5, false, 1, null, 0, null, null, 602),
('map-sign',         'anywhere', 'Anywhere', false, 'Campus map sign', 'Find a campus map sign and point to where you are.', 5, false, 1, null, 0, null, null, 603),
('dog',              'anywhere', 'Anywhere', false, 'Say hi to a dog', 'Ask the owner first.', 10, false, 1, null, 0, null, null, 604),
('plaque',           'anywhere', 'Anywhere', false, 'Heritage plaque', 'Read one aloud on video in under 30 seconds.', 10, false, 1, null, 0, null, null, 605),
('east-west',        'anywhere', 'Anywhere', false, 'East or West?', 'A newcomer explains on video why street names end in E or W.', 10, false, 1, null, 0, 'Yonge Street divides east and west addresses', null, 606),
('raccoon',          'anywhere', 'Anywhere', false, 'Raccoon', 'Photograph one from a respectful distance.', 10, false, 1, null, 0, null, null, 607),
('ttc-tap',          'anywhere', 'Anywhere', false, 'Ride the TTC', 'A newcomer taps on and explains the two-hour transfer on video.', 10, false, 1, null, 0, null, null, 608),
('no-map',           'anywhere', 'Anywhere', false, 'No map app', 'A newcomer leads the team between two stops without a map app.', 15, false, 1, null, 0, null, null, 609),
('team-selfie',      'anywhere', 'Anywhere', false, 'Selfie with another team', 'Both teams can submit it. Up to 3.', 15, false, 3, null, 0, null, null, 610),
('cn-tower',         'anywhere', 'Anywhere', false, 'CN Tower naginata', 'Forced perspective: the CN Tower becomes someone''s naginata.', 20, false, 1, null, 0, null, null, 611),
('library-card',     'anywhere', 'Anywhere', false, 'Library card', 'A newcomer signs up for a Toronto Public Library card (bring ID with your address). Up to 2.', 25, false, 2, null, 0, null, 'Check branch weekend hours.', 612),
('kamae',            'anywhere', 'Anywhere', false, 'Kamae bonus', 'Whole team holds the same named stance at a checkpoint. Name it in the note. Up to 5.', 5, false, 5, null, 0, null, null, 613)
on conflict (id) do update set
  kind = excluded.kind, zone = excluded.zone, campus = excluded.campus, name = excluded.name,
  task = excluded.task, base_points = excluded.base_points, popularity = excluded.popularity,
  max_claims = excluded.max_claims, bonus_label = excluded.bonus_label,
  bonus_points = excluded.bonus_points, answer = excluded.answer, note = excluded.note,
  sort = excluded.sort;

-- Show the codes you need. Copy these somewhere safe.
select 'ADMIN' as who, admin_code as code from config
union all
select name, code from (select name, code from teams order by sort) t;
