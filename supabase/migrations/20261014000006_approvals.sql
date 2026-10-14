-- =============================================================================
-- 0006 approval engine (configurable matrix) and document status guards.
--
-- approval_rules: per doc type, sequential steps (step_no). Rules with the same
-- step_no run in parallel (all must approve). A rule applies when the document
-- amount in base currency is >= min_amount and < max_amount (if set).
-- Example: PO — step 1 procurement lead (all), step 2 management (>= 100M VND).
-- =============================================================================

create table public.approval_rules (
  id                uuid primary key default gen_random_uuid(),
  doc_type          text not null check (doc_type in ('quotation','sales_order','bom','eco','purchase_request','purchase_order')),
  step_no           smallint not null default 1 check (step_no between 1 and 9),
  name              text not null,
  min_amount        numeric(18,2) not null default 0 check (min_amount >= 0),
  max_amount        numeric(18,2) check (max_amount is null or max_amount > min_amount),
  approver_role     text references public.roles(code) on update cascade,
  approver_user_id  uuid references public.profiles(id),
  is_active         boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  check (approver_role is not null or approver_user_id is not null)
);
select app.attach_std('public.approval_rules');

create table public.approval_requests (
  id            uuid primary key default gen_random_uuid(),
  doc_type      text not null,
  doc_id        uuid not null,
  doc_no        text,
  project_id    uuid references public.projects(id) on delete set null,
  amount_base   numeric(18,2) not null default 0,
  status        text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  current_step  smallint,
  requested_by  uuid references public.profiles(id),
  requested_at  timestamptz not null default now(),
  decided_at    timestamptz
);
create index approval_requests_doc_idx on public.approval_requests(doc_type, doc_id);
create index approval_requests_status_idx on public.approval_requests(status);
create trigger approval_requests_audit after insert or update or delete on public.approval_requests
  for each row execute function app.trg_audit();

create table public.approval_steps (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references public.approval_requests(id) on delete cascade,
  step_no           smallint not null,
  name              text not null,
  approver_role     text references public.roles(code) on update cascade,
  approver_user_id  uuid references public.profiles(id),
  status            text not null default 'waiting' check (status in ('waiting','pending','approved','rejected','cancelled')),
  decided_by        uuid references public.profiles(id),
  decided_at        timestamptz,
  comment           text
);
create index approval_steps_request_idx on public.approval_steps(request_id, step_no);
create trigger approval_steps_audit after insert or update or delete on public.approval_steps
  for each row execute function app.trg_audit();

-- ---------------------------------------------------------------------------
-- Document registry
-- ---------------------------------------------------------------------------
create or replace function app.doc_table(p_doc_type text) returns text
language sql immutable as $$
  select case p_doc_type
    when 'quotation' then 'quotations'
    when 'sales_order' then 'sales_orders'
    when 'bom' then 'boms'
    when 'eco' then 'ecos'
    when 'purchase_request' then 'purchase_requests'
    when 'purchase_order' then 'purchase_orders' end
$$;

create or replace function app.doc_resource(p_doc_type text) returns text
language sql immutable as $$
  select case p_doc_type
    when 'quotation' then 'quotations'
    when 'sales_order' then 'sales_orders'
    when 'bom' then 'bom'
    when 'eco' then 'eco'
    when 'purchase_request' then 'pr'
    when 'purchase_order' then 'po' end
$$;

-- Returns doc_no, status, project_id, amount in base currency, line count
create or replace function app.doc_info(p_doc_type text, p_doc_id uuid,
  out doc_no text, out status text, out project_id uuid, out amount_base numeric, out line_count int, out label text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  case p_doc_type
  when 'quotation' then
    select q.doc_no, q.status, null::uuid, app.to_base(coalesce(sum(app.line_net(l.qty, l.unit_price, l.discount_pct)), 0),
             q.currency_code, q.exchange_rate, q.quote_date), count(l.id), q.title
      into doc_no, status, project_id, amount_base, line_count, label
      from public.quotations q left join public.quotation_lines l on l.quotation_id = q.id
     where q.id = p_doc_id group by q.id;
  when 'sales_order' then
    select s.doc_no, s.status, s.project_id, app.to_base(coalesce(sum(app.line_net(l.qty, l.unit_price, l.discount_pct)), 0),
             s.currency_code, s.exchange_rate, s.order_date), count(l.id), coalesce(s.customer_po_no, s.doc_no)
      into doc_no, status, project_id, amount_base, line_count, label
      from public.sales_orders s left join public.sales_order_lines l on l.sales_order_id = s.id
     where s.id = p_doc_id group by s.id;
  when 'bom' then
    select p.code || ' · ' || b.name || ' rev ' || b.revision, b.status, b.project_id, 0, count(l.id), b.name
      into doc_no, status, project_id, amount_base, line_count, label
      from public.boms b join public.projects p on p.id = b.project_id
      left join public.bom_lines l on l.bom_id = b.id
     where b.id = p_doc_id group by b.id, p.code;
  when 'eco' then
    select e.doc_no, e.status, e.project_id,
           app.to_base(abs(e.impact_cost), coalesce(e.impact_currency, app.base_currency()), null, current_date), 1, e.title
      into doc_no, status, project_id, amount_base, line_count, label
      from public.ecos e where e.id = p_doc_id;
  when 'purchase_request' then
    select r.doc_no, r.status, r.project_id, 0, count(l.id), r.title
      into doc_no, status, project_id, amount_base, line_count, label
      from public.purchase_requests r left join public.pr_lines l on l.pr_id = r.id
     where r.id = p_doc_id group by r.id;
  when 'purchase_order' then
    select o.doc_no, o.status, o.project_id, app.to_base(coalesce(sum(app.line_net(l.qty, l.unit_price, l.discount_pct)), 0),
             o.currency_code, o.exchange_rate, o.order_date), count(l.id), o.doc_no
      into doc_no, status, project_id, amount_base, line_count, label
      from public.purchase_orders o left join public.po_lines l on l.po_id = o.id
     where o.id = p_doc_id group by o.id;
  else
    raise exception 'Unknown document type %', p_doc_type using errcode = 'P0001';
  end case;
  if doc_no is null then raise exception 'Document not found' using errcode = 'P0001'; end if;
end $$;

create or replace function app.set_doc_status(p_doc_type text, p_doc_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  perform set_config('app.ctx', 'approval', true);
  execute format('update public.%I set status = $1 where id = $2', app.doc_table(p_doc_type)) using p_status, p_doc_id;
  perform set_config('app.ctx', v_prev, true);
end $$;

-- Post-approval hooks
create or replace function app.after_doc_approved(p_doc_type text, p_doc_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.boms; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if p_doc_type = 'bom' then
    select * into b from public.boms where id = p_doc_id;
    perform set_config('app.ctx', 'system', true);
    update public.boms set status = 'superseded'
     where project_id = b.project_id and name = b.name and id <> b.id and status = 'approved';
    perform set_config('app.ctx', v_prev, true);
  end if;
end $$;

create or replace function app.step_approvers(p_role text, p_user uuid) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select array(
    select p.id from public.profiles p
     where p.is_active and (p.id = p_user
       or (p_role is not null and exists (select 1 from public.user_roles ur where ur.user_id = p.id and ur.role_code = p_role))))
$$;

create or replace function app.notify_current_step(p_request_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.approval_requests; s record; v_users uuid[] := '{}';
begin
  select * into r from public.approval_requests where id = p_request_id;
  for s in select * from public.approval_steps where request_id = p_request_id and status = 'pending' loop
    v_users := v_users || app.step_approvers(s.approver_role, s.approver_user_id);
  end loop;
  perform app.notify_users(v_users, 'Approval needed: ' || r.doc_no,
    'Document ' || r.doc_no || ' (' || r.doc_type || ') is waiting for your approval.', '/approvals');
  perform app.notify_chat('📝 Approval needed: ' || r.doc_no || ' (' || r.doc_type || ', step ' || r.current_step || ')');
end $$;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------
create or replace function public.submit_for_approval(p_doc_type text, p_doc_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d record;
  v_req uuid;
  v_first smallint;
begin
  if app.doc_table(p_doc_type) is null then
    raise exception 'Unknown document type %', p_doc_type using errcode = 'P0001';
  end if;
  if not app.can(app.doc_resource(p_doc_type), 'write') then
    raise exception 'Not allowed to submit this document' using errcode = '42501';
  end if;
  select * into d from app.doc_info(p_doc_type, p_doc_id);
  if d.status not in ('draft','rejected') then
    raise exception 'Only draft or rejected documents can be submitted (status: %)', d.status using errcode = 'P0001';
  end if;
  if d.line_count = 0 then
    raise exception 'The document has no lines' using errcode = 'P0001';
  end if;

  insert into public.approval_requests(doc_type, doc_id, doc_no, project_id, amount_base, requested_by)
  values (p_doc_type, p_doc_id, d.doc_no, d.project_id, round(d.amount_base, 2), auth.uid())
  returning id into v_req;

  insert into public.approval_steps(request_id, step_no, name, approver_role, approver_user_id)
  select v_req, r.step_no, r.name, r.approver_role, r.approver_user_id
    from public.approval_rules r
   where r.is_active and r.doc_type = p_doc_type
     and d.amount_base >= r.min_amount and (r.max_amount is null or d.amount_base < r.max_amount)
   order by r.step_no;

  select min(step_no) into v_first from public.approval_steps where request_id = v_req;
  if v_first is null then
    -- no rule matches → approved automatically
    update public.approval_requests set status = 'approved', decided_at = now() where id = v_req;
    perform app.set_doc_status(p_doc_type, p_doc_id, 'approved');
    perform app.after_doc_approved(p_doc_type, p_doc_id);
    return v_req;
  end if;

  update public.approval_steps set status = 'pending' where request_id = v_req and step_no = v_first;
  update public.approval_requests set current_step = v_first where id = v_req;
  perform app.set_doc_status(p_doc_type, p_doc_id, 'pending_approval');
  perform app.notify_current_step(v_req);
  return v_req;
end $$;

create or replace function public.decide_approval(p_request_id uuid, p_decision text, p_comment text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.approval_requests;
  v_n int;
  v_next smallint;
begin
  if p_decision not in ('approve','reject') then
    raise exception 'Decision must be approve or reject' using errcode = 'P0001';
  end if;
  select * into r from public.approval_requests where id = p_request_id for update;
  if not found or r.status <> 'pending' then
    raise exception 'Request is not pending' using errcode = 'P0001';
  end if;
  if r.requested_by = auth.uid() and not app.is_admin() and not app.setting_bool('approval_allow_self', false) then
    raise exception 'You cannot approve a document you submitted (segregation of duties)' using errcode = '42501';
  end if;
  if p_decision = 'reject' and coalesce(btrim(p_comment), '') = '' then
    raise exception 'A comment is required to reject' using errcode = 'P0001';
  end if;

  update public.approval_steps s
     set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), comment = p_comment
   where s.request_id = r.id and s.status = 'pending'
     and (s.approver_user_id = auth.uid() or app.has_role(s.approver_role) or app.is_admin());
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'You are not an approver of the current step' using errcode = '42501';
  end if;

  if p_decision = 'reject' then
    update public.approval_steps set status = 'cancelled' where request_id = r.id and status in ('waiting','pending');
    update public.approval_requests set status = 'rejected', decided_at = now() where id = r.id;
    perform app.set_doc_status(r.doc_type, r.doc_id, 'rejected');
    perform app.notify_users(array[r.requested_by], 'Rejected: ' || r.doc_no, coalesce(p_comment, ''), '/approvals');
    return 'rejected';
  end if;

  if exists (select 1 from public.approval_steps where request_id = r.id and status = 'pending') then
    return 'pending';
  end if;

  select min(step_no) into v_next from public.approval_steps where request_id = r.id and status = 'waiting';
  if v_next is not null then
    update public.approval_steps set status = 'pending' where request_id = r.id and step_no = v_next;
    update public.approval_requests set current_step = v_next where id = r.id;
    perform app.notify_current_step(r.id);
    return 'pending';
  end if;

  update public.approval_requests set status = 'approved', decided_at = now() where id = r.id;
  perform app.set_doc_status(r.doc_type, r.doc_id, 'approved');
  perform app.after_doc_approved(r.doc_type, r.doc_id);
  perform app.notify_users(array[r.requested_by], 'Approved: ' || r.doc_no, 'Your document was approved.', '/approvals');
  return 'approved';
end $$;

create or replace function public.cancel_approval(p_request_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.approval_requests;
begin
  select * into r from public.approval_requests where id = p_request_id for update;
  if not found or r.status <> 'pending' then
    raise exception 'Request is not pending' using errcode = 'P0001';
  end if;
  if r.requested_by is distinct from auth.uid() and not app.is_admin() then
    raise exception 'Only the requester or an administrator can withdraw' using errcode = '42501';
  end if;
  update public.approval_steps set status = 'cancelled' where request_id = r.id and status in ('waiting','pending');
  update public.approval_requests set status = 'cancelled', decided_at = now() where id = r.id;
  perform app.set_doc_status(r.doc_type, r.doc_id, 'draft');
end $$;

-- Requests the current user can act on now
create or replace function public.my_pending_approvals()
returns setof public.approval_requests
language sql stable security definer set search_path = public, pg_temp as $$
  select r.* from public.approval_requests r
   where r.status = 'pending'
     and exists (select 1 from public.approval_steps s
                  where s.request_id = r.id and s.status = 'pending'
                    and (s.approver_user_id = auth.uid() or app.has_role(s.approver_role) or app.is_admin()))
   order by r.requested_at
$$;

-- ---------------------------------------------------------------------------
-- Status & content guards on approvable documents
--   tg_argv[0] = statuses a user may set manually after approval (csv)
--   tg_argv[1] = header columns a user may still edit after submission (csv)
-- ---------------------------------------------------------------------------
create or replace function app.trg_guard_doc() returns trigger
language plpgsql as $$
declare
  v_ctx text := coalesce(current_setting('app.ctx', true), '');
  v_after text[] := string_to_array(coalesce(tg_argv[0], ''), ',');
  v_free text[] := array['status','notes','updated_at','updated_by'] || string_to_array(coalesce(tg_argv[1], ''), ',');
begin
  if v_ctx in ('approval','system') or auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('draft') then
      raise exception 'New documents must start as draft' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status in ('pending_approval','approved','rejected','superseded','implemented','partially_ordered','ordered_all',
                      'partially_received','received') and not (new.status = any(v_after)) then
      raise exception 'Status "%" is set by the system workflow', new.status using errcode = 'P0001';
    end if;
    if old.status = 'pending_approval' then
      raise exception 'The document is waiting for approval' using errcode = 'P0001';
    end if;
    if old.status in ('draft','rejected') and new.status not in ('draft','cancelled') then
      raise exception 'Submit the document for approval first' using errcode = 'P0001';
    end if;
    if old.status in ('cancelled','closed','superseded','implemented') then
      raise exception 'The document is % and cannot change status', old.status using errcode = 'P0001';
    end if;
    if old.status not in ('draft','rejected') and not (new.status = any(v_after)) then
      raise exception 'Status change % → % is not allowed', old.status, new.status using errcode = 'P0001';
    end if;
  end if;

  if old.status not in ('draft','rejected') then
    if (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
      raise exception 'The document is locked (status %). Only % can be changed.', old.status, array_to_string(v_free, ', ')
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create or replace function app.trg_guard_doc_delete() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.ctx', true), '') in ('system','approval') or auth.uid() is null then
    return old;
  end if;
  if old.status <> 'draft' then
    raise exception 'Only draft documents can be deleted; cancel it instead' using errcode = 'P0001';
  end if;
  return old;
end $$;

create or replace function app.trg_guard_lines() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status text; v_parent uuid;
begin
  if coalesce(current_setting('app.ctx', true), '') in ('system','approval') or auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_parent := ((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> tg_argv[1])::uuid;
  execute format('select status from public.%I where id = $1', tg_argv[0]) into v_status using v_parent;
  if v_status is not null and v_status not in ('draft','rejected') then
    raise exception 'Lines are locked while the document is %', v_status using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    v_parent := (to_jsonb(old) ->> tg_argv[1])::uuid;
    execute format('select status from public.%I where id = $1', tg_argv[0]) into v_status using v_parent;
    if v_status is not null and v_status not in ('draft','rejected') then
      raise exception 'Lines are locked while the document is %', v_status using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create or replace function app.attach_doc_guards(p_table text, p_after text, p_free text,
                                                 p_lines text default null, p_fk text default null)
returns void language plpgsql as $$
begin
  execute format('create trigger %I before insert or update on public.%I for each row execute function app.trg_guard_doc(%L, %L)',
                 p_table || '_guard', p_table, p_after, p_free);
  execute format('create trigger %I before delete on public.%I for each row execute function app.trg_guard_doc_delete()',
                 p_table || '_guard_del', p_table);
  if p_lines is not null then
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function app.trg_guard_lines(%L, %L)',
                   p_lines || '_guard', p_lines, p_table, p_fk);
  end if;
end $$;

select app.attach_doc_guards('quotations', 'sent,won,lost,cancelled', 'probability,expected_close,lost_reason,valid_until',
                             'quotation_lines', 'quotation_id');
select app.attach_doc_guards('sales_orders', 'in_progress,delivered,closed,cancelled', 'delivery_date,project_id,customer_po_no',
                             'sales_order_lines', 'sales_order_id');
select app.attach_doc_guards('boms', 'cancelled', '', 'bom_lines', 'bom_id');
select app.attach_doc_guards('ecos', 'cancelled', '');
select app.attach_doc_guards('purchase_requests', 'closed,cancelled', 'needed_by,priority', 'pr_lines', 'pr_id');
select app.attach_doc_guards('purchase_orders', 'ordered,closed,cancelled', 'promised_date,vendor_ref,delivery_address',
                             'po_lines', 'po_id');

-- Cancelling a document in approval also cancels the open request (via cancel_approval only).
-- Quotation won → notify PMO so a project/SO can be created.
create or replace function app.trg_quotation_won() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'won' and old.status <> 'won' then
    perform app.notify_roles(array['pmo','management'], 'Quotation won: ' || new.doc_no,
      new.title || ' — create the sales order and project.', '/sales/quotations');
    perform app.notify_chat('🎉 Quotation won: ' || new.doc_no || ' · ' || new.title);
  end if;
  return null;
end $$;
create trigger quotations_won after update of status on public.quotations
  for each row execute function app.trg_quotation_won();
