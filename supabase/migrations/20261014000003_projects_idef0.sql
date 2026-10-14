-- =============================================================================
-- 0003 projects, IDEF0 activity tree with ICOM arrows, lifecycle templates,
-- timesheets.
--
-- IDEF0 recap: every activity (box) is a verb phrase. Arrows:
--   I = Input      (left)   — what is transformed
--   C = Control    (top)    — what governs it (spec, standard, approval)
--   O = Output     (right)  — what it produces
--   M = Mechanism  (bottom) — who/what performs it (people, tools, machines)
-- Node numbering: A0 (context) → A1..A9 → A11..A19 → A111 …
-- An Output of one box can feed the Input/Control of a sibling (source_icom_id).
-- =============================================================================

create table public.projects (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  name                text not null,
  customer_id         uuid references public.partners(id),
  sales_order_id      uuid references public.sales_orders(id),
  pm_id               uuid references public.profiles(id),
  engineering_lead_id uuid references public.profiles(id),
  market              text check (market in ('EU','US','CA','VN','ASIA','OTHER')),
  standards           text[] not null default '{}',
  start_date          date,
  due_date            date,
  status              text not null default 'planning'
                      check (status in ('planning','active','on_hold','closed','cancelled')),
  budget_amount       numeric(18,2),
  budget_currency     char(3) references public.currencies(code),
  description         text,
  closed_at           timestamptz,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  check (due_date is null or start_date is null or due_date >= start_date)
);
select app.attach_std('public.projects');

alter table public.sales_orders
  add constraint sales_orders_project_fk foreign key (project_id) references public.projects(id);

create table public.project_members (
  project_id    uuid not null references public.projects(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  project_role  text,
  created_at    timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- Closing a project stamps closed_at; reopening clears it.
create or replace function app.trg_project_status() returns trigger
language plpgsql as $$
begin
  if new.status = 'closed' and (tg_op = 'INSERT' or old.status <> 'closed') then
    new.closed_at := now();
  elsif new.status <> 'closed' then
    new.closed_at := null;
  end if;
  return new;
end $$;
create trigger projects_status before insert or update of status on public.projects
  for each row execute function app.trg_project_status();

-- ---------------------------------------------------------------------------
-- IDEF0 activities
-- ---------------------------------------------------------------------------
create table public.activities (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  parent_id       uuid references public.activities(id) on delete cascade,
  seq             smallint not null default 0 check (seq between 0 and 9),
  node_code       text not null default '',
  depth           smallint not null default 0,
  title           text not null check (btrim(title) <> ''),
  description     text,
  kind            text not null default 'activity' check (kind in ('context','phase','activity','task')),
  role_code       text references public.roles(code),
  assignee_id     uuid references public.profiles(id),
  planned_start   date,
  planned_end     date,
  actual_start    date,
  actual_end      date,
  est_hours       numeric(10,2) check (est_hours >= 0),
  progress_pct    numeric(5,2) not null default 0 check (progress_pct between 0 and 100),
  status          text not null default 'not_started'
                  check (status in ('not_started','in_progress','blocked','done','cancelled')),
  is_milestone    boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  constraint activities_parent_seq_uk unique (parent_id, seq) deferrable initially deferred,
  check (planned_end is null or planned_start is null or planned_end >= planned_start),
  check ((parent_id is null and seq = 0) or (parent_id is not null and seq between 1 and 9))
);
create unique index activities_one_root_per_project on public.activities(project_id) where parent_id is null;
create index activities_project_idx on public.activities(project_id, node_code);
create index activities_assignee_idx on public.activities(assignee_id, status);
select app.attach_std('public.activities');

create or replace function app.trg_activity_code() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare p record;
begin
  if new.parent_id is null then
    new.seq := 0; new.node_code := 'A0'; new.depth := 0;
    if new.kind = 'activity' then new.kind := 'context'; end if;
    return new;
  end if;

  select a.node_code, a.depth, a.project_id into p from public.activities a where a.id = new.parent_id;
  if not found then raise exception 'Parent activity not found' using errcode = 'P0001'; end if;
  if p.project_id <> new.project_id then
    raise exception 'Parent activity belongs to another project' using errcode = 'P0001';
  end if;

  -- prevent cycles when re-parenting
  if tg_op = 'UPDATE' and new.parent_id is distinct from old.parent_id then
    if exists (
      with recursive sub as (
        select id from public.activities where id = new.id
        union all
        select a.id from public.activities a join sub on a.parent_id = sub.id)
      select 1 from sub where id = new.parent_id) then
      raise exception 'An activity cannot be moved under itself or its children' using errcode = 'P0001';
    end if;
  end if;

  new.node_code := case when p.node_code = 'A0' then 'A' || new.seq else p.node_code || new.seq end;
  new.depth := p.depth + 1;
  if new.seq is null or new.seq = 0 then
    raise exception 'seq must be 1..9 for a child activity (IDEF0 allows max 9 boxes per diagram)'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger activities_code before insert or update of parent_id, seq on public.activities
  for each row execute function app.trg_activity_code();

-- Re-number descendants when a node code changes
create or replace function app.trg_activity_recode_children() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.activities set seq = seq where parent_id = new.id;
  return null;
end $$;
create trigger activities_recode after update on public.activities
  for each row when (old.node_code is distinct from new.node_code)
  execute function app.trg_activity_recode_children();

-- Next free seq under a parent (used when inserting without seq)
create or replace function app.trg_activity_default_seq() returns trigger
language plpgsql as $$
begin
  if new.parent_id is not null and (new.seq is null or new.seq = 0) then
    select coalesce(min(s), 0) into new.seq
      from generate_series(1, 9) s
     where not exists (select 1 from public.activities a where a.parent_id = new.parent_id and a.seq = s);
    if new.seq = 0 then
      raise exception 'A diagram can hold max 9 activities (IDEF0). Decompose into a lower level.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger activities_aa_default_seq before insert on public.activities
  for each row execute function app.trg_activity_default_seq();

-- Roll progress up the tree (weighted by est. hours, min weight 1)
create or replace function app.refresh_activity_rollup(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pct numeric; v_start date; v_end date;
begin
  if p_id is null then return; end if;
  select round(sum(c.progress_pct * greatest(coalesce(c.est_hours, 0), 1)) / nullif(sum(greatest(coalesce(c.est_hours, 0), 1)), 0), 2),
         min(c.planned_start), max(c.planned_end)
    into v_pct, v_start, v_end
    from public.activities c
   where c.parent_id = p_id and c.status <> 'cancelled';
  if v_pct is null then return; end if;
  update public.activities
     set progress_pct = v_pct,
         planned_start = coalesce(v_start, planned_start),
         planned_end = coalesce(v_end, planned_end),
         status = case when v_pct >= 100 then 'done'
                       when v_pct > 0 and status in ('not_started','done') then 'in_progress'
                       else status end
   where id = p_id
     and (progress_pct is distinct from v_pct or planned_start is distinct from coalesce(v_start, planned_start)
          or planned_end is distinct from coalesce(v_end, planned_end));
end $$;

create or replace function app.trg_activity_rollup() returns trigger
language plpgsql as $$
begin
  if tg_op in ('INSERT','UPDATE') then perform app.refresh_activity_rollup(new.parent_id); end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.parent_id is distinct from new.parent_id) then
    perform app.refresh_activity_rollup(old.parent_id);
  end if;
  return null;
end $$;
create trigger activities_rollup_ins_del after insert or delete
  on public.activities for each row execute function app.trg_activity_rollup();
create trigger activities_rollup_upd after update on public.activities for each row
  when (old.progress_pct is distinct from new.progress_pct or old.status is distinct from new.status
        or old.est_hours is distinct from new.est_hours or old.planned_start is distinct from new.planned_start
        or old.planned_end is distinct from new.planned_end or old.parent_id is distinct from new.parent_id)
  execute function app.trg_activity_rollup();

-- Status ↔ progress consistency
create or replace function app.trg_activity_status() returns trigger
language plpgsql as $$
begin
  if new.status = 'done' then
    new.progress_pct := 100;
    new.actual_end := coalesce(new.actual_end, current_date);
  elsif new.progress_pct >= 100 and new.status <> 'cancelled' then
    new.status := 'done';
    new.actual_end := coalesce(new.actual_end, current_date);
  end if;
  if new.status in ('in_progress','done') then
    new.actual_start := coalesce(new.actual_start, current_date);
  end if;
  return new;
end $$;
create trigger activities_status before insert or update of status, progress_pct on public.activities
  for each row execute function app.trg_activity_status();

create table public.activity_icoms (
  id              uuid primary key default gen_random_uuid(),
  activity_id     uuid not null references public.activities(id) on delete cascade,
  icom_type       char(1) not null check (icom_type in ('I','C','O','M')),
  label           text not null check (btrim(label) <> ''),
  ref_type        text not null default 'text'
                  check (ref_type in ('text','document','bom','purchase_order','purchase_request','user','role','item','partner','standard','tool')),
  ref_id          uuid,
  source_icom_id  uuid references public.activity_icoms(id) on delete set null,
  sort            int not null default 0,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index activity_icoms_activity_idx on public.activity_icoms(activity_id, icom_type, sort);
select app.attach_std('public.activity_icoms');

create or replace function app.trg_icom_check() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; v_proj uuid;
begin
  if new.source_icom_id is null then return new; end if;
  if new.icom_type not in ('I','C') then
    raise exception 'Only an Input or Control can be fed by another activity''s Output' using errcode = 'P0001';
  end if;
  select i.icom_type, a.project_id, i.activity_id into s
    from public.activity_icoms i join public.activities a on a.id = i.activity_id
   where i.id = new.source_icom_id;
  select project_id into v_proj from public.activities where id = new.activity_id;
  if s.icom_type is distinct from 'O' then
    raise exception 'The source arrow must be an Output' using errcode = 'P0001';
  end if;
  if s.project_id <> v_proj or s.activity_id = new.activity_id then
    raise exception 'The source Output must come from another activity of the same project' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger activity_icoms_check before insert or update on public.activity_icoms
  for each row execute function app.trg_icom_check();

-- Move/re-order an activity (swap-safe thanks to the deferrable unique key)
create or replace function public.move_activity(p_activity_id uuid, p_new_parent_id uuid, p_new_seq smallint)
returns void language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_occupant uuid; v_old record;
begin
  select * into v_old from public.activities where id = p_activity_id;
  if not found then raise exception 'Activity not found or not visible' using errcode = 'P0001'; end if;
  select id into v_occupant from public.activities
   where parent_id = p_new_parent_id and seq = p_new_seq and id <> p_activity_id;
  if v_occupant is not null then
    if v_old.parent_id is not distinct from p_new_parent_id then
      update public.activities set seq = v_old.seq where id = v_occupant;   -- swap
    else
      raise exception 'Position % is already used under that parent', p_new_seq using errcode = 'P0001';
    end if;
  end if;
  update public.activities set parent_id = p_new_parent_id, seq = p_new_seq where id = p_activity_id;
end $$;

-- ---------------------------------------------------------------------------
-- Lifecycle templates (Settings → Templates)
-- ---------------------------------------------------------------------------
create table public.lifecycle_templates (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name_en     text not null,
  name_vi     text not null,
  description text,
  is_default  boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create unique index lifecycle_templates_one_default on public.lifecycle_templates(is_default) where is_default;
select app.attach_std('public.lifecycle_templates');

create table public.template_nodes (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references public.lifecycle_templates(id) on delete cascade,
  parent_id       uuid references public.template_nodes(id) on delete cascade,
  seq             smallint not null default 0 check (seq between 0 and 9),
  title_en        text not null,
  title_vi        text not null,
  kind            text not null default 'activity' check (kind in ('context','phase','activity','task')),
  role_code       text references public.roles(code),
  duration_days   int not null default 1 check (duration_days >= 0),
  est_hours       numeric(10,2),
  is_milestone    boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  unique (template_id, parent_id, seq)
);
select app.attach_std('public.template_nodes');

create table public.template_icoms (
  id          uuid primary key default gen_random_uuid(),
  node_id     uuid not null references public.template_nodes(id) on delete cascade,
  icom_type   char(1) not null check (icom_type in ('I','C','O','M')),
  label_en    text not null,
  label_vi    text not null,
  ref_type    text not null default 'text',
  sort        int not null default 0,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.template_icoms');

-- Recursive copy of a template node; returns the planned end date of the subtree
create or replace function app.copy_template_node(p_node_id uuid, p_project_id uuid, p_parent_id uuid,
                                                  p_start date, p_lang text) returns date
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n public.template_nodes;
  v_new_id uuid;
  v_cursor date := p_start;
  v_end date;
  c record;
  v_has_children boolean;
begin
  select * into n from public.template_nodes where id = p_node_id;
  select exists (select 1 from public.template_nodes where parent_id = n.id) into v_has_children;

  insert into public.activities(project_id, parent_id, seq, title, kind, role_code, est_hours, is_milestone,
                                planned_start, planned_end)
  values (p_project_id, p_parent_id, case when p_parent_id is null then 0 else n.seq end,
          case when p_lang = 'en' then n.title_en else n.title_vi end,
          n.kind, n.role_code, n.est_hours, n.is_milestone,
          p_start, case when v_has_children then null else p_start + greatest(n.duration_days - 1, 0) end)
  returning id into v_new_id;

  insert into public.activity_icoms(activity_id, icom_type, label, ref_type, sort)
  select v_new_id, ti.icom_type, case when p_lang = 'en' then ti.label_en else ti.label_vi end,
         case when ti.ref_type in ('text','document','bom','purchase_order','purchase_request','user','role','item','partner','standard','tool')
              then ti.ref_type else 'text' end, ti.sort
    from public.template_icoms ti where ti.node_id = n.id;

  if not v_has_children then
    return p_start + greatest(n.duration_days - 1, 0);
  end if;

  v_end := p_start;
  for c in select id from public.template_nodes where parent_id = n.id order by seq loop
    v_end := app.copy_template_node(c.id, p_project_id, v_new_id, v_cursor, p_lang);
    v_cursor := v_end + 1;
  end loop;
  return v_end;
end $$;

create or replace function public.apply_lifecycle_template(p_project_id uuid, p_template_id uuid default null,
                                                           p_lang text default 'vi') returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tpl uuid := p_template_id;
  v_root uuid;
  v_start date;
  v_root_node uuid;
  v_new_root uuid;
begin
  if not app.can('activities', 'write') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from public.activities where project_id = p_project_id) then
    raise exception 'This project already has an activity structure' using errcode = 'P0001';
  end if;
  if v_tpl is null then
    select id into v_tpl from public.lifecycle_templates where is_default;
  end if;
  if v_tpl is null then raise exception 'No lifecycle template found' using errcode = 'P0001'; end if;

  select coalesce(start_date, current_date) into v_start from public.projects where id = p_project_id;
  if not found then raise exception 'Project not found' using errcode = 'P0001'; end if;

  select id into v_root_node from public.template_nodes where template_id = v_tpl and parent_id is null;
  if v_root_node is null then raise exception 'Template has no root node' using errcode = 'P0001'; end if;

  perform app.copy_template_node(v_root_node, p_project_id, null, v_start, coalesce(p_lang, 'vi'));
  select id into v_new_root from public.activities where project_id = p_project_id and parent_id is null;

  -- auto-link Outputs to sibling Inputs/Controls with the same label
  update public.activity_icoms tgt
     set source_icom_id = src.id
    from public.activities ta, public.activity_icoms src, public.activities sa
   where ta.id = tgt.activity_id and ta.project_id = p_project_id
     and tgt.icom_type in ('I','C') and tgt.source_icom_id is null
     and src.activity_id = sa.id and sa.project_id = p_project_id
     and sa.parent_id is not distinct from ta.parent_id and sa.id <> ta.id
     and src.icom_type = 'O' and lower(src.label) = lower(tgt.label)
     and sa.seq < ta.seq;

  return v_new_root;
end $$;

-- ---------------------------------------------------------------------------
-- Timesheets
-- ---------------------------------------------------------------------------
create table public.timesheets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references public.profiles(id),
  work_date     date not null default current_date,
  project_id    uuid not null references public.projects(id),
  activity_id   uuid references public.activities(id) on delete set null,
  hours         numeric(4,2) not null check (hours > 0 and hours <= 24),
  description   text,
  status        text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
  decided_by    uuid references public.profiles(id),
  decided_at    timestamptz,
  reject_reason text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index timesheets_user_date_idx on public.timesheets(user_id, work_date);
create index timesheets_project_idx on public.timesheets(project_id, work_date);
select app.attach_std('public.timesheets');

create or replace function app.trg_timesheet_check() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_total numeric; v_ctx text := coalesce(current_setting('app.ctx', true), '');
begin
  if new.activity_id is not null and not exists (
      select 1 from public.activities where id = new.activity_id and project_id = new.project_id) then
    raise exception 'Activity does not belong to the selected project' using errcode = 'P0001';
  end if;

  select coalesce(sum(hours), 0) into v_total from public.timesheets
   where user_id = new.user_id and work_date = new.work_date and id <> new.id and status <> 'rejected';
  if v_total + new.hours > 24 then
    raise exception 'Total hours for % exceed 24', new.work_date using errcode = 'P0001';
  end if;

  if v_ctx = 'timesheet' or auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    if new.user_id <> auth.uid() then
      raise exception 'You can only log your own hours' using errcode = '42501';
    end if;
    if new.status <> 'draft' then
      raise exception 'New timesheet lines must be draft' using errcode = 'P0001';
    end if;
  else
    if old.user_id <> auth.uid() or new.user_id <> old.user_id then
      raise exception 'You can only edit your own hours' using errcode = '42501';
    end if;
    if old.status not in ('draft','rejected') then
      raise exception 'Submitted/approved hours are locked' using errcode = 'P0001';
    end if;
    if old.status = 'rejected' and new.status = 'rejected' then
      new.status := 'draft';
    end if;
    if new.status not in ('draft') then
      raise exception 'Use Submit to send hours for approval' using errcode = 'P0001';
    end if;
    new.decided_by := null; new.decided_at := null;
  end if;
  return new;
end $$;
create trigger timesheets_check before insert or update on public.timesheets
  for each row execute function app.trg_timesheet_check();

create or replace function app.trg_timesheet_delete() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null and (old.user_id <> auth.uid() or old.status not in ('draft','rejected')) then
    raise exception 'Only your own draft/rejected hours can be deleted' using errcode = 'P0001';
  end if;
  return old;
end $$;
create trigger timesheets_delete before delete on public.timesheets
  for each row execute function app.trg_timesheet_delete();

create or replace function public.submit_timesheets(p_from date, p_to date) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  perform set_config('app.ctx', 'timesheet', true);
  update public.timesheets set status = 'submitted', reject_reason = null
   where user_id = auth.uid() and work_date between p_from and p_to and status in ('draft','rejected');
  get diagnostics n = row_count;
  perform set_config('app.ctx', v_prev, true);
  return n;
end $$;

create or replace function public.decide_timesheets(p_ids uuid[], p_decision text, p_reason text default null) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if not app.can('timesheet_approve', 'write') then
    raise exception 'Not allowed to approve timesheets' using errcode = '42501';
  end if;
  if p_decision not in ('approved','rejected') then
    raise exception 'Decision must be approved or rejected' using errcode = 'P0001';
  end if;
  if p_decision = 'rejected' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to reject' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.timesheets where id = any(p_ids) and user_id = auth.uid()) and not app.is_admin() then
    raise exception 'You cannot approve your own hours' using errcode = '42501';
  end if;
  perform set_config('app.ctx', 'timesheet', true);
  update public.timesheets
     set status = p_decision, decided_by = auth.uid(), decided_at = now(),
         reject_reason = case when p_decision = 'rejected' then p_reason end
   where id = any(p_ids) and status = 'submitted';
  get diagnostics n = row_count;
  perform set_config('app.ctx', v_prev, true);
  return n;
end $$;
