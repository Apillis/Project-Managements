-- =============================================================================
-- Apillis PMLC · 0001 core: helper schema, users, roles, permissions, settings,
-- numbering, audit, notifications.
-- All business rules live in the database (RLS + triggers) so that a UI bug can
-- never bypass them — think of it as the safety interlock of the system.
-- =============================================================================

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Roles & resources (permission matrix rows/columns)
-- ---------------------------------------------------------------------------
create table public.roles (
  code        text primary key check (code ~ '^[a-z_]+$'),
  name_en     text not null,
  name_vi     text not null,
  sort        int  not null default 0,
  is_system   boolean not null default true
);

create table public.resources (
  code        text primary key check (code ~ '^[a-z_]+$'),
  module      text not null,
  name_en     text not null,
  name_vi     text not null,
  sort        int  not null default 0
);

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null unique,
  full_name   text not null default '',
  department  text,
  phone       text,
  locale      text not null default 'vi' check (locale in ('vi','en')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.user_roles (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role_code   text not null references public.roles(code) on update cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, role_code)
);

create table public.permissions (
  role_code   text not null references public.roles(code) on update cascade on delete cascade,
  resource    text not null references public.resources(code) on update cascade on delete cascade,
  can_read    boolean not null default false,
  can_write   boolean not null default false,
  primary key (role_code, resource)
);

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  is_secret   boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table public.currencies (
  id          uuid not null default gen_random_uuid() unique,
  code        char(3) primary key check (code ~ '^[A-Z]{3}$'),
  name        text not null,
  symbol      text,
  decimals    smallint not null default 2 check (decimals between 0 and 4),
  is_active   boolean not null default true
);

create table public.exchange_rates (
  id            uuid not null default gen_random_uuid() unique,
  currency_code char(3) not null references public.currencies(code),
  rate_date     date not null,
  rate_to_base  numeric(18,6) not null check (rate_to_base > 0),
  created_at    timestamptz not null default now(),
  primary key (currency_code, rate_date)
);

create table public.tax_codes (
  id          uuid not null default gen_random_uuid() unique,
  code        text primary key,
  name        text not null,
  rate        numeric(6,3) not null check (rate >= 0 and rate <= 100),
  is_active   boolean not null default true
);

create table public.doc_sequences (
  id            uuid not null default gen_random_uuid() unique,
  doc_type      text primary key,
  prefix        text not null check (prefix ~ '^[A-Za-z0-9]{1,10}$'),
  padding       smallint not null default 4 check (padding between 2 and 8),
  include_year  boolean not null default true,
  reset_yearly  boolean not null default true,
  last_year     int,
  last_no       int not null default 0
);

create table public.labor_rates (
  id            uuid not null default gen_random_uuid() unique,
  role_code     text primary key references public.roles(code) on update cascade on delete cascade,
  hourly_rate   numeric(18,2) not null check (hourly_rate >= 0),
  currency_code char(3) not null references public.currencies(code)
);

-- ---------------------------------------------------------------------------
-- Audit & notifications
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          bigserial primary key,
  table_name  text not null,
  row_id      text,
  action      text not null,
  old_data    jsonb,
  new_data    jsonb,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index audit_log_table_row_idx on public.audit_log(table_name, row_id);
create index audit_log_changed_at_idx on public.audit_log(changed_at desc);

create table public.notifications (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  body        text,
  link        text,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id, is_read, created_at desc);

create table public.notification_outbox (
  id              bigserial primary key,
  channel         text not null check (channel in ('email','gchat')),
  recipient       text not null,
  subject         text,
  body            text not null,
  status          text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index notification_outbox_pending_idx on public.notification_outbox(status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------
create or replace function app.uid() returns uuid
language sql stable as $$ select auth.uid() $$;

create or replace function app.has_role(p_role text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.user_roles ur
    join public.profiles p on p.id = ur.user_id and p.is_active
    where ur.user_id = auth.uid() and ur.role_code = p_role)
$$;

create or replace function app.is_admin() returns boolean
language sql stable as $$ select app.has_role('admin') $$;

-- Core permission check used by every RLS policy.
create or replace function app.can(p_resource text, p_mode text default 'read') returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when auth.uid() is null then false
    when not exists (select 1 from public.profiles where id = auth.uid() and is_active) then false
    when exists (select 1 from public.user_roles where user_id = auth.uid() and role_code = 'admin') then true
    when p_mode = 'read' and exists (select 1 from public.user_roles
                                      where user_id = auth.uid() and role_code = 'management') then true
    else exists (
      select 1 from public.user_roles ur
      join public.permissions pm on pm.role_code = ur.role_code
      where ur.user_id = auth.uid() and pm.resource = p_resource
        and case when p_mode = 'write' then pm.can_write else (pm.can_read or pm.can_write) end)
  end
$$;

create or replace function app.setting(p_key text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select value from public.app_settings where key = p_key
$$;

create or replace function app.setting_text(p_key text, p_default text default null) returns text
language sql stable as $$
  select coalesce(app.setting(p_key) #>> '{}', p_default)
$$;

create or replace function app.setting_bool(p_key text, p_default boolean default false) returns boolean
language sql stable as $$
  select coalesce((app.setting(p_key) #>> '{}')::boolean, p_default)
$$;

create or replace function app.base_currency() returns char(3)
language sql stable as $$ select coalesce(app.setting_text('base_currency'), 'VND')::char(3) $$;

create or replace function app.latest_rate(p_currency text, p_date date default current_date) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_currency = app.base_currency() then 1::numeric else
    (select rate_to_base from public.exchange_rates
      where currency_code = p_currency and rate_date <= coalesce(p_date, current_date)
      order by rate_date desc limit 1) end
$$;

-- Converts an amount into base currency using the rate stored on the document
-- (p_rate) or, if null, the latest exchange rate on or before p_date.
create or replace function app.to_base(p_amount numeric, p_currency text, p_rate numeric default null,
                                       p_date date default current_date) returns numeric
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_rate numeric;
begin
  if p_amount is null then return 0; end if;
  if p_currency is null or p_currency = app.base_currency() then return p_amount; end if;
  if p_rate is not null and p_rate > 0 then return p_amount * p_rate; end if;
  v_rate := app.latest_rate(p_currency, p_date);
  if v_rate is null then
    raise exception 'No exchange rate for % on %', p_currency, p_date using errcode = 'P0001';
  end if;
  return p_amount * v_rate;
end $$;

create or replace function app.to_base_safe(p_amount numeric, p_currency text, p_rate numeric default null,
                                            p_date date default current_date) returns numeric
language plpgsql stable as $$
begin
  return app.to_base(p_amount, p_currency, p_rate, p_date);
exception when others then
  return null;
end $$;

-- Fills exchange_rate on documents: 1 for base currency, otherwise the latest
-- configured rate (the user may overwrite it while the document is a draft).
create or replace function app.trg_fill_rate() returns trigger
language plpgsql as $$
begin
  if new.currency_code is null then
    new.currency_code := app.base_currency();
  end if;
  if new.currency_code = app.base_currency() then
    new.exchange_rate := 1;
  elsif new.exchange_rate is null
     or (tg_op = 'UPDATE' and new.currency_code is distinct from old.currency_code
         and new.exchange_rate is not distinct from old.exchange_rate) then
    new.exchange_rate := app.latest_rate(new.currency_code, current_date);
  end if;
  return new;
end $$;

-- Document numbering, e.g. PO-2026-0001 (prefix/padding/year configurable)
create or replace function app.next_doc_no(p_doc_type text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_year int := extract(year from now())::int;
  s public.doc_sequences;
begin
  update public.doc_sequences d
     set last_no   = case when d.reset_yearly and coalesce(d.last_year, 0) <> v_year then 1 else d.last_no + 1 end,
         last_year = v_year
   where d.doc_type = p_doc_type
  returning * into s;
  if not found then
    raise exception 'No numbering sequence configured for %', p_doc_type using errcode = 'P0001';
  end if;
  return s.prefix || '-' || case when s.include_year then v_year::text || '-' else '' end
         || lpad(s.last_no::text, s.padding, '0');
end $$;

create or replace function app.trg_doc_no() returns trigger
language plpgsql as $$
begin
  if new.doc_no is null or btrim(new.doc_no) = '' then
    new.doc_no := app.next_doc_no(tg_argv[0]);
  end if;
  return new;
end $$;

-- created_* / updated_* bookkeeping
create or replace function app.trg_touch() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_at := now();
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end $$;

create or replace function app.trg_touch_simple() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Audit trail: stores only the changed keys for updates.
create or replace function app.trg_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old jsonb; v_new jsonb; v_id text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new); v_id := v_new->>'id';
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old); v_id := v_old->>'id';
  else
    select jsonb_object_agg(n.key, o.value), jsonb_object_agg(n.key, n.value)
      into v_old, v_new
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value
       and n.key not in ('updated_at','updated_by');
    if v_new is null then return null; end if;
    v_id := to_jsonb(new)->>'id';
  end if;
  insert into public.audit_log(table_name, row_id, action, old_data, new_data, changed_by)
  values (tg_table_name, v_id, tg_op, v_old, v_new, auth.uid());
  return null;
end $$;

-- Attach the standard triggers (touch, audit, optional numbering) to a table.
create or replace function app.attach_std(p_table regclass, p_doc_type text default null, p_audit boolean default true)
returns void language plpgsql as $$
declare v_name text := replace(p_table::text, 'public.', '');
begin
  execute format('create trigger %I before insert or update on %s for each row execute function app.trg_touch()',
                 v_name || '_touch', p_table);
  if p_audit then
    execute format('create trigger %I after insert or update or delete on %s for each row execute function app.trg_audit()',
                   v_name || '_audit', p_table);
  end if;
  if p_doc_type is not null then
    execute format('create trigger %I before insert on %s for each row execute function app.trg_doc_no(%L)',
                   v_name || '_doc_no', p_table, p_doc_type);
  end if;
end $$;

-- Standard columns are appended by convention:
--   created_at, created_by, updated_at, updated_by

create trigger profiles_touch before update on public.profiles
  for each row execute function app.trg_touch_simple();
create trigger profiles_audit after insert or update or delete on public.profiles
  for each row execute function app.trg_audit();
create trigger user_roles_audit after insert or update or delete on public.user_roles
  for each row execute function app.trg_audit();
create trigger permissions_audit after insert or update or delete on public.permissions
  for each row execute function app.trg_audit();
create trigger app_settings_touch before update on public.app_settings
  for each row execute function app.trg_touch_simple();
create trigger app_settings_audit after insert or update or delete on public.app_settings
  for each row execute function app.trg_audit();

-- Profiles: only safe columns may be changed by the user themself.
create or replace function app.trg_profiles_guard() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.ctx', true), '') in ('system') or auth.uid() is null then
    return new;
  end if;
  if not app.can('users', 'write') then
    if new.id <> auth.uid() then
      raise exception 'You can only edit your own profile' using errcode = '42501';
    end if;
    if new.email is distinct from old.email or new.is_active is distinct from old.is_active then
      raise exception 'Only an administrator can change e-mail or active status' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function app.trg_profiles_guard();

-- ---------------------------------------------------------------------------
-- New auth user → profile (domain-restricted, first user = admin)
-- ---------------------------------------------------------------------------
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_domains jsonb := coalesce(app.setting('allowed_email_domains'), '[]'::jsonb);
  v_domain  text := lower(split_part(coalesce(new.email, ''), '@', 2));
begin
  if jsonb_array_length(v_domains) > 0
     and not exists (select 1 from jsonb_array_elements_text(v_domains) d where lower(d) = v_domain) then
    raise exception 'E-mail domain "%" is not allowed to sign in', v_domain using errcode = '42501';
  end if;

  insert into public.profiles(id, email, full_name)
  values (new.id, lower(new.email),
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name',
                   split_part(new.email, '@', 1)))
  on conflict (id) do nothing;

  if not exists (select 1 from public.user_roles where role_code = 'admin') then
    insert into public.user_roles(user_id, role_code) values (new.id, 'admin');
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------------------
-- Notification helpers (in-app + outbox for e-mail / Google Chat)
-- ---------------------------------------------------------------------------
create or replace function app.notify_users(p_user_ids uuid[], p_title text, p_body text, p_link text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_base text := coalesce(app.setting_text('app_base_url'), '');
begin
  insert into public.notifications(user_id, title, body, link)
  select distinct p.id, p_title, p_body, p_link
    from public.profiles p
   where p.id = any(p_user_ids) and p.is_active;

  if app.setting_bool('notify_email_enabled', false) then
    insert into public.notification_outbox(channel, recipient, subject, body)
    select distinct 'email', p.email, '[Apillis PM] ' || p_title,
           coalesce(p_body, '') || case when p_link is not null then E'\n\n' || v_base || p_link else '' end
      from public.profiles p
     where p.id = any(p_user_ids) and p.is_active;
  end if;
end $$;

create or replace function app.notify_roles(p_roles text[], p_title text, p_body text, p_link text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.notify_users(
    array(select distinct ur.user_id from public.user_roles ur where ur.role_code = any(p_roles)),
    p_title, p_body, p_link);
end $$;

create or replace function app.notify_chat(p_text text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text := app.setting_text('gchat_webhook_url', '');
begin
  if app.setting_bool('notify_gchat_enabled', false) and v_url <> '' then
    insert into public.notification_outbox(channel, recipient, body) values ('gchat', v_url, p_text);
  end if;
end $$;

-- What the current user may do (used by the UI to hide menus/buttons)
create or replace function public.my_permissions()
returns table(resource text, can_read boolean, can_write boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.code, app.can(r.code, 'read'), app.can(r.code, 'write') from public.resources r
$$;

create or replace function public.my_roles() returns setof text
language sql stable security definer set search_path = public, pg_temp as $$
  select role_code from public.user_roles where user_id = auth.uid()
$$;

create or replace function public.mark_notifications_read(p_ids bigint[] default null) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.notifications set is_read = true
   where user_id = auth.uid() and not is_read and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;
