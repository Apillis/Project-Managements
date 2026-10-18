-- =============================================================================
-- 0017 (v1.2) project closure and daily reminders.
--   * SRS phase 5: "sign off the project, change status to Closed and lock all
--     documents". Closing is refused while work is still open (checklist:
--     project_close_check), and once closed / cancelled every record of the
--     project is read-only until Management reopens it. Service tickets stay
--     open (warranty runs after closure).
--   * Daily digest: overdue tasks, approvals waiting, late POs, NCRs past due,
--     overdue invoices, milestones to invoice, low stock, late shipments.
--     app.run_daily_digest() is called by the notifier every cycle and runs
--     once a day after the configured hour.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Closure checklist
-- ---------------------------------------------------------------------------
create or replace function app.project_close_blockers(p_project_id uuid)
returns table(check_code text, open_count int)
language sql stable security definer set search_path = public, pg_temp as $$
  select v.check_code, v.open_count::int from (values
    ('open_activities', (select count(*) from public.activities a where a.project_id = p_project_id
        and a.status not in ('done','cancelled') and not exists (select 1 from public.activities c where c.parent_id = a.id))),
    ('pending_approvals', (select count(*) from public.approval_requests r where r.project_id = p_project_id and r.status = 'pending')),
    ('open_purchase_requests', (select count(*) from public.purchase_requests r where r.project_id = p_project_id
        and r.status in ('draft','pending_approval','approved','partially_ordered'))),
    ('open_purchase_orders', (select count(*) from public.purchase_orders o where o.project_id = p_project_id
        and o.status in ('draft','pending_approval','approved','ordered','partially_received'))),
    ('open_material_requests', (select count(*) from public.material_requests m where m.project_id = p_project_id
        and m.status in ('draft','pending_approval','approved','partially_issued'))),
    ('open_ncrs', (select count(*) from public.ncrs n where n.project_id = p_project_id and n.status not in ('closed','cancelled'))),
    ('open_compliance', (select count(*) from public.project_compliance c where c.project_id = p_project_id
        and c.status in ('not_started','in_progress'))),
    ('open_shipments', (select count(*) from public.shipments s where s.project_id = p_project_id
        and s.status in ('planned','booked','in_transit'))),
    ('unbilled_milestones', (select count(*) from public.billing_milestones m where m.project_id = p_project_id
        and m.status in ('planned','ready'))),
    ('unpaid_invoices', (select count(*) from public.invoices i where i.project_id = p_project_id
        and i.status in ('draft','issued','partially_paid'))),
    ('unapproved_timesheets', (select count(*) from public.timesheets t where t.project_id = p_project_id
        and t.status in ('draft','submitted'))),
    ('project_stock', (select count(*) from public.v_stock_balance b where b.project_id = p_project_id and b.qty > 0))
  ) v(check_code, open_count)
$$;

create or replace function public.project_close_check(p_project_id uuid)
returns table(check_code text, open_count int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.can('projects', 'read') then raise exception 'Not allowed' using errcode = '42501'; end if;
  return query select * from app.project_close_blockers(p_project_id);
end $$;

create or replace function app.trg_project_close_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_list text; v_free text[] := array['status','closed_at','updated_at','updated_by'];
begin
  if coalesce(current_setting('app.ctx', true), '') = 'system' or auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'closed' then raise exception 'A closed project cannot be deleted' using errcode = 'P0001'; end if;
    return old;
  end if;
  if old.status in ('closed','cancelled') then
    if new.status = old.status then
      if (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
        raise exception 'Project % is % — reopen it before editing', old.code, old.status using errcode = 'P0001';
      end if;
    elsif not (app.has_role('management') or app.is_admin()) then
      raise exception 'Only Management can reopen a % project', old.status using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status = 'closed' and app.setting_bool('project_close_strict', true) then
    select string_agg(b.check_code || ' (' || b.open_count || ')', ', ') into v_list
      from app.project_close_blockers(new.id) b where b.open_count > 0;
    if v_list is not null then
      raise exception 'The project cannot be closed yet: %', v_list using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger projects_close_guard before update or delete on public.projects
  for each row execute function app.trg_project_close_guard();

create or replace function app.trg_project_closed_notify() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'closed' and old.status <> 'closed' then
    perform app.notify_roles(array['pmo','management','accounting'], 'Project ' || new.code || ' closed',
      new.name || ' — all project records are now locked.', '/projects/' || new.id);
    perform app.notify_chat('🏁 Project ' || new.code || ' closed: ' || new.name);
  elsif old.status in ('closed','cancelled') and new.status not in ('closed','cancelled') then
    perform app.notify_roles(array['pmo','management'], 'Project ' || new.code || ' reopened', new.name, '/projects/' || new.id);
  end if;
  return null;
end $$;
create trigger projects_closed_notify after update of status on public.projects
  for each row execute function app.trg_project_closed_notify();

-- ---------------------------------------------------------------------------
-- Record lock for closed / cancelled projects.
-- tg_argv: project columns of the row, or 'parent:<table>:<fk>' to read the
-- project of the parent document.
-- ---------------------------------------------------------------------------
create or replace function app.trg_project_lock() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a text; r jsonb; parts text[]; v uuid; v_ids uuid[] := '{}'; v_code text; v_status text;
begin
  if coalesce(current_setting('app.ctx', true), '') in ('system','approval') or auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  foreach r in array case tg_op when 'INSERT' then array[to_jsonb(new)] when 'DELETE' then array[to_jsonb(old)]
                                else array[to_jsonb(old), to_jsonb(new)] end loop
    foreach a in array tg_argv loop
      v := null;
      if a like 'parent:%' then
        parts := string_to_array(a, ':');
        v := nullif(r ->> parts[3], '')::uuid;
        if v is not null then
          execute format('select project_id from public.%I where id = $1', parts[2]) into v using v;
        end if;
      else
        v := nullif(r ->> a, '')::uuid;
      end if;
      if v is not null then v_ids := v_ids || v; end if;
    end loop;
  end loop;
  if cardinality(v_ids) > 0 then
    select code, status into v_code, v_status from public.projects
     where id = any(v_ids) and status in ('closed','cancelled') limit 1;
    if v_code is not null then
      raise exception 'Project % is % — its records are locked. Reopen the project first.', v_code, v_status
        using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

do $$
declare t text; args text;
begin
  for t, args in select * from (values
    ('activities', '''project_id'''), ('activity_icoms', '''parent:activities:activity_id'''),
    ('project_members', '''project_id'''), ('timesheets', '''project_id'''), ('documents', '''project_id'''),
    ('boms', '''project_id'''), ('bom_lines', '''parent:boms:bom_id'''), ('ecos', '''project_id'''),
    ('purchase_requests', '''project_id'''), ('pr_lines', '''parent:purchase_requests:pr_id'''),
    ('purchase_orders', '''project_id'''), ('po_lines', '''project_id'', ''parent:purchase_orders:po_id'''),
    ('stock_moves', '''project_id'', ''to_project_id'', ''consume_project_id'''),
    ('inspections', '''project_id'''), ('ncrs', '''project_id'''), ('project_compliance', '''project_id'''),
    ('cost_estimates', '''project_id'''), ('cost_estimate_lines', '''parent:cost_estimates:estimate_id'''),
    ('cost_estimate_labor', '''parent:cost_estimates:estimate_id'''), ('cost_estimate_fees', '''parent:cost_estimates:estimate_id'''),
    ('rfqs', '''project_id'''), ('rfq_lines', '''parent:rfqs:rfq_id'''), ('rfq_vendors', '''parent:rfqs:rfq_id'''),
    ('rfq_quotes', '''parent:rfqs:rfq_id'''),
    ('material_requests', '''project_id'''), ('material_request_lines', '''parent:material_requests:mr_id'''),
    ('shipments', '''project_id'''), ('shipment_lines', '''parent:shipments:shipment_id'''),
    ('billing_milestones', '''project_id'''), ('invoices', '''project_id'''),
    ('invoice_lines', '''parent:invoices:invoice_id'''), ('payments', '''project_id''')) x(t, args) loop
    -- "zzz": runs after the triggers that fill project_id from the parent / linked document
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function app.trg_project_lock(%s)',
                   t || '_zzz_project_lock', t, args);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Daily digest
-- ---------------------------------------------------------------------------
create table public.digest_runs (
  run_date      date primary key,
  ran_at        timestamptz not null default now(),
  notifications int not null default 0
);
alter table public.digest_runs enable row level security;   -- notifier / service role only

-- one notification in the recipient's language
create or replace function app.notify_user_i18n(p_user uuid, p_title_vi text, p_title_en text,
                                                p_body_vi text, p_body_en text, p_link text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_locale text;
begin
  select locale into v_locale from public.profiles where id = p_user and is_active;
  if v_locale is null then return; end if;
  perform app.notify_users(array[p_user],
    case when v_locale = 'en' then p_title_en else p_title_vi end,
    case when v_locale = 'en' then p_body_en else p_body_vi end, p_link);
end $$;

create or replace function app.run_daily_digest(p_force boolean default false) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tz text := app.setting_text('timezone', 'Asia/Ho_Chi_Minh');
  v_today date := (now() at time zone v_tz)::date;
  v_days int := coalesce((app.setting('approval_reminder_days') #>> '{}')::int, 2);
  n int := 0; k int; r record; u uuid; v_cnt int; v_txt text; v_amt numeric;
begin
  if not app.setting_bool('digest_enabled', true) and not p_force then return 0; end if;
  if not p_force and extract(hour from now() at time zone v_tz) < coalesce((app.setting('digest_hour') #>> '{}')::int, 7) then
    return 0;
  end if;
  insert into public.digest_runs(run_date) values (v_today) on conflict (run_date) do nothing;
  get diagnostics k = row_count;
  if k = 0 and not p_force then return 0; end if;

  -- 1. overdue tasks → assignee
  for r in
    select a.assignee_id, count(*) as cnt,
           string_agg(p.code || ' ' || a.node_code || ' ' || a.title || ' (' || (v_today - a.planned_end) || ')', E'\n'
                      order by a.planned_end) filter (where a.rn <= 10) as list
      from (select a.*, row_number() over (partition by a.assignee_id order by a.planned_end) rn
              from public.activities a
             where a.assignee_id is not null and a.status not in ('done','cancelled') and a.planned_end < v_today
               and not exists (select 1 from public.activities c where c.parent_id = a.id)) a
      join public.projects p on p.id = a.project_id and p.status in ('planning','active')
     group by a.assignee_id
  loop
    perform app.notify_user_i18n(r.assignee_id, 'Việc quá hạn: ' || r.cnt, 'Overdue tasks: ' || r.cnt,
      r.list, r.list, '/my-tasks');
    n := n + 1;
  end loop;

  -- 2. approvals waiting longer than approval_reminder_days → approvers of the pending step
  for r in
    select x.uid, count(distinct x.request_id) as cnt, string_agg(distinct x.doc_no, ', ') as docs
      from (select unnest(app.step_approvers(s.approver_role, s.approver_user_id)) as uid, q.id as request_id, q.doc_no
              from public.approval_steps s join public.approval_requests q on q.id = s.request_id
             where s.status = 'pending' and q.status = 'pending' and q.requested_at < now() - make_interval(days => v_days)) x
     group by x.uid
  loop
    perform app.notify_user_i18n(r.uid, 'Chờ bạn duyệt: ' || r.cnt || ' chứng từ', 'Waiting for your approval: ' || r.cnt || ' documents',
      r.docs, r.docs, '/approvals');
    n := n + 1;
  end loop;

  -- 3. NCRs past due → owner
  for r in
    select owner_id, count(*) as cnt, string_agg(doc_no || ' ' || title, E'\n' order by due_date) as list
      from public.ncrs where owner_id is not null and status not in ('closed','cancelled') and due_date < v_today
     group by owner_id
  loop
    perform app.notify_user_i18n(r.owner_id, 'NCR quá hạn: ' || r.cnt, 'NCRs past due: ' || r.cnt, r.list, r.list, '/r/ncrs');
    n := n + 1;
  end loop;

  -- 4. role summaries
  for r in
    select * from (values
      ('procurement', (select count(*) from public.v_po_lines where is_late)::int, 'Dòng PO trễ hẹn giao: ', 'Late PO lines: ', '/r/purchase_orders'),
      ('accounting', (select count(*) from public.invoices i where i.status in ('issued','partially_paid') and i.due_date < v_today)::int,
         'Hoá đơn quá hạn thu: ', 'Overdue invoices: ', '/finance?tab=receivables'),
      ('accounting', (select count(*) from public.billing_milestones where status = 'ready')::int,
         'Mốc thanh toán chờ xuất hoá đơn: ', 'Billing milestones to invoice: ', '/r/billing_milestones'),
      ('warehouse', (select count(*) from public.material_requests where status in ('approved','partially_issued')
                      and coalesce(needed_by, v_today) <= v_today + 2)::int,
         'Phiếu yêu cầu vật tư cần xuất: ', 'Material requests to issue: ', '/warehouse/issue'),
      ('warehouse', (select count(*) from public.v_low_stock)::int, 'Vật tư dưới tồn tối thiểu: ', 'Items below minimum stock: ', '/warehouse/stock?tab=low'),
      ('procurement', (select count(*) from public.v_low_stock)::int, 'Vật tư dưới tồn tối thiểu: ', 'Items below minimum stock: ', '/warehouse/stock?tab=low'),
      ('logistics', (select count(*) from public.shipments where status not in ('delivered','cancelled')
                      and planned_delivery_date < v_today)::int, 'Chuyến hàng trễ: ', 'Late shipments: ', '/r/shipments')
    ) x(role_code, cnt, title_vi, title_en, link)
  loop
    continue when r.cnt = 0;
    for u in select distinct ur.user_id from public.user_roles ur join public.profiles p on p.id = ur.user_id and p.is_active
              where ur.role_code = r.role_code loop
      perform app.notify_user_i18n(u, r.title_vi || r.cnt, r.title_en || r.cnt, null, null, r.link);
      n := n + 1;
    end loop;
  end loop;

  update public.digest_runs set notifications = n, ran_at = now() where run_date = v_today;
  if n > 0 then perform app.notify_chat('🗓 Daily digest ' || to_char(v_today, 'YYYY-MM-DD') || ': ' || n || ' reminders sent.'); end if;
  return n;
end $$;

-- "send now" from Settings (administrators)
create or replace function public.run_daily_digest_now() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.can('settings', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  return app.run_daily_digest(true);
end $$;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
revoke all on all tables in schema public from anon;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on all functions in schema app from anon, public;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on all functions in schema public from anon;
