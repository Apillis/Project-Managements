-- =============================================================================
-- 0011 (v1.1) BOM improvements, derived from the analysis of the Excel BOM
-- workbook in use (AZTAKD610 – Structure BOM / Flat BOM / Ecount item data):
--   * units of measure master + conversions (no more "ea" / "EA" / "0")
--   * items: ERP (Ecount) code, part type, procurement type, MOQ, drawing
--   * customer part numbers / revisions per customer
--   * multi-level BOM (parent line, level, find number, build quantity) —
--     Structure BOM and Flat BOM become two views of the same data
--   * net requirement: required − already requested − free stock, MOQ rounding,
--     optional stock reservation for the project
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Units of measure
-- ---------------------------------------------------------------------------
create table public.uoms (
  id          uuid not null default gen_random_uuid() unique,
  code        text primary key check (code ~ '^[A-Z0-9_]{1,10}$'),
  name_en     text not null,
  name_vi     text not null,
  category    text not null default 'count' check (category in ('count','length','mass','volume','area','time','other')),
  is_active   boolean not null default true
);

insert into public.uoms(code, name_en, name_vi, category) values
  ('EA',   'Each',      'Cái',         'count'),
  ('PCS',  'Pieces',    'Chiếc',       'count'),
  ('SET',  'Set',       'Bộ',          'count'),
  ('PAIR', 'Pair',      'Đôi',         'count'),
  ('BOX',  'Box',       'Hộp',         'count'),
  ('PACK', 'Pack',      'Gói',         'count'),
  ('ROLL', 'Roll',      'Cuộn',        'count'),
  ('LOT',  'Lot',       'Lô',          'count'),
  ('M',    'Metre',     'Mét',         'length'),
  ('MM',   'Millimetre','Milimét',     'length'),
  ('CM',   'Centimetre','Centimét',    'length'),
  ('FT',   'Foot',      'Feet',        'length'),
  ('KG',   'Kilogram',  'Kilôgam',     'mass'),
  ('G',    'Gram',      'Gam',         'mass'),
  ('L',    'Litre',     'Lít',         'volume'),
  ('ML',   'Millilitre','Mililít',     'volume'),
  ('M2',   'Square metre','Mét vuông', 'area'),
  ('H',    'Hour',      'Giờ',         'time');

create table public.uom_conversions (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid references public.items(id) on delete cascade,   -- null = generic conversion
  from_uom    text not null references public.uoms(code) on update cascade,
  to_uom      text not null references public.uoms(code) on update cascade,
  factor      numeric(18,6) not null check (factor > 0),           -- 1 from_uom = factor × to_uom
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  check (from_uom <> to_uom)
);
create unique index uom_conversions_uk on public.uom_conversions(coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid), from_uom, to_uom);
select app.attach_std('public.uom_conversions');

insert into public.uom_conversions(from_uom, to_uom, factor) values
  ('M', 'MM', 1000), ('M', 'CM', 100), ('FT', 'M', 0.3048), ('KG', 'G', 1000), ('L', 'ML', 1000);

create or replace function app.norm_uom(p text) returns text
language sql immutable as $$
  select case
    when p is null or btrim(p) in ('', '0', '-') then null
    when upper(btrim(p)) in ('EACH', 'CÁI', 'CAI') then 'EA'
    when upper(btrim(p)) in ('PC', 'PIECE', 'PIECES', 'CHIẾC', 'CHIEC') then 'PCS'
    when upper(btrim(p)) in ('METER', 'METRE', 'MET', 'MÉT') then 'M'
    when upper(btrim(p)) in ('FEET', 'FOOT') then 'FT'
    when upper(btrim(p)) in ('BỘ', 'BO', 'SETS') then 'SET'
    else upper(btrim(p)) end
$$;

-- Convert a quantity between units (item-specific first, then generic, then inverse)
create or replace function app.convert_qty(p_item uuid, p_qty numeric, p_from text, p_to text) returns numeric
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f numeric;
begin
  if p_from = p_to or p_qty is null then return p_qty; end if;
  select factor into f from public.uom_conversions where from_uom = p_from and to_uom = p_to
     and (item_id = p_item or item_id is null) order by item_id nulls last limit 1;
  if f is not null then return p_qty * f; end if;
  select factor into f from public.uom_conversions where from_uom = p_to and to_uom = p_from
     and (item_id = p_item or item_id is null) order by item_id nulls last limit 1;
  if f is not null then return p_qty / f; end if;
  raise exception 'No unit conversion % → %', p_from, p_to using errcode = 'P0001';
end $$;

-- normalise existing data, register unknown units, then enforce the master
do $$
declare t text; c text;
begin
  for t, c in select * from (values ('items','uom'), ('bom_lines','uom'), ('pr_lines','uom'), ('po_lines','uom'),
                                     ('quotation_lines','uom'), ('sales_order_lines','uom')) v(t, c) loop
    execute format('alter table public.%I alter column %I drop default', t, c);
    execute format('alter table public.%I alter column %I drop not null', t, c);
    execute format('update public.%I set %I = coalesce(app.norm_uom(%I), ''EA'')', t, c, c);
    execute format('insert into public.uoms(code, name_en, name_vi) select distinct %I, %I, %I from public.%I
                    where %I is not null on conflict do nothing', c, c, c, t, c);
  end loop;
end $$;

create or replace function app.trg_norm_uom() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item uuid := (to_jsonb(new) ->> 'item_id')::uuid;
begin
  new.uom := app.norm_uom(new.uom);
  if new.uom is null and v_item is not null and tg_table_name <> 'items' then
    select uom into new.uom from public.items where id = v_item;
  end if;
  new.uom := coalesce(new.uom, tg_argv[0]);
  if not exists (select 1 from public.uoms where code = new.uom and is_active) then
    raise exception 'Unknown unit of measure "%". Add it in Settings → Units first.', new.uom using errcode = 'P0001';
  end if;
  return new;
end $$;

do $$
declare t text; d text;
begin
  for t, d in select * from (values ('items','EA'), ('bom_lines','EA'), ('pr_lines','EA'), ('po_lines','EA'),
                                     ('quotation_lines','SET'), ('sales_order_lines','SET')) v(t, d) loop
    execute format('alter table public.%I alter column uom set not null', t);
    execute format('alter table public.%I add constraint %I foreign key (uom) references public.uoms(code) on update cascade',
                   t, t || '_uom_fk');
    -- "zz" so that it runs after the other BEFORE triggers that copy the unit from the item / BOM / PR line
    execute format('create trigger %I before insert or update of %s on public.%I for each row execute function app.trg_norm_uom(%L)',
                   t || '_zz_uom', case when t = 'items' then 'uom' else 'uom, item_id' end, t, d);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Items: ERP code, part / procurement type, MOQ, drawing
-- ---------------------------------------------------------------------------
alter table public.items
  add column erp_code          text unique,
  add column part_type         text not null default 'oem'
    check (part_type in ('oem','fabricated','cable_assy','pcba','sub_assembly','raw_material','sub_material',
                         'consumable','finished_goods','service','intangible')),
  add column procurement_type  text not null default 'buy'
    check (procurement_type in ('buy','make','stock','customer_supplied','subcontract')),
  add column moq               numeric(18,4) not null default 0 check (moq >= 0),
  add column order_multiple    numeric(18,4) not null default 0 check (order_multiple >= 0),
  add column drawing_document_id uuid references public.documents(id) on delete set null,
  add column drawing_url       text;

create or replace function app.trg_item_erp() returns trigger
language plpgsql as $$
begin
  new.erp_code := nullif(btrim(new.erp_code), '');
  if new.erp_code in ('0') then new.erp_code := null; end if;
  new.mpn := nullif(btrim(new.mpn), '');
  if new.mpn = '0' then new.mpn := null; end if;
  return new;
end $$;
create trigger items_erp before insert or update on public.items
  for each row execute function app.trg_item_erp();

-- Customer part numbers / revisions (one item can be sold to several customers)
create table public.item_customer_refs (
  id                uuid primary key default gen_random_uuid(),
  item_id           uuid not null references public.items(id) on delete cascade,
  customer_id       uuid not null references public.partners(id) on delete cascade,
  customer_part_no  text not null check (btrim(customer_part_no) <> ''),
  customer_rev      text,
  description       text,
  is_current        boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create unique index item_customer_refs_uk on public.item_customer_refs(customer_id, customer_part_no, coalesce(customer_rev, ''));
create index item_customer_refs_item_idx on public.item_customer_refs(item_id);
select app.attach_std('public.item_customer_refs');

-- Vendor / customer contacts (RFQ recipients)
create table public.partner_contacts (
  id            uuid primary key default gen_random_uuid(),
  partner_id    uuid not null references public.partners(id) on delete cascade,
  name          text not null,
  email         text,
  phone         text,
  role          text,
  is_rfq_default boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index partner_contacts_partner_idx on public.partner_contacts(partner_id);
select app.attach_std('public.partner_contacts');

-- ---------------------------------------------------------------------------
-- Multi-level BOM
-- ---------------------------------------------------------------------------
alter table public.boms
  add column build_qty         numeric(18,4) not null default 1 check (build_qty > 0),
  add column top_item_id       uuid references public.items(id),
  add column customer_part_no  text,
  add column customer_rev      text,
  add column build_location    text not null default 'VN' check (build_location in ('VN','US','OTHER'));

alter table public.bom_lines drop constraint bom_lines_make_or_buy_check;
alter table public.bom_lines
  add constraint bom_lines_make_or_buy_check
    check (make_or_buy in ('buy','make','stock','customer_supplied','subcontract')),
  add column parent_line_id      uuid references public.bom_lines(id) on delete cascade,
  add column level               smallint not null default 1,
  add column find_no             text,
  add column customer_part_no    text,
  add column customer_rev        text,
  add column part_type           text,
  add column drawing_document_id uuid references public.documents(id) on delete set null,
  add column drawing_url         text;
create index bom_lines_parent_idx on public.bom_lines(parent_line_id);

-- item data + customer reference into the line (only where the user left it empty)
create or replace function app.trg_bom_line_item() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.items; v_customer uuid; r record;
begin
  if new.item_id is null then return new; end if;
  select * into i from public.items where id = new.item_id;
  if coalesce(new.description, '') = '' then new.description := i.name; end if;
  new.manufacturer := coalesce(nullif(new.manufacturer, ''), i.manufacturer);
  new.mpn := coalesce(nullif(new.mpn, ''), i.mpn);
  if new.uom is null then new.uom := i.uom; end if;
  new.part_type := coalesce(new.part_type, i.part_type);
  if tg_op = 'INSERT' and new.make_or_buy = 'buy' and i.procurement_type <> 'buy' then
    new.make_or_buy := i.procurement_type;
  end if;
  new.drawing_document_id := coalesce(new.drawing_document_id, i.drawing_document_id);
  new.drawing_url := coalesce(nullif(new.drawing_url, ''), i.drawing_url);
  if coalesce(new.customer_part_no, '') = '' then
    select p.customer_id into v_customer from public.boms b join public.projects p on p.id = b.project_id where b.id = new.bom_id;
    select customer_part_no, customer_rev into r from public.item_customer_refs
     where item_id = i.id and customer_id = v_customer and is_current order by updated_at desc limit 1;
    if found then new.customer_part_no := r.customer_part_no; new.customer_rev := coalesce(new.customer_rev, r.customer_rev); end if;
  end if;
  return new;
end $$;

create or replace function app.trg_bom_line_level() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare p record;
begin
  if new.parent_line_id is null then
    new.level := 1;
    return new;
  end if;
  if new.parent_line_id = new.id then
    raise exception 'A BOM line cannot be its own parent' using errcode = 'P0001';
  end if;
  select bom_id, level into p from public.bom_lines where id = new.parent_line_id;
  if not found then raise exception 'Parent BOM line not found' using errcode = 'P0001'; end if;
  if p.bom_id <> new.bom_id then
    raise exception 'The parent line belongs to another BOM' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and exists (
      with recursive sub as (
        select id from public.bom_lines where id = new.id
        union all select l.id from public.bom_lines l join sub on l.parent_line_id = sub.id)
      select 1 from sub where id = new.parent_line_id) then
    raise exception 'A BOM line cannot be moved under itself or its children' using errcode = 'P0001';
  end if;
  new.level := p.level + 1;
  if new.level > 9 then raise exception 'BOM depth is limited to 9 levels' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger bom_lines_level before insert or update of parent_line_id on public.bom_lines
  for each row execute function app.trg_bom_line_level();

create or replace function app.trg_bom_line_relevel() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.bom_lines set parent_line_id = parent_line_id where parent_line_id = new.id;
  return null;
end $$;
create trigger bom_lines_relevel after update on public.bom_lines
  for each row when (old.level is distinct from new.level) execute function app.trg_bom_line_relevel();

-- Required quantity of a line for the whole build: qty × parents' qty × build qty
create or replace function app.bom_line_required(p_line uuid) returns numeric
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_qty numeric; v_parent uuid; v_bom uuid; v_pq numeric; v_build numeric;
begin
  select qty, parent_line_id, bom_id into v_qty, v_parent, v_bom from public.bom_lines where id = p_line;
  if v_qty is null then return null; end if;
  while v_parent is not null loop
    select qty, parent_line_id into v_pq, v_parent from public.bom_lines where id = v_parent;
    v_qty := v_qty * v_pq;
  end loop;
  select build_qty into v_build from public.boms where id = v_bom;
  return v_qty * coalesce(v_build, 1);
end $$;

-- a line is purchased when it is buy/subcontract and no ancestor is already bought as a whole
create or replace function app.bom_line_purchasable(p_line uuid) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_mob text; v_parent uuid; v_pmob text;
begin
  select make_or_buy, parent_line_id into v_mob, v_parent from public.bom_lines where id = p_line;
  if v_mob not in ('buy','subcontract') then return false; end if;
  while v_parent is not null loop
    select make_or_buy, parent_line_id into v_pmob, v_parent from public.bom_lines where id = v_parent;
    if v_pmob in ('buy','subcontract') then return false; end if;
  end loop;
  return true;
end $$;

-- new revision keeps the tree and the header data
create or replace function public.new_bom_revision(p_bom_id uuid, p_eco_id uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.boms; e public.ecos; v_new uuid; v_rev int; v_prev text := coalesce(current_setting('app.ctx', true), '');
  r record;
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
  insert into public.boms(project_id, name, rev_no, status, based_on_id, eco_id, notes, build_qty, top_item_id,
                          customer_part_no, customer_rev, build_location)
  values (b.project_id, b.name, v_rev, 'draft', b.id, e.id, 'Created from ' || e.doc_no, b.build_qty, b.top_item_id,
          b.customer_part_no, b.customer_rev, b.build_location)
  returning id into v_new;

  create temporary table if not exists _bom_map (old_id uuid primary key, new_id uuid) on commit drop;
  delete from _bom_map;
  for r in select * from public.bom_lines where bom_id = b.id order by level, line_no loop
    with ins as (
      insert into public.bom_lines(bom_id, parent_line_id, line_no, item_id, description, manufacturer, mpn, qty, uom, position,
                                   discipline, make_or_buy, notes, find_no, customer_part_no, customer_rev, part_type,
                                   drawing_document_id, drawing_url)
      values (v_new, (select new_id from _bom_map where old_id = r.parent_line_id), r.line_no, r.item_id, r.description,
              r.manufacturer, r.mpn, r.qty, r.uom, r.position, r.discipline, r.make_or_buy, r.notes, r.find_no,
              r.customer_part_no, r.customer_rev, r.part_type, r.drawing_document_id, r.drawing_url)
      returning id)
    insert into _bom_map select r.id, ins.id from ins;
  end loop;

  perform set_config('app.ctx', 'system', true);
  update public.ecos set status = 'implemented', implemented_bom_id = v_new, bom_id = b.id where id = e.id;
  perform set_config('app.ctx', v_prev, true);
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- PR lines: cap = required qty of the whole build; MOQ extra quantity
-- ---------------------------------------------------------------------------
alter table public.pr_lines add column moq_qty numeric(18,4) not null default 0 check (moq_qty >= 0);

create or replace function app.trg_pr_line_inherit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare bl record; pr public.purchase_requests; v_used numeric; v_req numeric;
begin
  if tg_op = 'INSERT' then
    new.ordered_qty := 0;
  elsif coalesce(current_setting('app.ctx', true), '') <> 'system' then
    new.ordered_qty := old.ordered_qty;
  end if;
  if coalesce(current_setting('app.ctx', true), '') = 'system' and tg_op = 'UPDATE' then
    return new;
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

  select l.*, b.status as bom_status, b.project_id as bom_project_id into bl
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

  v_req := app.bom_line_required(new.bom_line_id);
  v_used := app.bom_line_covered(new.bom_line_id, new.id);
  if v_used + new.qty > v_req then
    raise exception 'Requested qty (% + %) exceeds BOM qty % for "%"', v_used, new.qty, v_req, bl.description
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- PO line cap includes the MOQ extra of the PR line
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
  if v_used + new.qty > prl.qty + prl.moq_qty then
    raise exception 'Ordered qty (% + %) exceeds requested qty % (+ MOQ %) for "%"', v_used, new.qty, prl.qty, prl.moq_qty, prl.description
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- free (not reserved) stock of an item in all locations
create or replace function app.free_stock(p_item uuid) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(q), 0) from (
    select qty q from public.stock_moves where item_id = p_item and to_location_id is not null and coalesce(to_project_id, project_id) is null
    union all
    select -qty from public.stock_moves where item_id = p_item and from_location_id is not null and project_id is null) t
$$;

-- Suggested purchase quantity: at least the MOQ, rounded up to the order multiple
create or replace function app.round_order_qty(p_need numeric, p_moq numeric, p_multiple numeric) returns numeric
language sql immutable as $$
  select case when coalesce(p_need, 0) <= 0 then 0 else
    case when coalesce(p_multiple, 0) > 0
         then ceil(greatest(p_need, coalesce(p_moq, 0)) / p_multiple) * p_multiple
         else greatest(p_need, coalesce(p_moq, 0)) end end
$$;

-- stock reserved for a BOM line (counts as covered, like a PR line)
create table public.bom_reservations (
  id            uuid primary key default gen_random_uuid(),
  bom_line_id   uuid not null references public.bom_lines(id) on delete cascade,
  stock_move_id uuid references public.stock_moves(id),
  qty           numeric(18,4) not null check (qty > 0),
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id) default auth.uid()
);
create index bom_reservations_line_idx on public.bom_reservations(bom_line_id);

create or replace function app.bom_line_covered(p_line uuid, p_exclude_pr_line uuid default null) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select sum(pl.qty) from public.pr_lines pl join public.purchase_requests r on r.id = pl.pr_id
                    where pl.bom_line_id = p_line and r.status not in ('rejected','cancelled')
                      and pl.id is distinct from p_exclude_pr_line), 0)
       + coalesce((select sum(qty) from public.bom_reservations where bom_line_id = p_line), 0)
$$;

drop function public.create_pr_from_bom(uuid, date);
create or replace function public.create_pr_from_bom(p_bom_id uuid, p_needed_by date default null,
                                                     p_use_stock boolean default false, p_reserve boolean default false)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.boms; v_pr uuid; r record; v_free numeric; v_cover numeric; v_net numeric; v_order numeric;
  v_left numeric; loc record; v_take numeric; i public.items; v_move uuid;
begin
  if not app.can('pr', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_reserve and not app.can('warehouse', 'write') then
    raise exception 'Reserving stock needs warehouse write permission' using errcode = '42501';
  end if;
  select * into b from public.boms where id = p_bom_id;
  if not found or b.status <> 'approved' then
    raise exception 'The BOM must be approved' using errcode = 'P0001';
  end if;

  create temporary table if not exists _alloc (item_id uuid primary key, used numeric) on commit drop;
  delete from _alloc;

  for r in
    select l.id, l.line_no, l.item_id, app.bom_line_required(l.id) as req, app.bom_line_covered(l.id) as requested
      from public.bom_lines l
     where l.bom_id = b.id and app.bom_line_purchasable(l.id)
     order by l.level, l.line_no
  loop
    v_net := r.req - r.requested;
    continue when v_net <= 0;
    v_cover := 0;
    if (p_use_stock or p_reserve) and r.item_id is not null then
      select * into i from public.items where id = r.item_id;
      v_free := app.free_stock(r.item_id) - coalesce((select used from _alloc where item_id = r.item_id), 0);
      v_cover := least(v_net, greatest(v_free, 0));
      if p_reserve and v_cover > 0 and not i.track_lot and not i.track_serial then
        v_left := v_cover;
        for loc in
          select location_id, sum(q) qty from (
            select to_location_id location_id, qty q from public.stock_moves where item_id = r.item_id and to_location_id is not null and coalesce(to_project_id, project_id) is null
            union all
            select from_location_id, -qty from public.stock_moves where item_id = r.item_id and from_location_id is not null and project_id is null) s
          group by location_id having sum(q) > 0 order by sum(q) desc
        loop
          exit when v_left <= 0;
          v_take := least(v_left, loc.qty);
          insert into public.stock_moves(move_type, item_id, qty, from_location_id, to_location_id, to_project_id, reference, notes)
          values ('transfer', r.item_id, v_take, loc.location_id, loc.location_id, b.project_id,
                  'BOM ' || b.name || ' rev ' || b.revision, 'Reserved for project from free stock')
          returning id into v_move;
          insert into public.bom_reservations(bom_line_id, stock_move_id, qty) values (r.id, v_move, v_take);
          v_left := v_left - v_take;
        end loop;
        v_cover := v_cover - greatest(v_left, 0);
      elsif p_reserve and (i.track_lot or i.track_serial) then
        v_cover := 0;   -- lot/serial items are reserved manually (pick the lot)
      end if;
      insert into _alloc values (r.item_id, v_cover) on conflict (item_id) do update set used = _alloc.used + excluded.used;
    end if;
    -- stock covering part of the need is counted as "requested" only when it is reserved
    v_net := v_net - v_cover;
    continue when v_net <= 0;
    select * into i from public.items where id = r.item_id;
    v_order := app.round_order_qty(v_net, i.moq, i.order_multiple);
    if v_pr is null then
      insert into public.purchase_requests(project_id, bom_id, title, needed_by)
      values (b.project_id, b.id, b.name || ' rev ' || b.revision, p_needed_by) returning id into v_pr;
    end if;
    insert into public.pr_lines(pr_id, line_no, bom_line_id, qty, moq_qty, needed_by)
    values (v_pr, r.line_no, r.id, v_net, greatest(v_order - v_net, 0), p_needed_by);
  end loop;

  if v_pr is null and not p_reserve then
    raise exception 'Nothing left to request: every BOM line is already covered' using errcode = 'P0001';
  end if;
  return v_pr;
end $$;

-- ---------------------------------------------------------------------------
-- Views: structure BOM (tree), flat BOM, net requirement
-- ---------------------------------------------------------------------------
create view public.v_bom_tree with (security_invoker = on) as
with recursive t as (
  select l.id, l.bom_id, l.parent_line_id, l.line_no, l.level, l.qty::numeric as per_unit_qty,
         lpad(l.line_no::text, 6, '0') as sort_path, (l.make_or_buy in ('buy','subcontract')) as bought_branch,
         false as under_bought
    from public.bom_lines l where l.parent_line_id is null
  union all
  select c.id, c.bom_id, c.parent_line_id, c.line_no, c.level, (c.qty * t.per_unit_qty)::numeric,
         t.sort_path || '.' || lpad(c.line_no::text, 6, '0'),
         t.bought_branch or c.make_or_buy in ('buy','subcontract'), t.bought_branch
    from public.bom_lines c join t on c.parent_line_id = t.id)
select l.id, l.bom_id, b.project_id, p.code as project_code, b.name as bom_name, b.revision, b.status as bom_status,
       b.build_qty, t.sort_path, l.level, l.parent_line_id, l.line_no, l.find_no,
       l.customer_part_no, l.customer_rev, l.item_id, i.sku, i.erp_code, l.description, l.manufacturer, l.mpn,
       l.qty, l.uom, t.per_unit_qty, t.per_unit_qty * b.build_qty as required_qty,
       coalesce(l.part_type, i.part_type) as part_type, l.make_or_buy, l.discipline, l.position,
       exists (select 1 from public.bom_lines c where c.parent_line_id = l.id) as has_children,
       (l.make_or_buy in ('buy','subcontract') and not t.under_bought) as is_purchasable,
       l.drawing_document_id, l.drawing_url, l.notes
  from t
  join public.bom_lines l on l.id = t.id
  join public.boms b on b.id = l.bom_id
  join public.projects p on p.id = b.project_id
  left join public.items i on i.id = l.item_id;

-- Flat BOM: everything that has to be bought / taken from stock, summed per item
create view public.v_bom_flat with (security_invoker = on) as
select bom_id, project_id, project_code, bom_name, revision, bom_status, build_qty,
       item_id, sku, erp_code, max(customer_part_no) as customer_part_no, max(description) as description,
       max(manufacturer) as manufacturer, max(mpn) as mpn, max(uom) as uom, max(part_type) as part_type,
       string_agg(distinct make_or_buy, ', ') as make_or_buy,
       sum(per_unit_qty) as per_unit_qty, sum(required_qty) as required_qty, count(*) as line_count,
       string_agg(coalesce(find_no, line_no::text), ', ' order by sort_path) as find_nos
  from public.v_bom_tree
 where is_purchasable or (make_or_buy in ('stock','customer_supplied') and not has_children)
 group by bom_id, project_id, project_code, bom_name, revision, bom_status, build_qty, item_id, sku, erp_code,
          case when item_id is null then description end;

create view public.v_bom_net_requirement with (security_invoker = on) as
select t.id as bom_line_id, t.bom_id, t.project_id, t.project_code, t.bom_name, t.revision, t.bom_status,
       t.sort_path, t.level, t.find_no, t.customer_part_no, t.item_id, t.sku, t.erp_code, t.description, t.manufacturer, t.mpn,
       t.uom, t.required_qty,
       coalesce(pr.requested, 0) as requested_qty,
       coalesce(pr.ordered, 0) as ordered_qty,
       coalesce(pr.reserved, 0) as reserved_qty,
       greatest(t.required_qty - coalesce(pr.requested, 0), 0) as remaining_qty,
       case when t.item_id is null then 0 else app.free_stock(t.item_id) end as free_stock,
       case when t.item_id is null then 0 else coalesce((select sum(b.qty) from public.v_stock_balance b
              where b.item_id = t.item_id and b.project_id = t.project_id), 0) end as project_stock,
       greatest(greatest(t.required_qty - coalesce(pr.requested, 0), 0)
                - case when t.item_id is null then 0 else greatest(app.free_stock(t.item_id), 0) end, 0) as net_qty,
       i.moq, i.order_multiple, i.lead_time_days,
       app.round_order_qty(greatest(greatest(t.required_qty - coalesce(pr.requested, 0), 0)
                - case when t.item_id is null then 0 else greatest(app.free_stock(t.item_id), 0) end, 0),
                i.moq, i.order_multiple) as suggested_order_qty
  from public.v_bom_tree t
  left join public.items i on i.id = t.item_id
  left join lateral (
    select app.bom_line_covered(t.id) requested,
           (select sum(pl.ordered_qty) from public.pr_lines pl join public.purchase_requests r on r.id = pl.pr_id
             where pl.bom_line_id = t.id and r.status not in ('rejected','cancelled')) ordered,
           (select sum(qty) from public.bom_reservations where bom_line_id = t.id) reserved) pr on true
 where t.is_purchasable;

drop view public.v_bom_lines;
create view public.v_bom_lines with (security_invoker = on) as
select t.id, t.bom_id, t.project_id, t.project_code, t.bom_name, t.revision, t.bom_status, t.sort_path, t.level,
       t.parent_line_id, t.line_no, t.find_no, t.customer_part_no, t.customer_rev, t.item_id, t.sku, t.erp_code,
       t.description, t.manufacturer, t.mpn, t.qty, t.uom, t.per_unit_qty, t.required_qty, t.part_type, t.position,
       t.discipline, t.make_or_buy, t.has_children, t.is_purchasable, t.drawing_document_id, t.drawing_url, t.notes
  from public.v_bom_tree t;

drop view public.v_boms;
create view public.v_boms with (security_invoker = on) as
select b.id, b.project_id, p.code as project_code, b.name, b.rev_no, b.revision, b.status, b.approved_at,
       b.based_on_id, b.eco_id, e.doc_no as eco_no, b.build_qty, b.build_location, b.top_item_id, ti.sku as top_sku,
       b.customer_part_no, b.customer_rev,
       (select count(*) from public.bom_lines l where l.bom_id = b.id) as line_count,
       b.notes, b.created_at, b.updated_at
  from public.boms b
  join public.projects p on p.id = b.project_id
  left join public.ecos e on e.id = b.eco_id
  left join public.items ti on ti.id = b.top_item_id;

drop view public.v_pr_lines;
create view public.v_pr_lines with (security_invoker = on) as
select l.id, l.pr_id, r.doc_no as pr_no, r.status as pr_status, r.priority, r.needed_by as pr_needed_by,
       r.project_id, p.code as project_code, b.revision as bom_revision,
       l.line_no, l.item_id, i.sku, l.description, l.qty, l.moq_qty, l.uom, l.ordered_qty,
       greatest(l.qty + l.moq_qty - l.ordered_qty, 0) as open_qty, coalesce(l.needed_by, r.needed_by) as needed_by,
       u.full_name as requested_by_name, r.created_at
  from public.pr_lines l
  join public.purchase_requests r on r.id = l.pr_id
  left join public.projects p on p.id = r.project_id
  left join public.boms b on b.id = r.bom_id
  left join public.items i on i.id = l.item_id
  left join public.profiles u on u.id = r.requested_by;

-- BOM vs actual uses the required quantity of the whole build
drop view public.v_bom_vs_actual;
create view public.v_bom_vs_actual with (security_invoker = on) as
with req as (
  select project_id, item_id, max(description) as description, max(uom) as uom, sum(required_qty) as bom_qty
    from public.v_bom_tree
   where bom_status = 'approved' and item_id is not null and (is_purchasable or (make_or_buy = 'stock' and not has_children))
   group by project_id, item_id),
prq as (
  select r.project_id, l.item_id, sum(l.qty) as requested_qty
    from public.pr_lines l join public.purchase_requests r on r.id = l.pr_id
   where r.status not in ('rejected','cancelled','draft') and l.item_id is not null
   group by r.project_id, l.item_id),
poq as (
  select l.project_id, l.item_id, sum(l.qty) as ordered_qty, sum(l.received_qty) as received_qty
    from public.po_lines l join public.purchase_orders o on o.id = l.po_id
   where o.status not in ('rejected','cancelled','draft','pending_approval') and l.item_id is not null
   group by l.project_id, l.item_id),
iss as (
  select consume_project_id as project_id, item_id,
         sum(case when move_type = 'issue' then qty else 0 end) as issued_qty
    from public.stock_moves where consume_project_id is not null
   group by consume_project_id, item_id),
ret as (
  select project_id, item_id, sum(qty) as returned_qty
    from public.stock_moves where move_type = 'return' and project_id is not null
   group by project_id, item_id),
keys as (
  select project_id, item_id from req union select project_id, item_id from prq
  union select project_id, item_id from poq where project_id is not null
  union select project_id, item_id from iss)
select k.project_id, p.code as project_code, k.item_id, i.sku, coalesce(req.description, i.name) as description,
       coalesce(req.uom, i.uom) as uom,
       coalesce(req.bom_qty, 0) as bom_qty,
       coalesce(prq.requested_qty, 0) as requested_qty,
       coalesce(poq.ordered_qty, 0) as ordered_qty,
       coalesce(poq.received_qty, 0) as received_qty,
       coalesce(iss.issued_qty, 0) as issued_qty,
       coalesce(ret.returned_qty, 0) as returned_qty,
       coalesce(iss.issued_qty, 0) - coalesce(ret.returned_qty, 0) as consumed_qty,
       coalesce(iss.issued_qty, 0) - coalesce(ret.returned_qty, 0) - coalesce(req.bom_qty, 0) as variance_qty,
       case when coalesce(req.bom_qty, 0) > 0
            then round((coalesce(iss.issued_qty, 0) - coalesce(ret.returned_qty, 0) - req.bom_qty) / req.bom_qty * 100, 1) end as variance_pct
  from keys k
  join public.projects p on p.id = k.project_id
  join public.items i on i.id = k.item_id
  left join req on req.project_id = k.project_id and req.item_id = k.item_id
  left join prq on prq.project_id = k.project_id and prq.item_id = k.item_id
  left join poq on poq.project_id = k.project_id and poq.item_id = k.item_id
  left join iss on iss.project_id = k.project_id and iss.item_id = k.item_id
  left join ret on ret.project_id = k.project_id and ret.item_id = k.item_id;

-- warehouses carry a site / country (VN Dong An, US Newark …)
alter table public.warehouses add column site text, add column country text;

-- ---------------------------------------------------------------------------
-- Import: BOM tree in one transaction (Structure BOM sheet) and column mapping
-- ---------------------------------------------------------------------------
create table public.import_mappings (
  id          uuid primary key default gen_random_uuid(),
  import_key  text not null,
  field       text not null,
  aliases     text[] not null default '{}',
  sort        int not null default 0,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  unique (import_key, field)
);
select app.attach_std('public.import_mappings');

-- p_lines: [{key, parent_key, level, erp_code, customer_part_no, customer_rev, description, qty, uom, part_type,
--            make_or_buy, manufacturer, mpn, find_no, position, notes, drawing_url,
--            unit_cost, currency, moq, lead_time_days, vendor_name}]
-- level-0 rows describe the top assembly (header); others become lines, parents by key.
create or replace function public.import_bom_tree(p_bom_id uuid, p_lines jsonb, p_create_items boolean default true)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.boms; v_customer uuid; x jsonb; v_item uuid; v_parent uuid; v_line uuid; n int := 0;
  v_vendor uuid; v_sku text; v_uom text;
begin
  if not app.can('bom', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into b from public.boms where id = p_bom_id;
  if not found or b.status not in ('draft','rejected') then
    raise exception 'Import only into a draft BOM' using errcode = 'P0001';
  end if;
  select customer_id into v_customer from public.projects where id = b.project_id;
  create temporary table if not exists _imp_keys (k text primary key, line_id uuid) on commit drop;
  delete from _imp_keys;

  for x in select * from jsonb_array_elements(p_lines) loop
    -- resolve the item: ERP code → manufacturer part number → SKU / customer part number
    v_item := null;
    if coalesce(x->>'erp_code', '') <> '' then
      select id into v_item from public.items where erp_code = x->>'erp_code';
    end if;
    if v_item is null and coalesce(x->>'mpn', '') <> '' then
      select id into v_item from public.items where lower(mpn) = lower(x->>'mpn')
         and (coalesce(x->>'manufacturer', '') = '' or lower(coalesce(manufacturer, '')) = lower(x->>'manufacturer')) limit 1;
    end if;
    if v_item is null and coalesce(x->>'customer_part_no', '') <> '' then
      select id into v_item from public.items where sku = x->>'customer_part_no';
      if v_item is null and v_customer is not null then
        select item_id into v_item from public.item_customer_refs where customer_id = v_customer and customer_part_no = x->>'customer_part_no' limit 1;
      end if;
    end if;
    if v_item is null and p_create_items and coalesce(x->>'description', '') <> '' then
      if not app.can('items', 'write') then raise exception 'Creating items needs item write permission' using errcode = '42501'; end if;
      v_sku := coalesce(nullif(x->>'erp_code', ''), nullif(x->>'customer_part_no', ''), nullif(x->>'mpn', ''),
                        'IMP-' || substr(md5(x::text), 1, 8));
      v_uom := coalesce(app.norm_uom(x->>'uom'), 'EA');
      if not exists (select 1 from public.uoms where code = v_uom) then
        insert into public.uoms(code, name_en, name_vi) values (v_uom, v_uom, v_uom);
      end if;
      insert into public.items(sku, name, erp_code, manufacturer, mpn, uom, part_type, procurement_type, moq, lead_time_days, drawing_url, item_type)
      values (v_sku, x->>'description', nullif(x->>'erp_code', ''), nullif(x->>'manufacturer', ''), nullif(x->>'mpn', ''), v_uom,
              coalesce(nullif(x->>'part_type', ''), 'oem'),
              coalesce(nullif(x->>'make_or_buy', ''), 'buy'),
              coalesce((x->>'moq')::numeric, 0), (x->>'lead_time_days')::int, nullif(x->>'drawing_url', ''),
              case when (x->>'level')::int = 0 or x->>'part_type' in ('cable_assy','sub_assembly','pcba') then 'assembly' else 'part' end)
      on conflict (sku) do update set name = excluded.name
      returning id into v_item;
    end if;
    if v_item is not null and v_customer is not null and coalesce(x->>'customer_part_no', '') <> '' then
      insert into public.item_customer_refs(item_id, customer_id, customer_part_no, customer_rev)
      values (v_item, v_customer, x->>'customer_part_no', nullif(x->>'customer_rev', ''))
      on conflict do nothing;
    end if;
    if v_item is not null and coalesce((x->>'unit_cost')::numeric, 0) > 0 then
      v_vendor := null;
      if coalesce(x->>'vendor_name', '') <> '' then
        select id into v_vendor from public.partners where is_vendor and (lower(name) = lower(x->>'vendor_name') or lower(code) = lower(x->>'vendor_name')) limit 1;
      end if;
      insert into public.item_prices(item_id, vendor_id, unit_price, currency_code, moq, lead_time_days, source, notes)
      values (v_item, v_vendor, (x->>'unit_cost')::numeric, coalesce(nullif(x->>'currency', ''), 'USD'),
              coalesce((x->>'moq')::numeric, 0), (x->>'lead_time_days')::int, 'import', 'BOM import ' || b.name);
    end if;

    if coalesce((x->>'level')::int, 1) = 0 then
      update public.boms set top_item_id = coalesce(v_item, top_item_id),
             customer_part_no = coalesce(nullif(x->>'customer_part_no', ''), customer_part_no),
             customer_rev = coalesce(nullif(x->>'customer_rev', ''), customer_rev)
       where id = b.id;
      continue;
    end if;

    v_parent := null;
    if coalesce(x->>'parent_key', '') <> '' then
      select line_id into v_parent from _imp_keys where k = x->>'parent_key';
    end if;
    insert into public.bom_lines(bom_id, parent_line_id, item_id, description, manufacturer, mpn, qty, uom, position, find_no,
                                 customer_part_no, customer_rev, part_type, make_or_buy, notes, drawing_url)
    values (b.id, v_parent, v_item, coalesce(nullif(x->>'description', ''), ''), nullif(x->>'manufacturer', ''), nullif(x->>'mpn', ''),
            coalesce((x->>'qty')::numeric, 1), app.norm_uom(x->>'uom'), nullif(x->>'position', ''), nullif(x->>'find_no', ''),
            nullif(x->>'customer_part_no', ''), nullif(x->>'customer_rev', ''), nullif(x->>'part_type', ''),
            coalesce(nullif(x->>'make_or_buy', ''), 'buy'), nullif(x->>'notes', ''), nullif(x->>'drawing_url', ''))
    returning id into v_line;
    if coalesce(x->>'key', '') <> '' then
      insert into _imp_keys values (x->>'key', v_line) on conflict (k) do update set line_id = excluded.line_id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
