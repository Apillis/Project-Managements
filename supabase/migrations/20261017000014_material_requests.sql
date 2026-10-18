-- =============================================================================
-- 0014 (v1.2) material requests — SRS phase 3: "materials are issued to the
-- site based on approved PMO requests". A material request (MR) lists what a
-- project activity needs from stock; once approved the warehouse issues it
-- line by line (stock_moves.mr_line_id), never more than requested.
-- Also: v_po_receiving_docs (PO headers without prices) for the receiving page,
-- whose PO filter used purchase_orders and stayed empty for the warehouse role.
-- =============================================================================

create table public.material_requests (
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null unique,
  project_id    uuid not null references public.projects(id),
  activity_id   uuid references public.activities(id) on delete set null,
  bom_id        uuid references public.boms(id),
  title         text,
  requested_by  uuid references public.profiles(id) default auth.uid(),
  needed_by     date,
  deliver_to    text,
  priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status        text not null default 'draft'
                check (status in ('draft','pending_approval','approved','rejected','partially_issued','issued','closed','cancelled')),
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index material_requests_project_idx on public.material_requests(project_id, status);
select app.attach_std('public.material_requests', 'material_request');

create table public.material_request_lines (
  id            uuid primary key default gen_random_uuid(),
  mr_id         uuid not null references public.material_requests(id) on delete cascade,
  line_no       int not null default 0,
  bom_line_id   uuid references public.bom_lines(id),
  item_id       uuid not null references public.items(id),
  description   text not null default '',
  qty           numeric(18,4) not null check (qty > 0),
  uom           text not null references public.uoms(code) on update cascade,
  issued_qty    numeric(18,4) not null default 0,
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index material_request_lines_mr_idx on public.material_request_lines(mr_id);
select app.attach_std('public.material_request_lines');
create trigger material_request_lines_no before insert on public.material_request_lines
  for each row execute function app.trg_line_no('mr_id');

-- item / BOM line data into the line; issued qty is maintained by the stock ledger only
create or replace function app.trg_mr_line_inherit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_project uuid; bl record;
begin
  if tg_op = 'INSERT' then new.issued_qty := 0;
  elsif coalesce(current_setting('app.ctx', true), '') <> 'system' then new.issued_qty := old.issued_qty;
  end if;
  if coalesce(current_setting('app.ctx', true), '') = 'system' and tg_op = 'UPDATE' then return new; end if;

  if new.bom_line_id is not null then
    select l.item_id, l.description, l.uom, b.project_id, b.status into bl
      from public.bom_lines l join public.boms b on b.id = l.bom_id where l.id = new.bom_line_id;
    if not found then raise exception 'BOM line not found' using errcode = 'P0001'; end if;
    select project_id into v_project from public.material_requests where id = new.mr_id;
    if bl.project_id <> v_project then
      raise exception 'The BOM line belongs to another project' using errcode = 'P0001';
    end if;
    if bl.item_id is null then
      raise exception 'The BOM line has no item; pick the item to issue' using errcode = 'P0001';
    end if;
    new.item_id := bl.item_id;
    if coalesce(new.description, '') = '' then new.description := bl.description; end if;
    new.uom := coalesce(new.uom, bl.uom);
  end if;
  if coalesce(new.description, '') = '' then
    select name into new.description from public.items where id = new.item_id;
  end if;
  return new;
end $$;
create trigger material_request_lines_inherit before insert or update on public.material_request_lines
  for each row execute function app.trg_mr_line_inherit();
create trigger material_request_lines_zz_uom before insert or update of uom, item_id on public.material_request_lines
  for each row execute function app.trg_norm_uom('EA');

-- approval engine: material requests are approved like PR (default: PM)
alter table public.approval_rules drop constraint approval_rules_doc_type_check;
alter table public.approval_rules add constraint approval_rules_doc_type_check
  check (doc_type in ('quotation','sales_order','bom','eco','purchase_request','purchase_order','cost_estimate','material_request'));

create or replace function app.doc_table(p_doc_type text) returns text
language sql immutable as $$
  select case p_doc_type
    when 'quotation' then 'quotations' when 'sales_order' then 'sales_orders' when 'bom' then 'boms'
    when 'eco' then 'ecos' when 'purchase_request' then 'purchase_requests' when 'purchase_order' then 'purchase_orders'
    when 'cost_estimate' then 'cost_estimates' when 'material_request' then 'material_requests' end
$$;

create or replace function app.doc_resource(p_doc_type text) returns text
language sql immutable as $$
  select case p_doc_type
    when 'quotation' then 'quotations' when 'sales_order' then 'sales_orders' when 'bom' then 'bom'
    when 'eco' then 'eco' when 'purchase_request' then 'pr' when 'purchase_order' then 'po'
    when 'cost_estimate' then 'costing' when 'material_request' then 'mr' end
$$;

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
  when 'cost_estimate' then
    select e.doc_no, e.status, e.project_id, e.l_sale_price_moq_base, e.line_count, e.title
      into doc_no, status, project_id, amount_base, line_count, label
      from public.v_cost_estimates e where e.id = p_doc_id;
    if line_count = 0 and exists (select 1 from public.cost_estimate_labor where estimate_id = p_doc_id) then line_count := 1; end if;
  when 'material_request' then
    select m.doc_no, m.status, m.project_id, 0, count(l.id), coalesce(m.title, m.doc_no)
      into doc_no, status, project_id, amount_base, line_count, label
      from public.material_requests m left join public.material_request_lines l on l.mr_id = m.id
     where m.id = p_doc_id group by m.id;
  else
    raise exception 'Unknown document type %', p_doc_type using errcode = 'P0001';
  end case;
  if doc_no is null then raise exception 'Document not found' using errcode = 'P0001'; end if;
end $$;

-- post-approval hooks: BOM supersedes older revisions; an approved MR tells the warehouse
create or replace function app.after_doc_approved(p_doc_type text, p_doc_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.boms; m record; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if p_doc_type = 'bom' then
    select * into b from public.boms where id = p_doc_id;
    perform set_config('app.ctx', 'system', true);
    update public.boms set status = 'superseded'
     where project_id = b.project_id and name = b.name and id <> b.id and status = 'approved';
    perform set_config('app.ctx', v_prev, true);
  elsif p_doc_type = 'material_request' then
    select r.doc_no, r.needed_by, p.code into m
      from public.material_requests r join public.projects p on p.id = r.project_id where r.id = p_doc_id;
    perform app.notify_roles(array['warehouse'], 'Material request ' || m.doc_no || ' approved',
      'Project ' || m.code || coalesce(' · needed by ' || to_char(m.needed_by, 'YYYY-MM-DD'), '') || ' — ready to issue.',
      '/warehouse/issue');
  end if;
end $$;

select app.attach_doc_guards('material_requests', 'closed,cancelled', 'needed_by,priority,deliver_to',
                             'material_request_lines', 'mr_id');

-- ---------------------------------------------------------------------------
-- Stock ledger: issues against material request lines
-- ---------------------------------------------------------------------------
alter table public.stock_moves add column mr_line_id uuid references public.material_request_lines(id);
create index stock_moves_mr_line_idx on public.stock_moves(mr_line_id);

-- runs after stock_moves_check (alphabetical order of BEFORE triggers)
create or replace function app.trg_stock_move_mr() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare l record;
begin
  if new.mr_line_id is null then
    if new.move_type = 'issue' and app.setting_bool('issue_requires_request', false)
       and coalesce(current_setting('app.ctx', true), '') <> 'system' and auth.uid() is not null then
      raise exception 'Issues need an approved material request (Settings: issue_requires_request)' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.move_type <> 'issue' then
    raise exception 'Only issues can reference a material request line' using errcode = 'P0001';
  end if;
  select ml.*, r.status as mr_status, r.project_id as mr_project, r.doc_no as mr_no into l
    from public.material_request_lines ml join public.material_requests r on r.id = ml.mr_id
   where ml.id = new.mr_line_id for update of ml;
  if not found then raise exception 'Material request line not found' using errcode = 'P0001'; end if;
  if l.mr_status not in ('approved','partially_issued') then
    raise exception 'Material request % is not approved (status: %)', l.mr_no, l.mr_status using errcode = 'P0001';
  end if;
  if l.item_id <> new.item_id then
    raise exception 'Issued item does not match the material request line' using errcode = 'P0001';
  end if;
  if new.project_id is not null and new.project_id <> l.mr_project then
    raise exception 'Stock reserved for another project cannot be issued to this request' using errcode = 'P0001';
  end if;
  if new.consume_project_id is not null and new.consume_project_id <> l.mr_project then
    raise exception 'The consuming project must be the project of the material request' using errcode = 'P0001';
  end if;
  new.consume_project_id := l.mr_project;
  if l.issued_qty + new.qty > l.qty then
    raise exception 'Over-issue: % already issued + % > requested %', l.issued_qty, new.qty, l.qty using errcode = 'P0001';
  end if;
  new.reference := coalesce(nullif(new.reference, ''), l.mr_no);
  return new;
end $$;
create trigger stock_moves_mr before insert on public.stock_moves
  for each row execute function app.trg_stock_move_mr();

create or replace function app.trg_stock_move_mr_after() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_mr uuid; v_total int; v_full int; v_any int; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if new.mr_line_id is null then return null; end if;
  perform set_config('app.ctx', 'system', true);
  update public.material_request_lines set issued_qty = issued_qty + new.qty where id = new.mr_line_id
  returning mr_id into v_mr;
  select count(*), count(*) filter (where issued_qty >= qty), count(*) filter (where issued_qty > 0)
    into v_total, v_full, v_any from public.material_request_lines where mr_id = v_mr;
  update public.material_requests
     set status = case when v_full = v_total then 'issued' when v_any > 0 then 'partially_issued' else status end
   where id = v_mr and status in ('approved','partially_issued');
  perform set_config('app.ctx', v_prev, true);
  return null;
end $$;
create trigger stock_moves_mr_after after insert on public.stock_moves
  for each row execute function app.trg_stock_move_mr_after();

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
create view public.v_material_requests with (security_invoker = on) as
select r.id, r.doc_no, r.project_id, p.code as project_code, r.activity_id, a.node_code, a.title as activity_title,
       r.bom_id, r.title, r.requested_by, u.full_name as requested_by_name, r.needed_by, r.deliver_to, r.priority, r.status,
       (select count(*) from public.material_request_lines l where l.mr_id = r.id) as line_count,
       (select count(*) from public.material_request_lines l where l.mr_id = r.id and l.issued_qty < l.qty) as open_lines,
       (r.status in ('approved','partially_issued') and r.needed_by < current_date) as is_late,
       r.notes, r.created_at, r.updated_at
  from public.material_requests r
  join public.projects p on p.id = r.project_id
  left join public.activities a on a.id = r.activity_id
  left join public.profiles u on u.id = r.requested_by;

create view public.v_material_request_lines with (security_invoker = on) as
select l.id, l.mr_id, r.doc_no as mr_no, r.status as mr_status, r.project_id, p.code as project_code, r.needed_by,
       r.deliver_to, r.priority, l.line_no, l.bom_line_id, l.item_id, i.sku, i.track_lot, i.track_serial, l.description,
       l.qty, l.uom, l.issued_qty, greatest(l.qty - l.issued_qty, 0) as open_qty,
       app.free_stock(l.item_id) as free_stock,
       coalesce((select sum(b.qty) from public.v_stock_balance b where b.item_id = l.item_id and b.project_id = r.project_id), 0) as project_stock,
       l.notes, r.created_at
  from public.material_request_lines l
  join public.material_requests r on r.id = l.mr_id
  join public.projects p on p.id = r.project_id
  join public.items i on i.id = l.item_id;

-- PO headers for receiving (no prices), built on v_po_receiving so the same
-- visibility rule applies (warehouse reads it without any right on purchase_orders)
create view public.v_po_receiving_docs with (security_invoker = on) as
select po_id, po_no, po_status, order_date, vendor_name, max(project_code) as project_code,
       min(promised_date) as promised_date, sum(open_qty) as open_qty, count(*) as line_count
  from public.v_po_receiving
 group by po_id, po_no, po_status, order_date, vendor_name;

-- RLS
select app.apply_resource_policies('material_requests', 'mr');
select app.apply_resource_policies('material_request_lines', 'mr');

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
revoke all on all tables in schema public from anon;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on all functions in schema app from anon, public;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on all functions in schema public from anon;
