-- =============================================================================
-- 0002 master data (partners, items, warehouses) and sales (quotation, SO)
-- =============================================================================

create table public.partners (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (btrim(code) <> ''),
  name          text not null check (btrim(name) <> ''),
  is_customer   boolean not null default false,
  is_vendor     boolean not null default false,
  is_carrier    boolean not null default false,
  tax_code      text,
  country       text,
  address       text,
  contact_name  text,
  email         text,
  phone         text,
  website       text,
  currency_code char(3) references public.currencies(code),
  payment_terms text,
  incoterm      text,
  notes         text,
  is_active     boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  check (is_customer or is_vendor or is_carrier)
);
select app.attach_std('public.partners');

create table public.items (
  id                uuid primary key default gen_random_uuid(),
  sku               text not null unique check (btrim(sku) <> ''),
  name              text not null check (btrim(name) <> ''),
  description       text,
  manufacturer      text,
  mpn               text,
  category          text,
  item_type         text not null default 'part'
                    check (item_type in ('part','material','consumable','tool','service','assembly')),
  uom               text not null default 'pcs',
  is_stocked        boolean not null default true,
  track_lot         boolean not null default false,
  track_serial      boolean not null default false,
  min_stock         numeric(18,4) not null default 0 check (min_stock >= 0),
  lead_time_days    int check (lead_time_days >= 0),
  default_vendor_id uuid references public.partners(id),
  country_of_origin text,
  hs_code           text,
  is_active         boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index items_mpn_idx on public.items(mpn);
select app.attach_std('public.items');

create table public.warehouses (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  address     text,
  is_active   boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.warehouses');

create table public.locations (
  id            uuid primary key default gen_random_uuid(),
  warehouse_id  uuid not null references public.warehouses(id) on delete cascade,
  code          text not null,
  name          text,
  is_active     boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  unique (warehouse_id, code)
);
select app.attach_std('public.locations');

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
create table public.quotations (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  customer_id     uuid not null references public.partners(id),
  title           text not null,
  market          text check (market in ('EU','US','CA','VN','ASIA','OTHER')),
  currency_code   char(3) not null references public.currencies(code),
  exchange_rate   numeric(18,6) check (exchange_rate > 0),
  quote_date      date not null default current_date,
  valid_until     date,
  expected_close  date,
  probability     smallint not null default 50 check (probability between 0 and 100),
  incoterm        text,
  payment_terms   text,
  status          text not null default 'draft'
                  check (status in ('draft','pending_approval','approved','rejected','sent','won','lost','cancelled')),
  lost_reason     text,
  sales_owner_id  uuid references public.profiles(id) default auth.uid(),
  notes           text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.quotations', 'quotation');
create trigger quotations_rate before insert or update on public.quotations
  for each row execute function app.trg_fill_rate();

create table public.quotation_lines (
  id            uuid primary key default gen_random_uuid(),
  quotation_id  uuid not null references public.quotations(id) on delete cascade,
  line_no       int not null default 0,
  item_id       uuid references public.items(id),
  description   text not null,
  qty           numeric(18,4) not null check (qty > 0),
  uom           text not null default 'set',
  unit_price    numeric(18,4) not null default 0 check (unit_price >= 0),
  discount_pct  numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  tax_code      text references public.tax_codes(code),
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index quotation_lines_parent_idx on public.quotation_lines(quotation_id);
select app.attach_std('public.quotation_lines');

create table public.sales_orders (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  customer_id     uuid not null references public.partners(id),
  customer_po_no  text,
  quotation_id    uuid references public.quotations(id),
  project_id      uuid,  -- FK added in 0003 (projects)
  order_date      date not null default current_date,
  delivery_date   date,
  incoterm        text,
  payment_terms   text,
  currency_code   char(3) not null references public.currencies(code),
  exchange_rate   numeric(18,6) check (exchange_rate > 0),
  status          text not null default 'draft'
                  check (status in ('draft','pending_approval','approved','rejected','in_progress','delivered','closed','cancelled')),
  notes           text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.sales_orders', 'sales_order');
create trigger sales_orders_rate before insert or update on public.sales_orders
  for each row execute function app.trg_fill_rate();

create table public.sales_order_lines (
  id              uuid primary key default gen_random_uuid(),
  sales_order_id  uuid not null references public.sales_orders(id) on delete cascade,
  line_no         int not null default 0,
  item_id         uuid references public.items(id),
  description     text not null,
  qty             numeric(18,4) not null check (qty > 0),
  uom             text not null default 'set',
  unit_price      numeric(18,4) not null default 0 check (unit_price >= 0),
  discount_pct    numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  tax_code        text references public.tax_codes(code),
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index sales_order_lines_parent_idx on public.sales_order_lines(sales_order_id);
select app.attach_std('public.sales_order_lines');

-- Line net / tax helpers
create or replace function app.line_net(p_qty numeric, p_price numeric, p_disc numeric) returns numeric
language sql immutable as $$ select round(coalesce(p_qty,0) * coalesce(p_price,0) * (1 - coalesce(p_disc,0) / 100.0), 4) $$;

create or replace function app.tax_rate(p_code text) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select rate from public.tax_codes where code = p_code), 0)
$$;

-- Auto line numbering (10, 20, 30 …) when not supplied
create or replace function app.trg_line_no() returns trigger
language plpgsql as $$
declare v_next int;
begin
  if new.line_no is null or new.line_no = 0 then
    execute format('select coalesce(max(line_no), 0) + 10 from %I.%I where %I = $1',
                   tg_table_schema, tg_table_name, tg_argv[0])
      into v_next using (to_jsonb(new) ->> tg_argv[0])::uuid;
    new.line_no := v_next;
  end if;
  return new;
end $$;

create trigger quotation_lines_no before insert on public.quotation_lines
  for each row execute function app.trg_line_no('quotation_id');
create trigger sales_order_lines_no before insert on public.sales_order_lines
  for each row execute function app.trg_line_no('sales_order_id');

-- Partner role checks
create or replace function app.trg_check_partner_role() returns trigger
language plpgsql as $$
declare v_ok boolean; v_col text := tg_argv[0]; v_flag text := tg_argv[1]; v_id uuid;
begin
  v_id := (to_jsonb(new) ->> v_col)::uuid;
  if v_id is null then return new; end if;
  execute format('select %I from public.partners where id = $1', v_flag) into v_ok using v_id;
  if not coalesce(v_ok, false) then
    raise exception 'Partner is not flagged as %', replace(v_flag, 'is_', '') using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger quotations_customer_chk before insert or update of customer_id on public.quotations
  for each row execute function app.trg_check_partner_role('customer_id', 'is_customer');
create trigger sales_orders_customer_chk before insert or update of customer_id on public.sales_orders
  for each row execute function app.trg_check_partner_role('customer_id', 'is_customer');
