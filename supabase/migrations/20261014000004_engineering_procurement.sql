-- =============================================================================
-- 0004 engineering (documents, BOM with revisions, ECO) and procurement
-- (purchase requests, purchase orders). Downstream documents inherit upstream
-- data read-only: a PR line copies item/qty from the approved BOM line and can
-- never exceed it; a PO line copies the PR line.
-- =============================================================================

create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references public.projects(id) on delete cascade,
  activity_id   uuid references public.activities(id) on delete set null,
  category      text not null default 'other'
                check (category in ('drawing_mech','drawing_elec','drawing_pneu','plc_program','hmi_program',
                                    'manual','datasheet','certificate','ce_technical_file','risk_assessment',
                                    'test_report','fat_report','sat_report','quotation','contract','photo','other')),
  doc_no        text,
  title         text not null,
  revision      text not null default 'A',
  status        text not null default 'draft' check (status in ('draft','in_review','released','obsolete')),
  storage_path  text,
  file_name     text,
  file_size     bigint,
  mime_type     text,
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index documents_project_idx on public.documents(project_id, category);
select app.attach_std('public.documents');

-- ---------------------------------------------------------------------------
-- ECO (engineering change order) and BOM
-- ---------------------------------------------------------------------------
create or replace function app.rev_letter(p_n int) returns text
language plpgsql immutable as $$
declare v text := ''; n int := p_n;
begin
  if n is null or n < 1 then return null; end if;
  while n > 0 loop
    v := chr(65 + ((n - 1) % 26)) || v;
    n := (n - 1) / 26;
  end loop;
  return v;
end $$;

create table public.boms (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  name          text not null default 'Main BOM',
  rev_no        int not null default 1 check (rev_no >= 1),
  revision      text not null default 'A',
  status        text not null default 'draft'
                check (status in ('draft','pending_approval','approved','rejected','superseded','cancelled')),
  based_on_id   uuid references public.boms(id),
  eco_id        uuid,
  approved_at   timestamptz,
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  unique (project_id, name, rev_no)
);
create unique index boms_one_open_rev on public.boms(project_id, name)
  where status in ('draft','pending_approval','rejected');
select app.attach_std('public.boms');

create or replace function app.trg_bom_rev() returns trigger
language plpgsql as $$
begin
  new.revision := app.rev_letter(new.rev_no);
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status <> 'approved') then
    new.approved_at := now();
  end if;
  return new;
end $$;
create trigger boms_rev before insert or update on public.boms
  for each row execute function app.trg_bom_rev();

create table public.bom_lines (
  id            uuid primary key default gen_random_uuid(),
  bom_id        uuid not null references public.boms(id) on delete cascade,
  line_no       int not null default 0,
  item_id       uuid references public.items(id),
  description   text not null,
  manufacturer  text,
  mpn           text,
  qty           numeric(18,4) not null check (qty > 0),
  uom           text not null default 'pcs',
  position      text,
  discipline    text not null default 'mech'
                check (discipline in ('mech','elec','pneu','hydraulic','software','consumable','other')),
  make_or_buy   text not null default 'buy' check (make_or_buy in ('buy','make','stock')),
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index bom_lines_bom_idx on public.bom_lines(bom_id);
create index bom_lines_item_idx on public.bom_lines(item_id);
select app.attach_std('public.bom_lines');
create trigger bom_lines_no before insert on public.bom_lines
  for each row execute function app.trg_line_no('bom_id');

create or replace function app.trg_bom_line_item() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.items;
begin
  if new.item_id is null then return new; end if;
  select * into i from public.items where id = new.item_id;
  if coalesce(new.description, '') = '' then new.description := i.name; end if;
  new.manufacturer := coalesce(nullif(new.manufacturer, ''), i.manufacturer);
  new.mpn := coalesce(nullif(new.mpn, ''), i.mpn);
  if tg_op = 'INSERT' and new.uom = 'pcs' then new.uom := i.uom; end if;
  return new;
end $$;
create trigger bom_lines_item before insert or update of item_id on public.bom_lines
  for each row execute function app.trg_bom_line_item();

create table public.ecos (
  id                  uuid primary key default gen_random_uuid(),
  doc_no              text not null unique,
  project_id          uuid not null references public.projects(id) on delete cascade,
  bom_id              uuid references public.boms(id),
  title               text not null,
  reason              text not null default 'improvement'
                      check (reason in ('customer_request','design_error','improvement','obsolescence','cost','compliance','other')),
  description         text,
  impact_cost         numeric(18,2) not null default 0,
  impact_currency     char(3) references public.currencies(code),
  impact_days         int not null default 0,
  status              text not null default 'draft'
                      check (status in ('draft','pending_approval','approved','rejected','implemented','cancelled')),
  implemented_bom_id  uuid references public.boms(id),
  notes               text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.ecos', 'eco');
alter table public.boms add constraint boms_eco_fk foreign key (eco_id) references public.ecos(id);

-- New BOM revision. Revising an APPROVED BOM requires an APPROVED ECO.
create or replace function public.new_bom_revision(p_bom_id uuid, p_eco_id uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.boms; e public.ecos; v_new uuid; v_rev int; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if not app.can('bom', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into b from public.boms where id = p_bom_id;
  if not found then raise exception 'BOM not found' using errcode = 'P0001'; end if;
  if b.status <> 'approved' then
    raise exception 'Only an approved BOM can be revised (current status: %)', b.status using errcode = 'P0001';
  end if;
  if p_eco_id is null then
    raise exception 'An approved ECO is required to revise an approved BOM' using errcode = 'P0001';
  end if;
  select * into e from public.ecos where id = p_eco_id;
  if not found or e.status <> 'approved' then
    raise exception 'The ECO must be approved before the BOM can be revised' using errcode = 'P0001';
  end if;
  if e.project_id <> b.project_id or (e.bom_id is not null and e.bom_id <> b.id) then
    raise exception 'The ECO does not belong to this BOM/project' using errcode = 'P0001';
  end if;

  select max(rev_no) + 1 into v_rev from public.boms where project_id = b.project_id and name = b.name;
  insert into public.boms(project_id, name, rev_no, status, based_on_id, eco_id, notes)
  values (b.project_id, b.name, v_rev, 'draft', b.id, e.id, 'Created from ' || e.doc_no)
  returning id into v_new;

  insert into public.bom_lines(bom_id, line_no, item_id, description, manufacturer, mpn, qty, uom, position,
                               discipline, make_or_buy, notes)
  select v_new, line_no, item_id, description, manufacturer, mpn, qty, uom, position, discipline, make_or_buy, notes
    from public.bom_lines where bom_id = b.id order by line_no;

  perform set_config('app.ctx', 'system', true);
  update public.ecos set status = 'implemented', implemented_bom_id = v_new, bom_id = b.id where id = e.id;
  perform set_config('app.ctx', v_prev, true);
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Purchase requests
-- ---------------------------------------------------------------------------
create table public.purchase_requests (
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null unique,
  project_id    uuid references public.projects(id),
  bom_id        uuid references public.boms(id),
  title         text,
  requested_by  uuid references public.profiles(id) default auth.uid(),
  needed_by     date,
  priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status        text not null default 'draft'
                check (status in ('draft','pending_approval','approved','rejected','partially_ordered','ordered','closed','cancelled')),
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.purchase_requests', 'purchase_request');

create table public.pr_lines (
  id            uuid primary key default gen_random_uuid(),
  pr_id         uuid not null references public.purchase_requests(id) on delete cascade,
  line_no       int not null default 0,
  bom_line_id   uuid references public.bom_lines(id),
  item_id       uuid references public.items(id),
  description   text not null default '',
  qty           numeric(18,4) not null check (qty > 0),
  uom           text not null default 'pcs',
  needed_by     date,
  ordered_qty   numeric(18,4) not null default 0,
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index pr_lines_pr_idx on public.pr_lines(pr_id);
create index pr_lines_bom_line_idx on public.pr_lines(bom_line_id);
select app.attach_std('public.pr_lines');
create trigger pr_lines_no before insert on public.pr_lines
  for each row execute function app.trg_line_no('pr_id');

-- Read-only inheritance from the approved BOM line
create or replace function app.trg_pr_line_inherit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare bl record; pr public.purchase_requests; v_used numeric;
begin
  if tg_op = 'INSERT' then
    new.ordered_qty := 0;
  elsif coalesce(current_setting('app.ctx', true), '') <> 'system' then
    new.ordered_qty := old.ordered_qty;
  end if;
  if coalesce(current_setting('app.ctx', true), '') = 'system' and tg_op = 'UPDATE' then
    return new;   -- system refresh of ordered_qty
  end if;

  select * into pr from public.purchase_requests where id = new.pr_id;
  if new.bom_line_id is null then
    if new.item_id is not null and coalesce(new.description, '') = '' then
      select name into new.description from public.items where id = new.item_id;
    end if;
    if coalesce(new.description, '') = '' then
      raise exception 'Description is required' using errcode = 'P0001';
    end if;
    return new;
  end if;

  select l.*, b.status as bom_status, b.project_id as bom_project_id, b.id as bom_id_
    into bl
    from public.bom_lines l join public.boms b on b.id = l.bom_id where l.id = new.bom_line_id;
  if not found then raise exception 'BOM line not found' using errcode = 'P0001'; end if;
  if bl.bom_status <> 'approved' then
    raise exception 'Only lines of an approved BOM can be requested' using errcode = 'P0001';
  end if;
  if pr.project_id is not null and pr.project_id <> bl.bom_project_id then
    raise exception 'BOM line belongs to another project' using errcode = 'P0001';
  end if;

  new.item_id := bl.item_id;
  new.description := bl.description;
  new.uom := bl.uom;

  select coalesce(sum(l.qty), 0) into v_used
    from public.pr_lines l join public.purchase_requests r on r.id = l.pr_id
   where l.bom_line_id = new.bom_line_id and l.id <> new.id and r.status not in ('rejected','cancelled');
  if v_used + new.qty > bl.qty then
    raise exception 'Requested qty (% + %) exceeds BOM qty % for "%"', v_used, new.qty, bl.qty, bl.description
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger pr_lines_inherit before insert or update on public.pr_lines
  for each row execute function app.trg_pr_line_inherit();

create or replace function public.create_pr_from_bom(p_bom_id uuid, p_needed_by date default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.boms; v_pr uuid; n int;
begin
  if not app.can('pr', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into b from public.boms where id = p_bom_id;
  if not found or b.status <> 'approved' then
    raise exception 'The BOM must be approved' using errcode = 'P0001';
  end if;
  insert into public.purchase_requests(project_id, bom_id, title, needed_by)
  values (b.project_id, b.id, b.name || ' rev ' || b.revision, p_needed_by)
  returning id into v_pr;

  insert into public.pr_lines(pr_id, line_no, bom_line_id, qty, needed_by)
  select v_pr, l.line_no, l.id, l.qty - coalesce(u.used, 0), p_needed_by
    from public.bom_lines l
    left join lateral (
      select sum(pl.qty) used from public.pr_lines pl join public.purchase_requests r on r.id = pl.pr_id
       where pl.bom_line_id = l.id and r.status not in ('rejected','cancelled')) u on true
   where l.bom_id = b.id and l.make_or_buy = 'buy' and l.qty - coalesce(u.used, 0) > 0
   order by l.line_no;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'Nothing left to request: every BOM line is already covered' using errcode = 'P0001';
  end if;
  return v_pr;
end $$;

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------
create table public.purchase_orders (
  id                uuid primary key default gen_random_uuid(),
  doc_no            text not null unique,
  vendor_id         uuid not null references public.partners(id),
  project_id        uuid references public.projects(id),
  order_date        date not null default current_date,
  promised_date     date,
  currency_code     char(3) not null references public.currencies(code),
  exchange_rate     numeric(18,6) check (exchange_rate > 0),
  incoterm          text,
  payment_terms     text,
  delivery_address  text,
  vendor_ref        text,
  buyer_id          uuid references public.profiles(id) default auth.uid(),
  status            text not null default 'draft'
                    check (status in ('draft','pending_approval','approved','rejected','ordered','partially_received','received','closed','cancelled')),
  notes             text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index purchase_orders_vendor_idx on public.purchase_orders(vendor_id, order_date);
select app.attach_std('public.purchase_orders', 'purchase_order');
create trigger purchase_orders_rate before insert or update on public.purchase_orders
  for each row execute function app.trg_fill_rate();
create trigger purchase_orders_vendor_chk before insert or update of vendor_id on public.purchase_orders
  for each row execute function app.trg_check_partner_role('vendor_id', 'is_vendor');

create table public.po_lines (
  id              uuid primary key default gen_random_uuid(),
  po_id           uuid not null references public.purchase_orders(id) on delete cascade,
  line_no         int not null default 0,
  pr_line_id      uuid references public.pr_lines(id),
  item_id         uuid references public.items(id),
  project_id      uuid references public.projects(id),
  description     text not null default '',
  qty             numeric(18,4) not null check (qty > 0),
  uom             text not null default 'pcs',
  unit_price      numeric(18,4) not null default 0 check (unit_price >= 0),
  discount_pct    numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  tax_code        text references public.tax_codes(code),
  promised_date   date,
  received_qty    numeric(18,4) not null default 0,
  notes           text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index po_lines_po_idx on public.po_lines(po_id);
create index po_lines_pr_line_idx on public.po_lines(pr_line_id);
create index po_lines_item_idx on public.po_lines(item_id);
select app.attach_std('public.po_lines');
create trigger po_lines_no before insert on public.po_lines
  for each row execute function app.trg_line_no('po_id');

create or replace function app.trg_po_line_inherit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare prl record; po public.purchase_orders; v_used numeric;
begin
  if coalesce(current_setting('app.ctx', true), '') = 'system' then return new; end if;
  if tg_op = 'INSERT' then new.received_qty := 0;
  else new.received_qty := old.received_qty; end if;

  select * into po from public.purchase_orders where id = new.po_id;
  new.project_id := coalesce(new.project_id, po.project_id);
  new.promised_date := coalesce(new.promised_date, po.promised_date);

  if new.pr_line_id is null then
    if new.item_id is not null and coalesce(new.description, '') = '' then
      select name into new.description from public.items where id = new.item_id;
    end if;
    if coalesce(new.description, '') = '' then
      raise exception 'Description is required' using errcode = 'P0001';
    end if;
    return new;
  end if;

  select l.*, r.status as pr_status, r.project_id as pr_project_id into prl
    from public.pr_lines l join public.purchase_requests r on r.id = l.pr_id where l.id = new.pr_line_id;
  if not found then raise exception 'PR line not found' using errcode = 'P0001'; end if;
  if prl.pr_status not in ('approved','partially_ordered','ordered') then
    raise exception 'Only lines of an approved PR can be ordered' using errcode = 'P0001';
  end if;
  new.item_id := prl.item_id;
  new.description := prl.description;
  new.uom := prl.uom;
  new.project_id := coalesce(prl.pr_project_id, new.project_id);

  select coalesce(sum(l.qty), 0) into v_used
    from public.po_lines l join public.purchase_orders o on o.id = l.po_id
   where l.pr_line_id = new.pr_line_id and l.id <> new.id and o.status not in ('rejected','cancelled');
  if v_used + new.qty > prl.qty then
    raise exception 'Ordered qty (% + %) exceeds requested qty % for "%"', v_used, new.qty, prl.qty, prl.description
      using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger po_lines_inherit before insert or update on public.po_lines
  for each row execute function app.trg_po_line_inherit();

-- Recompute ordered qty on PR lines and PR status
create or replace function app.refresh_pr(p_pr_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status text; v_total int; v_full int; v_any int; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if p_pr_id is null then return; end if;
  perform set_config('app.ctx', 'system', true);
  update public.pr_lines pl
     set ordered_qty = coalesce((select sum(l.qty) from public.po_lines l join public.purchase_orders o on o.id = l.po_id
                                  where l.pr_line_id = pl.id and o.status not in ('rejected','cancelled','draft','pending_approval')), 0)
   where pl.pr_id = p_pr_id;
  select status into v_status from public.purchase_requests where id = p_pr_id;
  if v_status in ('approved','partially_ordered','ordered') then
    select count(*), count(*) filter (where ordered_qty >= qty), count(*) filter (where ordered_qty > 0)
      into v_total, v_full, v_any from public.pr_lines where pr_id = p_pr_id;
    update public.purchase_requests
       set status = case when v_total > 0 and v_full = v_total then 'ordered'
                         when v_any > 0 then 'partially_ordered' else 'approved' end
     where id = p_pr_id;
  end if;
  perform set_config('app.ctx', v_prev, true);
end $$;

create or replace function app.trg_po_refresh_pr() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  if tg_table_name = 'purchase_orders' then
    for r in select distinct pl.pr_id from public.po_lines l join public.pr_lines pl on pl.id = l.pr_line_id
              where l.po_id = new.id loop
      perform app.refresh_pr(r.pr_id);
    end loop;
  else
    if tg_op <> 'DELETE' and new.pr_line_id is not null then
      perform app.refresh_pr((select pr_id from public.pr_lines where id = new.pr_line_id));
    end if;
    if tg_op <> 'INSERT' and old.pr_line_id is not null then
      perform app.refresh_pr((select pr_id from public.pr_lines where id = old.pr_line_id));
    end if;
  end if;
  return null;
end $$;
create trigger po_lines_refresh_pr after insert or update or delete on public.po_lines
  for each row execute function app.trg_po_refresh_pr();
create trigger purchase_orders_refresh_pr after update of status on public.purchase_orders
  for each row when (old.status is distinct from new.status) execute function app.trg_po_refresh_pr();
