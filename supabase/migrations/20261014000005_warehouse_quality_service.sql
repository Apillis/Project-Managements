-- =============================================================================
-- 0005 warehouse (insert-only stock ledger), quality (inspections, NCR,
-- compliance dossier for EU/US), service tickets.
-- =============================================================================

-- Stock ledger. Balance contribution:
--   inflow : (item, to_location,   coalesce(to_project_id, project_id), lot, serial)  +qty
--   outflow: (item, from_location, project_id,                          lot, serial)  -qty
-- project_id = the "bucket" that owns the stock (null = general stock).
create table public.stock_moves (
  id                  uuid primary key default gen_random_uuid(),
  doc_no              text not null unique,
  move_type           text not null check (move_type in ('receipt','issue','return','transfer','adjust')),
  move_date           timestamptz not null default now(),
  item_id             uuid not null references public.items(id),
  qty                 numeric(18,4) not null check (qty > 0),
  from_location_id    uuid references public.locations(id),
  to_location_id      uuid references public.locations(id),
  project_id          uuid references public.projects(id),
  to_project_id       uuid references public.projects(id),
  consume_project_id  uuid references public.projects(id),
  po_line_id          uuid references public.po_lines(id),
  lot_no              text,
  serial_no           text,
  reference           text,
  notes               text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index stock_moves_item_idx on public.stock_moves(item_id, move_date);
create index stock_moves_po_line_idx on public.stock_moves(po_line_id);
create index stock_moves_project_idx on public.stock_moves(consume_project_id);
select app.attach_std('public.stock_moves', 'stock_move');

create or replace function app.stock_qty(p_item uuid, p_location uuid, p_project uuid, p_lot text, p_serial text)
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(q), 0) from (
    select qty q from public.stock_moves
     where item_id = p_item and to_location_id = p_location
       and coalesce(to_project_id, project_id) is not distinct from p_project
       and lot_no is not distinct from p_lot and serial_no is not distinct from p_serial
    union all
    select -qty from public.stock_moves
     where item_id = p_item and from_location_id = p_location
       and project_id is not distinct from p_project
       and lot_no is not distinct from p_lot and serial_no is not distinct from p_serial) t
$$;

create or replace function app.trg_stock_move_check() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  i public.items;
  pl record;
  v_tol numeric := coalesce((app.setting('receipt_tolerance_pct') #>> '{}')::numeric, 0);
  v_avail numeric;
  v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  select * into i from public.items where id = new.item_id;
  if not i.is_stocked then
    raise exception 'Item % is not a stocked item', i.sku using errcode = 'P0001';
  end if;
  new.lot_no := nullif(btrim(new.lot_no), '');
  new.serial_no := nullif(btrim(new.serial_no), '');
  if i.track_lot and new.lot_no is null then
    raise exception 'Lot number is required for %', i.sku using errcode = 'P0001';
  end if;
  if i.track_serial then
    if new.serial_no is null then raise exception 'Serial number is required for %', i.sku using errcode = 'P0001'; end if;
    if new.qty <> 1 then raise exception 'Serial-tracked items move one by one (qty = 1)' using errcode = 'P0001'; end if;
  end if;

  case new.move_type
    when 'receipt' then
      if new.to_location_id is null or new.from_location_id is not null then
        raise exception 'A receipt needs a destination location only' using errcode = 'P0001';
      end if;
    when 'issue' then
      if new.from_location_id is null or new.to_location_id is not null then
        raise exception 'An issue needs a source location only' using errcode = 'P0001';
      end if;
      new.consume_project_id := coalesce(new.consume_project_id, new.project_id);
    when 'return' then
      if new.to_location_id is null or new.from_location_id is not null then
        raise exception 'A return needs a destination location only' using errcode = 'P0001';
      end if;
    when 'transfer' then
      if new.to_location_id is null or new.from_location_id is null then
        raise exception 'A transfer needs source and destination' using errcode = 'P0001';
      end if;
      if new.to_location_id = new.from_location_id and new.to_project_id is not distinct from new.project_id then
        raise exception 'Transfer source and destination are identical' using errcode = 'P0001';
      end if;
    when 'adjust' then
      if (new.to_location_id is null) = (new.from_location_id is null) then
        raise exception 'An adjustment needs exactly one location (to = increase, from = decrease)' using errcode = 'P0001';
      end if;
      if coalesce(btrim(new.notes), '') = '' then
        raise exception 'A reason (notes) is required for an adjustment' using errcode = 'P0001';
      end if;
  end case;

  if new.po_line_id is not null then
    if new.move_type <> 'receipt' then
      raise exception 'Only receipts can reference a PO line' using errcode = 'P0001';
    end if;
    select l.*, o.status as po_status into pl
      from public.po_lines l join public.purchase_orders o on o.id = l.po_id where l.id = new.po_line_id
      for update of l;
    if pl.po_status not in ('approved','ordered','partially_received') then
      raise exception 'PO must be approved/ordered to receive goods (status: %)', pl.po_status using errcode = 'P0001';
    end if;
    if pl.item_id is distinct from new.item_id then
      raise exception 'Received item does not match the PO line' using errcode = 'P0001';
    end if;
    if pl.received_qty + new.qty > pl.qty * (1 + v_tol / 100.0) then
      raise exception 'Over-receipt: % already received + % > ordered %', pl.received_qty, new.qty, pl.qty
        using errcode = 'P0001';
    end if;
    new.project_id := coalesce(new.project_id, pl.project_id);
  end if;

  -- outflow: never below zero
  if new.from_location_id is not null then
    perform pg_advisory_xact_lock(hashtext(new.item_id::text));
    v_avail := app.stock_qty(new.item_id, new.from_location_id, new.project_id, new.lot_no, new.serial_no);
    if v_avail < new.qty then
      raise exception 'Insufficient stock for % at this location/bucket: available %, requested %',
        i.sku, v_avail, new.qty using errcode = 'P0001';
    end if;
  end if;
  if new.to_location_id is not null and i.track_serial then
    perform pg_advisory_xact_lock(hashtext(new.item_id::text));
    if exists (select 1 from public.stock_moves m where m.item_id = new.item_id and m.serial_no = new.serial_no
               group by m.item_id
               having sum(case when m.to_location_id is not null then m.qty else 0 end)
                    - sum(case when m.from_location_id is not null then m.qty else 0 end) > 0)
       and new.move_type in ('receipt','return','adjust') then
      raise exception 'Serial % is already in stock', new.serial_no using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger stock_moves_check before insert on public.stock_moves
  for each row execute function app.trg_stock_move_check();

create or replace function app.trg_stock_move_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'Stock moves are immutable. Post a reverse move to correct.' using errcode = 'P0001';
end $$;
create trigger stock_moves_immutable before update or delete on public.stock_moves
  for each row execute function app.trg_stock_move_immutable();

-- Receipt → PO line received qty → PO status
create or replace function app.trg_stock_move_receipt() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_po uuid; v_total int; v_full int; v_any int; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if new.po_line_id is null then return null; end if;
  perform set_config('app.ctx', 'system', true);
  update public.po_lines set received_qty = received_qty + new.qty where id = new.po_line_id
  returning po_id into v_po;
  select count(*), count(*) filter (where received_qty >= qty), count(*) filter (where received_qty > 0)
    into v_total, v_full, v_any from public.po_lines where po_id = v_po;
  update public.purchase_orders
     set status = case when v_full = v_total then 'received' when v_any > 0 then 'partially_received' else status end
   where id = v_po;
  perform set_config('app.ctx', v_prev, true);
  return null;
end $$;
create trigger stock_moves_receipt after insert on public.stock_moves
  for each row execute function app.trg_stock_move_receipt();

-- ---------------------------------------------------------------------------
-- Quality
-- ---------------------------------------------------------------------------
create table public.inspections (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  inspection_type text not null check (inspection_type in ('incoming','in_process','fat','sat','final')),
  project_id      uuid references public.projects(id),
  activity_id     uuid references public.activities(id) on delete set null,
  po_line_id      uuid references public.po_lines(id),
  item_id         uuid references public.items(id),
  stock_move_id   uuid references public.stock_moves(id),
  qty_inspected   numeric(18,4),
  qty_rejected    numeric(18,4) not null default 0 check (qty_rejected >= 0),
  result          text not null default 'pending' check (result in ('pending','pass','fail','conditional')),
  inspector_id    uuid references public.profiles(id) default auth.uid(),
  inspected_at    timestamptz,
  checklist       jsonb not null default '[]'::jsonb,
  customer_witness text,
  notes           text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  check (qty_inspected is null or qty_rejected <= qty_inspected)
);
create index inspections_project_idx on public.inspections(project_id, inspection_type);
select app.attach_std('public.inspections', 'inspection');

create table public.ncrs (
  id                uuid primary key default gen_random_uuid(),
  doc_no            text not null unique,
  project_id        uuid references public.projects(id),
  inspection_id     uuid references public.inspections(id),
  item_id           uuid references public.items(id),
  vendor_id         uuid references public.partners(id),
  po_line_id        uuid references public.po_lines(id),
  title             text not null,
  description       text,
  severity          text not null default 'minor' check (severity in ('minor','major','critical')),
  qty               numeric(18,4),
  disposition       text not null default 'pending'
                    check (disposition in ('pending','rework','repair','return_to_vendor','scrap','use_as_is')),
  root_cause        text,
  corrective_action text,
  preventive_action text,
  owner_id          uuid references public.profiles(id),
  due_date          date,
  status            text not null default 'open'
                    check (status in ('open','investigating','action','verification','closed','cancelled')),
  cost_impact       numeric(18,2),
  closed_at         timestamptz,
  closed_by         uuid references public.profiles(id),
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index ncrs_vendor_idx on public.ncrs(vendor_id);
create index ncrs_project_idx on public.ncrs(project_id, status);
select app.attach_std('public.ncrs', 'ncr');

create or replace function app.trg_ncr_close() returns trigger
language plpgsql as $$
begin
  if new.status = 'closed' and (tg_op = 'INSERT' or old.status <> 'closed') then
    if coalesce(btrim(new.root_cause), '') = '' or coalesce(btrim(new.corrective_action), '') = ''
       or new.disposition = 'pending' then
      raise exception 'To close an NCR fill in root cause, corrective action and disposition' using errcode = 'P0001';
    end if;
    new.closed_at := now(); new.closed_by := auth.uid();
  elsif new.status <> 'closed' then
    new.closed_at := null; new.closed_by := null;
  end if;
  return new;
end $$;
create trigger ncrs_close before insert or update on public.ncrs
  for each row execute function app.trg_ncr_close();

-- Failed inspection → automatic NCR + notifications
create or replace function app.trg_inspection_fail() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_vendor uuid; v_ncr text; v_proj text;
begin
  if new.result = 'fail' and (tg_op = 'INSERT' or old.result <> 'fail') then
    if new.po_line_id is not null then
      select o.vendor_id into v_vendor from public.po_lines l join public.purchase_orders o on o.id = l.po_id
       where l.id = new.po_line_id;
    end if;
    insert into public.ncrs(project_id, inspection_id, item_id, vendor_id, po_line_id, title, description, qty, severity)
    values (new.project_id, new.id, new.item_id, v_vendor, new.po_line_id,
            'Inspection ' || new.doc_no || ' failed', new.notes, nullif(new.qty_rejected, 0),
            case when new.inspection_type in ('fat','sat') then 'major' else 'minor' end)
    returning doc_no into v_ncr;
    select code into v_proj from public.projects where id = new.project_id;
    perform app.notify_roles(array['qa','engineering_lead','pmo'], 'NCR ' || v_ncr,
      'Inspection ' || new.doc_no || coalesce(' (' || v_proj || ')', '') || ' failed. NCR ' || v_ncr || ' was opened.',
      '/quality/ncrs');
    perform app.notify_chat('⚠️ NCR ' || v_ncr || coalesce(' · project ' || v_proj, '') || ': inspection ' || new.doc_no || ' failed.');
  end if;
  if new.result <> 'pending' and new.inspected_at is null then
    update public.inspections set inspected_at = now() where id = new.id;
  end if;
  return null;
end $$;
create trigger inspections_fail after insert or update of result on public.inspections
  for each row execute function app.trg_inspection_fail();

-- Compliance dossier (EU / US market requirements)
create table public.compliance_templates (
  id            uuid primary key default gen_random_uuid(),
  market        text not null check (market in ('EU','US','CA','VN','GLOBAL')),
  code          text not null unique,
  title_en      text not null,
  title_vi      text not null,
  standard_ref  text,
  category      text not null default 'document'
                check (category in ('directive','standard','document','test','marking','training')),
  description   text,
  sort          int not null default 0,
  is_active     boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.compliance_templates');

create table public.project_compliance (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  template_id     uuid references public.compliance_templates(id),
  market          text not null,
  code            text,
  title           text not null,
  standard_ref    text,
  category        text not null default 'document',
  status          text not null default 'not_started'
                  check (status in ('not_started','in_progress','done','not_applicable')),
  responsible_id  uuid references public.profiles(id),
  due_date        date,
  document_id     uuid references public.documents(id) on delete set null,
  evidence_note   text,
  verified_by     uuid references public.profiles(id),
  verified_at     timestamptz,
  sort            int not null default 0,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  unique (project_id, template_id)
);
select app.attach_std('public.project_compliance');

create or replace function app.trg_compliance_done() returns trigger
language plpgsql as $$
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    if new.document_id is null and coalesce(btrim(new.evidence_note), '') = '' then
      raise exception 'Attach a document or write an evidence note before marking done' using errcode = 'P0001';
    end if;
    new.verified_by := auth.uid(); new.verified_at := now();
  elsif new.status = 'not_applicable' and coalesce(btrim(new.evidence_note), '') = '' then
    raise exception 'Explain why the requirement is not applicable (evidence note)' using errcode = 'P0001';
  elsif new.status not in ('done') then
    new.verified_by := null; new.verified_at := null;
  end if;
  return new;
end $$;
create trigger project_compliance_done before insert or update on public.project_compliance
  for each row execute function app.trg_compliance_done();

create or replace function public.apply_compliance_templates(p_project_id uuid, p_markets text[], p_lang text default 'vi')
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if not app.can('compliance', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  insert into public.project_compliance(project_id, template_id, market, code, title, standard_ref, category, sort)
  select p_project_id, t.id, t.market, t.code, case when p_lang = 'en' then t.title_en else t.title_vi end,
         t.standard_ref, t.category, t.sort
    from public.compliance_templates t
   where t.is_active and (t.market = any(p_markets) or t.market = 'GLOBAL')
  on conflict (project_id, template_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Service / warranty
-- ---------------------------------------------------------------------------
create table public.service_tickets (
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null unique,
  project_id    uuid references public.projects(id),
  customer_id   uuid references public.partners(id),
  title         text not null,
  description   text,
  reported_at   timestamptz not null default now(),
  is_warranty   boolean not null default true,
  priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status        text not null default 'open' check (status in ('open','in_progress','waiting_parts','resolved','closed','cancelled')),
  assignee_id   uuid references public.profiles(id),
  resolution    text,
  closed_at     timestamptz,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.service_tickets', 'service_ticket');

create or replace function app.trg_service_close() returns trigger
language plpgsql as $$
begin
  if new.status in ('resolved','closed') and coalesce(btrim(new.resolution), '') = '' then
    raise exception 'Resolution is required to resolve/close a ticket' using errcode = 'P0001';
  end if;
  if new.status = 'closed' and (tg_op = 'INSERT' or old.status <> 'closed') then new.closed_at := now();
  elsif new.status <> 'closed' then new.closed_at := null; end if;
  return new;
end $$;
create trigger service_tickets_close before insert or update on public.service_tickets
  for each row execute function app.trg_service_close();
