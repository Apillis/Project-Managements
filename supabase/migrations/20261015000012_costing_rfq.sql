-- =============================================================================
-- 0012 (v1.1) Costing (price book, cost estimates, labour steps, fees → quote)
-- and RFQ (request for quotation to several vendors, comparison, award → PO).
-- Replaces the "Final cost to quote", "Assy Breakout Cost", "Warning" and
-- "Send RFQ" sheets of the Excel BOM workbook.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Price book: vendor quotes, catalogue / ERP prices, imported prices
-- ---------------------------------------------------------------------------
create table public.item_prices (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references public.items(id) on delete cascade,
  vendor_id       uuid references public.partners(id),
  unit_price      numeric(18,4) not null check (unit_price >= 0),
  currency_code   char(3) not null default 'USD' references public.currencies(code),
  moq             numeric(18,4) not null default 0 check (moq >= 0),
  order_multiple  numeric(18,4) not null default 0 check (order_multiple >= 0),
  lead_time_days  int check (lead_time_days >= 0),
  valid_from      date not null default current_date,
  valid_to        date,
  source          text not null default 'manual' check (source in ('quote','po','erp','catalog','manual','import')),
  rfq_quote_id    uuid,
  notes           text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  check (valid_to is null or valid_to >= valid_from)
);
create index item_prices_item_idx on public.item_prices(item_id, valid_from desc);
select app.attach_std('public.item_prices');

-- Best current price of an item: lowest base-currency price among valid price
-- book entries; falls back to the last PO price.
create or replace function app.best_price(p_item uuid, p_on date default current_date,
  out unit_price numeric, out currency_code text, out vendor_id uuid, out moq numeric, out order_multiple numeric,
  out lead_time_days int, out source text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  select p.unit_price, p.currency_code, p.vendor_id, p.moq, p.order_multiple, p.lead_time_days, p.source
    into unit_price, currency_code, vendor_id, moq, order_multiple, lead_time_days, source
    from public.item_prices p
   where p.item_id = p_item and p.valid_from <= p_on and (p.valid_to is null or p.valid_to >= p_on)
   order by app.to_base_safe(p.unit_price, p.currency_code, null, p_on) asc nulls last, p.valid_from desc, p.created_at desc
   limit 1;
  if found then return; end if;
  select l.unit_price * (1 - l.discount_pct / 100.0), o.currency_code, o.vendor_id, 0, 0,
         (select i.lead_time_days from public.items i where i.id = p_item), 'po'
    into unit_price, currency_code, vendor_id, moq, order_multiple, lead_time_days, source
    from public.po_lines l join public.purchase_orders o on o.id = l.po_id
   where l.item_id = p_item and o.status not in ('draft','pending_approval','rejected','cancelled')
   order by o.order_date desc, o.created_at desc limit 1;
end $$;

create view public.v_item_prices with (security_invoker = on) as
select p.id, p.item_id, i.sku, i.erp_code, i.name as item_name, i.manufacturer, i.mpn, p.vendor_id, v.name as vendor_name,
       p.unit_price, p.currency_code, round(app.to_base_safe(p.unit_price, p.currency_code, null, current_date), 4) as unit_price_base,
       p.moq, p.order_multiple, p.lead_time_days, p.valid_from, p.valid_to,
       (p.valid_from <= current_date and (p.valid_to is null or p.valid_to >= current_date)) as is_valid,
       p.source, p.notes, p.created_at
  from public.item_prices p
  join public.items i on i.id = p.item_id
  left join public.partners v on v.id = p.vendor_id;

-- ---------------------------------------------------------------------------
-- Settings: cost rules (fees) and labour step templates
-- ---------------------------------------------------------------------------
create table public.cost_rules (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name            text not null,
  basis           text not null check (basis in ('per_package','per_unit','fixed','percent_of_material')),
  amount          numeric(18,4) not null check (amount >= 0),
  currency_code   char(3) not null default 'USD' references public.currencies(code),
  part_types      text[],                 -- null = applies to every BOM; else only if the BOM contains one of them
  build_location  text check (build_location in ('VN','US','OTHER')),
  description     text,
  is_active       boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.cost_rules');

create table public.labor_step_templates (
  id            uuid primary key default gen_random_uuid(),
  discipline    text not null check (discipline in ('elec','mech','cable','software','test','other')),
  main_task     text not null,
  step_code     text not null,
  work_step     text not null,
  description   text,
  default_hours numeric(10,2) not null default 0 check (default_hours >= 0),
  sort          int not null default 0,
  is_active     boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  unique (discipline, step_code)
);
select app.attach_std('public.labor_step_templates');

-- ---------------------------------------------------------------------------
-- Cost estimates
-- ---------------------------------------------------------------------------
create table public.cost_estimates (
  id                  uuid primary key default gen_random_uuid(),
  doc_no              text not null unique,
  project_id          uuid references public.projects(id) on delete cascade,
  bom_id              uuid references public.boms(id),
  quotation_id        uuid references public.quotations(id),
  title               text not null,
  build_qty           numeric(18,4) not null default 1 check (build_qty > 0),
  build_location      text not null default 'VN' check (build_location in ('VN','US','OTHER')),
  currency_code       char(3) not null references public.currencies(code),      -- quote currency
  exchange_rate       numeric(18,6) check (exchange_rate > 0),
  markup_material_pct numeric(6,2) not null default 30 check (markup_material_pct >= 0),
  markup_labor_pct    numeric(6,2) not null default 0 check (markup_labor_pct >= 0),
  vat_pct             numeric(6,2) not null default 0 check (vat_pct >= 0),
  logistics_cost      numeric(18,2) not null default 0 check (logistics_cost >= 0),   -- base currency
  shipping_cost       numeric(18,2) not null default 0 check (shipping_cost >= 0),
  packing_cost        numeric(18,2) not null default 0 check (packing_cost >= 0),
  packages_count      int not null default 1 check (packages_count >= 0),
  status              text not null default 'draft'
                      check (status in ('draft','pending_approval','approved','rejected','quoted','cancelled')),
  notes               text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.cost_estimates', 'cost_estimate');
create trigger cost_estimates_rate before insert or update on public.cost_estimates
  for each row execute function app.trg_fill_rate();

create table public.cost_estimate_lines (
  id              uuid primary key default gen_random_uuid(),
  estimate_id     uuid not null references public.cost_estimates(id) on delete cascade,
  line_no         int not null default 0,
  bom_line_id     uuid references public.bom_lines(id) on delete set null,
  item_id         uuid references public.items(id),
  find_no         text,
  customer_part_no text,
  description     text not null,
  manufacturer    text,
  mpn             text,
  uom             text,
  part_type       text,
  per_unit_qty    numeric(18,4) not null default 0 check (per_unit_qty >= 0),
  required_qty    numeric(18,4) not null default 0 check (required_qty >= 0),
  purchase_qty    numeric(18,4) not null default 0 check (purchase_qty >= 0),
  unit_cost       numeric(18,4) check (unit_cost >= 0),
  currency_code   char(3) not null default 'USD' references public.currencies(code),
  exchange_rate   numeric(18,6) check (exchange_rate > 0),
  vendor_id       uuid references public.partners(id),
  price_source    text,
  lead_time_days  int,
  shipping_cost   numeric(18,2) not null default 0 check (shipping_cost >= 0),   -- base currency, for the whole line
  import_tax_pct  numeric(6,2) not null default 0 check (import_tax_pct >= 0),
  notes           text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index cost_estimate_lines_est_idx on public.cost_estimate_lines(estimate_id);
select app.attach_std('public.cost_estimate_lines');
create trigger cost_estimate_lines_no before insert on public.cost_estimate_lines
  for each row execute function app.trg_line_no('estimate_id');
create trigger cost_estimate_lines_rate before insert or update on public.cost_estimate_lines
  for each row execute function app.trg_fill_rate();

create table public.cost_estimate_labor (
  id              uuid primary key default gen_random_uuid(),
  estimate_id     uuid not null references public.cost_estimates(id) on delete cascade,
  discipline      text not null default 'elec',
  main_task       text,
  step_code       text,
  work_step       text not null,
  description     text,
  hours_per_unit  numeric(10,2) not null default 0 check (hours_per_unit >= 0),
  rate            numeric(18,2) not null default 0 check (rate >= 0),        -- base currency per hour
  sort            int not null default 0,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index cost_estimate_labor_est_idx on public.cost_estimate_labor(estimate_id);
select app.attach_std('public.cost_estimate_labor');

create table public.cost_estimate_fees (
  id              uuid primary key default gen_random_uuid(),
  estimate_id     uuid not null references public.cost_estimates(id) on delete cascade,
  rule_id         uuid references public.cost_rules(id) on delete set null,
  name            text not null,
  basis           text not null default 'fixed' check (basis in ('per_package','per_unit','fixed','percent_of_material')),
  quantity        numeric(18,4) not null default 1 check (quantity >= 0),
  amount          numeric(18,4) not null default 0 check (amount >= 0),
  currency_code   char(3) not null default 'USD' references public.currencies(code),
  exchange_rate   numeric(18,6) check (exchange_rate > 0),
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index cost_estimate_fees_est_idx on public.cost_estimate_fees(estimate_id);
select app.attach_std('public.cost_estimate_fees');
create trigger cost_estimate_fees_rate before insert or update on public.cost_estimate_fees
  for each row execute function app.trg_fill_rate();

-- line economics (base currency)
create view public.v_cost_estimate_lines with (security_invoker = on) as
select l.*, i.sku, i.erp_code, v.name as vendor_name,
       (l.unit_cost is null) as missing_price,
       round(l.required_qty * coalesce(l.unit_cost, 0) * coalesce(l.exchange_rate, 1), 2) as material_base,
       round(l.purchase_qty * coalesce(l.unit_cost, 0) * coalesce(l.exchange_rate, 1), 2) as purchase_base,
       round((l.purchase_qty - l.required_qty) * coalesce(l.unit_cost, 0) * coalesce(l.exchange_rate, 1), 2) as moq_extra_base,
       round(l.purchase_qty * coalesce(l.unit_cost, 0) * coalesce(l.exchange_rate, 1) * l.import_tax_pct / 100.0, 2) as import_tax_base,
       round(coalesce(l.unit_cost, 0) * coalesce(l.exchange_rate, 1), 4) as unit_cost_base
  from public.cost_estimate_lines l
  left join public.items i on i.id = l.item_id
  left join public.partners v on v.id = l.vendor_id;

create view public.v_cost_estimate_fees with (security_invoker = on) as
select f.*,
       round(case when f.basis = 'percent_of_material'
                  then f.amount / 100.0 * coalesce((select sum(material_base) from public.v_cost_estimate_lines x where x.estimate_id = f.estimate_id), 0)
                  else f.quantity * f.amount * coalesce(f.exchange_rate, 1) end, 2) as total_base
  from public.cost_estimate_fees f;

-- Summary — same letters as the former "Final cost to quote" sheet:
--   A qty · B material (BOM + fabrication + import tax + line shipping) · C labour (× (1 + labour markup))
--   D Apillis cost = B + C(raw) + H · E = B × (1 + markup %) · F = C + E · G = F × VAT %
--   H fees (forwarder, CoC …) + logistics · I shipping · J packing · K = F + G + H + I + J · L = K + MOQ extra
create view public.v_cost_estimates with (security_invoker = on) as
with m as (
  select estimate_id, sum(material_base) material, sum(moq_extra_base) moq_extra, sum(import_tax_base) import_tax,
         sum(shipping_cost) line_shipping, count(*) lines, count(*) filter (where missing_price) missing_prices,
         max(lead_time_days) max_lead_time
    from public.v_cost_estimate_lines group by estimate_id),
lab as (
  select estimate_id, sum(hours_per_unit) hours_per_unit, sum(hours_per_unit * rate) labor_per_unit
    from public.cost_estimate_labor group by estimate_id),
fee as (
  select estimate_id, sum(total_base) fees from public.v_cost_estimate_fees group by estimate_id),
calc as (
  select e.*,
         coalesce(m.material, 0) as material_base,
         coalesce(m.import_tax, 0) + coalesce(m.line_shipping, 0) as landed_extra_base,
         coalesce(m.material, 0) + coalesce(m.import_tax, 0) + coalesce(m.line_shipping, 0) as b_material_cost,
         coalesce(lab.hours_per_unit, 0) * e.build_qty as labor_hours,
         round(coalesce(lab.labor_per_unit, 0) * e.build_qty, 2) as labor_cost_raw,
         round(coalesce(lab.labor_per_unit, 0) * e.build_qty * (1 + e.markup_labor_pct / 100.0), 2) as c_labor_cost,
         coalesce(fee.fees, 0) + e.logistics_cost as h_fees_logistics,
         coalesce(m.moq_extra, 0) as moq_extra_base,
         coalesce(m.lines, 0) as line_count, coalesce(m.missing_prices, 0) as missing_prices, m.max_lead_time
    from public.cost_estimates e
    left join m on m.estimate_id = e.id
    left join lab on lab.estimate_id = e.id
    left join fee on fee.estimate_id = e.id)
select c.*, p.code as project_code, b.revision as bom_revision, q.doc_no as quotation_no,
       round(c.b_material_cost + c.labor_cost_raw + c.h_fees_logistics, 2) as d_apillis_cost,
       round(c.b_material_cost * (1 + c.markup_material_pct / 100.0), 2) as e_material_with_markup,
       round(c.c_labor_cost + c.b_material_cost * (1 + c.markup_material_pct / 100.0), 2) as f_subtotal,
       round((c.c_labor_cost + c.b_material_cost * (1 + c.markup_material_pct / 100.0)) * c.vat_pct / 100.0, 2) as g_vat,
       round((c.c_labor_cost + c.b_material_cost * (1 + c.markup_material_pct / 100.0)) * (1 + c.vat_pct / 100.0)
             + c.h_fees_logistics + c.shipping_cost + c.packing_cost, 2) as k_sale_price_base,
       round((c.c_labor_cost + c.b_material_cost * (1 + c.markup_material_pct / 100.0)) * (1 + c.vat_pct / 100.0)
             + c.h_fees_logistics + c.shipping_cost + c.packing_cost + c.moq_extra_base, 2) as l_sale_price_moq_base,
       round(((c.c_labor_cost + c.b_material_cost * (1 + c.markup_material_pct / 100.0)) * (1 + c.vat_pct / 100.0)
             + c.h_fees_logistics + c.shipping_cost + c.packing_cost + c.moq_extra_base) / c.build_qty, 2) as unit_sale_price_base,
       round(((c.c_labor_cost + c.b_material_cost * (1 + c.markup_material_pct / 100.0)) * (1 + c.vat_pct / 100.0)
             + c.h_fees_logistics + c.shipping_cost + c.packing_cost + c.moq_extra_base) / c.build_qty / coalesce(c.exchange_rate, 1), 2) as unit_sale_price,
       round(((c.c_labor_cost + c.b_material_cost * (1 + c.markup_material_pct / 100.0)) * (1 + c.vat_pct / 100.0)
             + c.h_fees_logistics + c.shipping_cost + c.packing_cost + c.moq_extra_base) / coalesce(c.exchange_rate, 1), 2) as total_sale_price,
       round(c.c_labor_cost - c.labor_cost_raw + c.b_material_cost * c.markup_material_pct / 100.0, 2) as gross_margin_base
  from calc c
  left join public.projects p on p.id = c.project_id
  left join public.boms b on b.id = c.bom_id
  left join public.quotations q on q.id = c.quotation_id;

create or replace function app.default_labor_rate() returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select app.to_base_safe(hourly_rate, currency_code, null, current_date) from public.labor_rates where role_code = 'production'),
    (app.setting('default_labor_rate') #>> '{}')::numeric, 0)
$$;

create or replace function public.build_cost_estimate(p_bom_id uuid, p_build_qty numeric default null,
  p_currency text default 'USD', p_markup numeric default 30, p_disciplines text[] default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.boms; v_id uuid; r record; bp record; v_build numeric; v_disc text[]; v_top_type text; v_rate numeric;
  v_title text; cr record;
begin
  if not app.can('costing', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into b from public.boms where id = p_bom_id;
  if not found or b.status = 'cancelled' then raise exception 'BOM not found' using errcode = 'P0001'; end if;
  v_build := coalesce(p_build_qty, b.build_qty);
  select part_type into v_top_type from public.items where id = b.top_item_id;
  v_disc := coalesce(p_disciplines, case when v_top_type = 'cable_assy' then array['cable'] else array['elec','mech'] end);
  v_rate := app.default_labor_rate();
  v_title := coalesce(nullif(b.customer_part_no, ''), (select sku from public.items where id = b.top_item_id), b.name)
             || ' rev ' || coalesce(b.customer_rev, b.revision) || ' × ' || trim(to_char(v_build, 'FM999999990.####'));

  insert into public.cost_estimates(project_id, bom_id, title, build_qty, build_location, currency_code, markup_material_pct)
  values (b.project_id, b.id, v_title, v_build, b.build_location, p_currency, coalesce(p_markup, 30))
  returning id into v_id;

  for r in
    select l.*, app.bom_line_required(l.id) / b.build_qty as per_unit
      from public.bom_lines l
     where l.bom_id = b.id and app.bom_line_purchasable(l.id)
     order by l.level, l.line_no
  loop
    select * into bp from app.best_price(r.item_id);
    insert into public.cost_estimate_lines(estimate_id, line_no, bom_line_id, item_id, find_no, customer_part_no, description,
         manufacturer, mpn, uom, part_type, per_unit_qty, required_qty, purchase_qty, unit_cost, currency_code, vendor_id,
         price_source, lead_time_days)
    values (v_id, r.line_no, r.id, r.item_id, r.find_no, r.customer_part_no, r.description, r.manufacturer, r.mpn, r.uom, r.part_type,
         r.per_unit, r.per_unit * v_build,
         app.round_order_qty(r.per_unit * v_build, coalesce(bp.moq, (select moq from public.items where id = r.item_id)),
                             coalesce(nullif(bp.order_multiple, 0), (select order_multiple from public.items where id = r.item_id))),
         bp.unit_price, coalesce(bp.currency_code, 'USD'), bp.vendor_id, bp.source,
         coalesce(bp.lead_time_days, (select lead_time_days from public.items where id = r.item_id)));
  end loop;

  insert into public.cost_estimate_labor(estimate_id, discipline, main_task, step_code, work_step, description, hours_per_unit, rate, sort)
  select v_id, t.discipline, t.main_task, t.step_code, t.work_step, t.description, t.default_hours, v_rate, t.sort
    from public.labor_step_templates t where t.is_active and t.discipline = any(v_disc) order by t.discipline, t.sort;

  for cr in select * from public.cost_rules where is_active
                and (build_location is null or build_location = b.build_location) loop
    if cr.part_types is null or exists (select 1 from public.cost_estimate_lines x where x.estimate_id = v_id and x.part_type = any(cr.part_types)) then
      insert into public.cost_estimate_fees(estimate_id, rule_id, name, basis, quantity, amount, currency_code)
      values (v_id, cr.id, cr.name, cr.basis,
              case cr.basis when 'per_package' then 1 when 'per_unit' then v_build else 1 end, cr.amount, cr.currency_code);
    end if;
  end loop;
  return v_id;
end $$;

-- re-read prices for a draft estimate (after RFQ awards / new quotes)
create or replace function public.refresh_cost_estimate_prices(p_estimate_id uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.cost_estimates; r record; bp record; n int := 0;
begin
  if not app.can('costing', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into e from public.cost_estimates where id = p_estimate_id;
  if e.status not in ('draft','rejected') then raise exception 'Only draft estimates can be refreshed' using errcode = 'P0001'; end if;
  for r in select * from public.cost_estimate_lines where estimate_id = e.id and item_id is not null loop
    select * into bp from app.best_price(r.item_id);
    continue when bp.unit_price is null;
    update public.cost_estimate_lines
       set unit_cost = bp.unit_price, currency_code = bp.currency_code, exchange_rate = null, vendor_id = bp.vendor_id,
           price_source = bp.source, lead_time_days = coalesce(bp.lead_time_days, lead_time_days),
           purchase_qty = app.round_order_qty(required_qty, bp.moq, bp.order_multiple)
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- approved estimate → quotation line (unit sale price in the quote currency)
create or replace function public.push_estimate_to_quotation(p_estimate_id uuid, p_quotation_id uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare e record; v_q uuid := p_quotation_id; v_cust uuid; v_status text; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if not app.can('quotations', 'write') then raise exception 'Not allowed to edit quotations' using errcode = '42501'; end if;
  select * into e from public.v_cost_estimates where id = p_estimate_id;
  if not found then raise exception 'Estimate not found' using errcode = 'P0001'; end if;
  if e.status <> 'approved' then raise exception 'The estimate must be approved first' using errcode = 'P0001'; end if;
  if v_q is null then
    select customer_id into v_cust from public.projects where id = e.project_id;
    if v_cust is null then raise exception 'The project has no customer' using errcode = 'P0001'; end if;
    insert into public.quotations(customer_id, title, currency_code, exchange_rate)
    values (v_cust, e.title, e.currency_code, e.exchange_rate) returning id into v_q;
  else
    select status into v_status from public.quotations where id = v_q;
    if v_status not in ('draft','rejected') then raise exception 'The quotation is not a draft' using errcode = 'P0001'; end if;
  end if;
  insert into public.quotation_lines(quotation_id, description, qty, uom, unit_price)
  values (v_q, e.title || ' (' || e.doc_no || ')', e.build_qty, 'SET', e.unit_sale_price);
  perform set_config('app.ctx', 'system', true);
  update public.cost_estimates set status = 'quoted', quotation_id = v_q where id = e.id;
  perform set_config('app.ctx', v_prev, true);
  return v_q;
end $$;

-- ---------------------------------------------------------------------------
-- RFQ
-- ---------------------------------------------------------------------------
create table public.rfqs (
  id            uuid primary key default gen_random_uuid(),
  doc_no        text not null unique,
  project_id    uuid references public.projects(id),
  bom_id        uuid references public.boms(id),
  title         text not null,
  due_date      date,
  currency_code char(3) not null default 'USD' references public.currencies(code),
  status        text not null default 'draft' check (status in ('draft','sent','quoted','awarded','closed','cancelled')),
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
select app.attach_std('public.rfqs', 'rfq');

create table public.rfq_lines (
  id            uuid primary key default gen_random_uuid(),
  rfq_id        uuid not null references public.rfqs(id) on delete cascade,
  line_no       int not null default 0,
  bom_line_id   uuid references public.bom_lines(id) on delete set null,
  item_id       uuid references public.items(id),
  description   text not null,
  manufacturer  text,
  mpn           text,
  qty           numeric(18,4) not null check (qty > 0),
  uom           text not null references public.uoms(code) on update cascade,
  drawing_url   text,
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index rfq_lines_rfq_idx on public.rfq_lines(rfq_id);
select app.attach_std('public.rfq_lines');
create trigger rfq_lines_no before insert on public.rfq_lines
  for each row execute function app.trg_line_no('rfq_id');
create trigger rfq_lines_zz_uom before insert or update of uom, item_id on public.rfq_lines
  for each row execute function app.trg_norm_uom('EA');
create trigger rfq_lines_guard before insert or update or delete on public.rfq_lines
  for each row execute function app.trg_guard_lines('rfqs', 'rfq_id');

create table public.rfq_vendors (
  id            uuid primary key default gen_random_uuid(),
  rfq_id        uuid not null references public.rfqs(id) on delete cascade,
  vendor_id     uuid not null references public.partners(id),
  contact_email text,
  status        text not null default 'pending' check (status in ('pending','sent','quoted','declined')),
  sent_at       timestamptz,
  responded_at  timestamptz,
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  unique (rfq_id, vendor_id)
);
select app.attach_std('public.rfq_vendors');
create trigger rfq_vendors_vendor_chk before insert or update of vendor_id on public.rfq_vendors
  for each row execute function app.trg_check_partner_role('vendor_id', 'is_vendor');

create table public.rfq_quotes (
  id              uuid primary key default gen_random_uuid(),
  rfq_id          uuid not null references public.rfqs(id) on delete cascade,
  rfq_line_id     uuid not null references public.rfq_lines(id) on delete cascade,
  rfq_vendor_id   uuid not null references public.rfq_vendors(id) on delete cascade,
  unit_price      numeric(18,4) not null check (unit_price >= 0),
  currency_code   char(3) not null default 'USD' references public.currencies(code),
  moq             numeric(18,4) not null default 0 check (moq >= 0),
  lead_time_days  int check (lead_time_days >= 0),
  valid_until     date,
  notes           text,
  is_awarded      boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  unique (rfq_vendor_id, rfq_line_id)
);
create index rfq_quotes_line_idx on public.rfq_quotes(rfq_line_id);
select app.attach_std('public.rfq_quotes');
alter table public.item_prices add constraint item_prices_rfq_quote_fk foreign key (rfq_quote_id) references public.rfq_quotes(id) on delete set null;

-- default vendor contact for RFQ
create or replace function app.rfq_vendor_email(p_vendor uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select email from public.partner_contacts where partner_id = p_vendor and is_rfq_default and coalesce(email, '') <> '' limit 1),
    (select email from public.partner_contacts where partner_id = p_vendor and coalesce(email, '') <> '' order by created_at limit 1),
    (select nullif(email, '') from public.partners where id = p_vendor))
$$;

create or replace function app.trg_rfq_vendor_defaults() returns trigger
language plpgsql as $$
begin
  if coalesce(new.contact_email, '') = '' then new.contact_email := app.rfq_vendor_email(new.vendor_id); end if;
  return new;
end $$;
create trigger rfq_vendors_defaults before insert on public.rfq_vendors
  for each row execute function app.trg_rfq_vendor_defaults();

-- quotes only on a sent RFQ; a quote marks the vendor as responded
create or replace function app.trg_rfq_quote() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status text; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if tg_op = 'DELETE' then return old; end if;
  select status into v_status from public.rfqs where id = new.rfq_id;
  if v_status not in ('sent','quoted','awarded') and v_prev <> 'system' then
    raise exception 'Quotes can be entered only after the RFQ was sent (status %)', v_status using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.rfq_lines where id = new.rfq_line_id and rfq_id = new.rfq_id)
     or not exists (select 1 from public.rfq_vendors where id = new.rfq_vendor_id and rfq_id = new.rfq_id) then
    raise exception 'Line / vendor do not belong to this RFQ' using errcode = 'P0001';
  end if;
  if v_prev <> 'system' and tg_op = 'UPDATE' then new.is_awarded := old.is_awarded; end if;
  if v_prev <> 'system' and tg_op = 'INSERT' then new.is_awarded := false; end if;
  return new;
end $$;
create trigger rfq_quotes_check before insert or update or delete on public.rfq_quotes
  for each row execute function app.trg_rfq_quote();

create or replace function app.trg_rfq_quote_after() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  update public.rfq_vendors set status = 'quoted', responded_at = coalesce(responded_at, now())
   where id = new.rfq_vendor_id and status <> 'quoted';
  perform set_config('app.ctx', 'system', true);
  update public.rfqs set status = 'quoted' where id = new.rfq_id and status = 'sent';
  perform set_config('app.ctx', v_prev, true);
  return null;
end $$;
create trigger rfq_quotes_after after insert on public.rfq_quotes
  for each row execute function app.trg_rfq_quote_after();

-- status guard: sent/quoted/awarded are set by the RFQ functions
create or replace function app.trg_rfq_guard() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.ctx', true), '') in ('system') or auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'New RFQs start as draft' using errcode = 'P0001'; end if;
    return new;
  end if;
  if new.status is distinct from old.status then
    if new.status in ('sent','quoted','awarded') then
      raise exception 'Status "%" is set by the RFQ workflow', new.status using errcode = 'P0001';
    end if;
    if old.status in ('closed','cancelled') then
      raise exception 'The RFQ is % and cannot change', old.status using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger rfqs_guard before insert or update on public.rfqs
  for each row execute function app.trg_rfq_guard();

create or replace function public.create_rfq_from_bom(p_bom_id uuid, p_line_ids uuid[] default null, p_vendor_ids uuid[] default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.boms; v_id uuid; n int;
begin
  if not app.can('rfq', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into b from public.boms where id = p_bom_id;
  if not found then raise exception 'BOM not found' using errcode = 'P0001'; end if;
  insert into public.rfqs(project_id, bom_id, title, due_date)
  values (b.project_id, b.id, coalesce(b.customer_part_no, b.name) || ' rev ' || coalesce(b.customer_rev, b.revision), current_date + 7)
  returning id into v_id;
  insert into public.rfq_lines(rfq_id, line_no, bom_line_id, item_id, description, manufacturer, mpn, qty, uom, drawing_url)
  select v_id, l.line_no, l.id, l.item_id, l.description, l.manufacturer, l.mpn,
         app.bom_line_required(l.id), l.uom, l.drawing_url
    from public.bom_lines l
   where l.bom_id = b.id and (case when p_line_ids is null then app.bom_line_purchasable(l.id) else l.id = any(p_line_ids) end)
   order by l.level, l.line_no;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'No BOM lines to quote' using errcode = 'P0001'; end if;
  if p_vendor_ids is not null then
    insert into public.rfq_vendors(rfq_id, vendor_id) select v_id, unnest(p_vendor_ids) on conflict do nothing;
  end if;
  return v_id;
end $$;

create or replace function public.send_rfq(p_rfq_id uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.rfqs; v record; v_body text; v_lines text; n int := 0; v_prev text := coalesce(current_setting('app.ctx', true), '');
  v_company text := coalesce(app.setting_text('company_name'), 'Apillis');
begin
  if not app.can('rfq', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into q from public.rfqs where id = p_rfq_id;
  if not found or q.status not in ('draft','sent','quoted') then raise exception 'The RFQ cannot be sent (status %)', q.status using errcode = 'P0001'; end if;
  if not exists (select 1 from public.rfq_lines where rfq_id = q.id) then raise exception 'The RFQ has no lines' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.rfq_vendors where rfq_id = q.id) then raise exception 'Add at least one vendor' using errcode = 'P0001'; end if;

  select string_agg(format('%s. %s | MFR: %s | MPN: %s | Qty: %s %s%s', l.line_no, l.description, coalesce(l.manufacturer, '-'),
                           coalesce(l.mpn, '-'), trim(to_char(l.qty, 'FM999999990.####')), l.uom,
                           case when l.drawing_url is not null then ' | Drawing: ' || l.drawing_url else '' end), E'\n' order by l.line_no)
    into v_lines from public.rfq_lines l where l.rfq_id = q.id;

  for v in select rv.*, p.name as vendor_name from public.rfq_vendors rv join public.partners p on p.id = rv.vendor_id
            where rv.rfq_id = q.id and rv.status in ('pending','sent') loop
    if coalesce(v.contact_email, '') = '' then continue; end if;
    v_body := format(E'Dear %s,\n\n%s kindly requests your quotation for the items below.\nPlease reply with unit price, currency, MOQ, lead time and validity%s.\n\n%s\n\nReference: %s\nBest regards,\n%s Procurement',
                     v.vendor_name, v_company,
                     case when q.due_date is not null then ' before ' || to_char(q.due_date, 'YYYY-MM-DD') else '' end,
                     v_lines, q.doc_no, v_company);
    if app.setting_bool('rfq_email_enabled', true) then
      insert into public.notification_outbox(channel, recipient, subject, body)
      values ('email', v.contact_email, format('[%s] RFQ %s — %s', v_company, q.doc_no, q.title), v_body);
    end if;
    update public.rfq_vendors set status = 'sent', sent_at = now() where id = v.id;
    n := n + 1;
  end loop;
  perform set_config('app.ctx', 'system', true);
  update public.rfqs set status = case when status = 'draft' then 'sent' else status end where id = q.id;
  perform set_config('app.ctx', v_prev, true);
  return n;
end $$;

create or replace function public.award_rfq_quote(p_quote_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare x record; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if not app.can('rfq', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select qt.*, l.item_id, rv.vendor_id into x from public.rfq_quotes qt
    join public.rfq_lines l on l.id = qt.rfq_line_id join public.rfq_vendors rv on rv.id = qt.rfq_vendor_id
   where qt.id = p_quote_id;
  if not found then raise exception 'Quote not found' using errcode = 'P0001'; end if;
  perform set_config('app.ctx', 'system', true);
  update public.rfq_quotes set is_awarded = (id = x.id) where rfq_line_id = x.rfq_line_id;
  if x.item_id is not null then
    delete from public.item_prices where rfq_quote_id in (select id from public.rfq_quotes where rfq_line_id = x.rfq_line_id);
    insert into public.item_prices(item_id, vendor_id, unit_price, currency_code, moq, lead_time_days, valid_to, source, rfq_quote_id, notes)
    values (x.item_id, x.vendor_id, x.unit_price, x.currency_code, x.moq, x.lead_time_days, x.valid_until, 'quote', x.id,
            'Awarded in ' || (select doc_no from public.rfqs where id = x.rfq_id));
  end if;
  update public.rfqs set status = 'awarded'
   where id = x.rfq_id and not exists (
     select 1 from public.rfq_lines l where l.rfq_id = x.rfq_id
        and not exists (select 1 from public.rfq_quotes q where q.rfq_line_id = l.id and q.is_awarded));
  perform set_config('app.ctx', v_prev, true);
end $$;

-- one draft PO per awarded vendor; lines linked to open PR lines of the same BOM line when possible
create or replace function public.create_pos_from_rfq(p_rfq_id uuid) returns uuid[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare q public.rfqs; v record; a record; v_po uuid; v_out uuid[] := '{}'; v_prl record; v_qty numeric;
  v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if not app.can('po', 'write') then raise exception 'Not allowed to create purchase orders' using errcode = '42501'; end if;
  select * into q from public.rfqs where id = p_rfq_id;
  if not exists (select 1 from public.rfq_quotes where rfq_id = q.id and is_awarded) then
    raise exception 'No awarded quote yet' using errcode = 'P0001';
  end if;
  for v in select distinct rv.vendor_id, qt.currency_code from public.rfq_quotes qt join public.rfq_vendors rv on rv.id = qt.rfq_vendor_id
            where qt.rfq_id = q.id and qt.is_awarded loop
    insert into public.purchase_orders(vendor_id, project_id, currency_code, notes)
    values (v.vendor_id, q.project_id, v.currency_code, 'From ' || q.doc_no) returning id into v_po;
    v_out := v_out || v_po;
    for a in select qt.*, l.bom_line_id, l.item_id, l.description, l.qty as line_qty, l.uom, l.line_no
               from public.rfq_quotes qt join public.rfq_lines l on l.id = qt.rfq_line_id join public.rfq_vendors rv on rv.id = qt.rfq_vendor_id
              where qt.rfq_id = q.id and qt.is_awarded and rv.vendor_id = v.vendor_id and qt.currency_code = v.currency_code
              order by l.line_no loop
      v_prl := null;
      if a.bom_line_id is not null then
        select pl.id, pl.qty + pl.moq_qty - pl.ordered_qty
                 - coalesce((select sum(x.qty) from public.po_lines x join public.purchase_orders o on o.id = x.po_id
                              where x.pr_line_id = pl.id and o.status in ('draft','pending_approval')), 0) as open_qty
          into v_prl
          from public.pr_lines pl join public.purchase_requests r on r.id = pl.pr_id
         where pl.bom_line_id = a.bom_line_id and r.status in ('approved','partially_ordered')
         order by r.created_at limit 1;
      end if;
      if v_prl.id is not null and v_prl.open_qty > 0 then
        v_qty := least(greatest(a.line_qty, a.moq), v_prl.open_qty);
        insert into public.po_lines(po_id, line_no, pr_line_id, qty, unit_price)
        values (v_po, a.line_no, v_prl.id, v_qty, a.unit_price);
      else
        insert into public.po_lines(po_id, line_no, item_id, description, qty, uom, unit_price, notes)
        values (v_po, a.line_no, a.item_id, a.description, greatest(a.line_qty, a.moq), a.uom, a.unit_price, 'No approved PR line');
      end if;
    end loop;
  end loop;
  perform set_config('app.ctx', 'system', true);
  update public.rfqs set status = 'closed' where id = q.id;
  perform set_config('app.ctx', v_prev, true);
  return v_out;
end $$;

create view public.v_rfqs with (security_invoker = on) as
select q.*, p.code as project_code, b.revision as bom_revision,
       (select count(*) from public.rfq_lines l where l.rfq_id = q.id) as line_count,
       (select count(*) from public.rfq_vendors v where v.rfq_id = q.id) as vendor_count,
       (select count(*) from public.rfq_vendors v where v.rfq_id = q.id and v.status = 'quoted') as quoted_count
  from public.rfqs q
  left join public.projects p on p.id = q.project_id
  left join public.boms b on b.id = q.bom_id;

create view public.v_rfq_vendors with (security_invoker = on) as
select rv.*, p.code as vendor_code, p.name as vendor_name
  from public.rfq_vendors rv join public.partners p on p.id = rv.vendor_id;

create view public.v_rfq_comparison with (security_invoker = on) as
select qt.id as quote_id, qt.rfq_id, r.doc_no as rfq_no, l.id as rfq_line_id, l.line_no, l.description, l.manufacturer, l.mpn,
       l.qty, l.uom, rv.id as rfq_vendor_id, rv.vendor_id, p.name as vendor_name, qt.unit_price, qt.currency_code,
       round(app.to_base_safe(qt.unit_price, qt.currency_code, null, current_date), 4) as unit_price_base,
       round(app.to_base_safe(qt.unit_price * greatest(l.qty, qt.moq), qt.currency_code, null, current_date), 2) as total_base,
       qt.moq, qt.lead_time_days, qt.valid_until, qt.is_awarded, qt.notes,
       rank() over (partition by l.id order by app.to_base_safe(qt.unit_price, qt.currency_code, null, current_date) nulls last) as price_rank,
       rank() over (partition by l.id order by qt.lead_time_days nulls last) as lead_time_rank
  from public.rfq_quotes qt
  join public.rfq_lines l on l.id = qt.rfq_line_id
  join public.rfqs r on r.id = qt.rfq_id
  join public.rfq_vendors rv on rv.id = qt.rfq_vendor_id
  join public.partners p on p.id = rv.vendor_id;

-- ---------------------------------------------------------------------------
-- Approval engine: add cost estimates
-- ---------------------------------------------------------------------------
alter table public.approval_rules drop constraint approval_rules_doc_type_check;
alter table public.approval_rules add constraint approval_rules_doc_type_check
  check (doc_type in ('quotation','sales_order','bom','eco','purchase_request','purchase_order','cost_estimate'));

create or replace function app.doc_table(p_doc_type text) returns text
language sql immutable as $$
  select case p_doc_type
    when 'quotation' then 'quotations' when 'sales_order' then 'sales_orders' when 'bom' then 'boms'
    when 'eco' then 'ecos' when 'purchase_request' then 'purchase_requests' when 'purchase_order' then 'purchase_orders'
    when 'cost_estimate' then 'cost_estimates' end
$$;

create or replace function app.doc_resource(p_doc_type text) returns text
language sql immutable as $$
  select case p_doc_type
    when 'quotation' then 'quotations' when 'sales_order' then 'sales_orders' when 'bom' then 'bom'
    when 'eco' then 'eco' when 'purchase_request' then 'pr' when 'purchase_order' then 'po'
    when 'cost_estimate' then 'costing' end
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
  else
    raise exception 'Unknown document type %', p_doc_type using errcode = 'P0001';
  end case;
  if doc_no is null then raise exception 'Document not found' using errcode = 'P0001'; end if;
end $$;

select app.attach_doc_guards('cost_estimates', 'quoted,cancelled', 'quotation_id', 'cost_estimate_lines', 'estimate_id');
create trigger cost_estimate_labor_guard before insert or update or delete on public.cost_estimate_labor
  for each row execute function app.trg_guard_lines('cost_estimates', 'estimate_id');
create trigger cost_estimate_fees_guard before insert or update or delete on public.cost_estimate_fees
  for each row execute function app.trg_guard_lines('cost_estimates', 'estimate_id');

alter table public.approval_requests drop constraint if exists approval_requests_doc_type_check;

-- ---------------------------------------------------------------------------
-- RLS for the new tables
-- ---------------------------------------------------------------------------
select app.apply_resource_policies('uoms', 'settings');
select app.apply_resource_policies('uom_conversions', 'settings');
select app.apply_resource_policies('import_mappings', 'settings');
select app.apply_resource_policies('cost_rules', 'settings');
select app.apply_resource_policies('labor_step_templates', 'settings');
do $$
declare t text;
begin
  foreach t in array array['uoms','uom_conversions','import_mappings','cost_rules','labor_step_templates'] loop
    execute format('drop policy %I on public.%I', t || '_sel', t);
    execute format('create policy %I on public.%I for select to authenticated using (auth.uid() is not null)', t || '_sel', t);
  end loop;
end $$;
select app.apply_resource_policies('item_customer_refs', 'items');
select app.apply_resource_policies('bom_reservations', 'bom', false, false, false);
select app.apply_resource_policies('partner_contacts', 'partners');
select app.apply_resource_policies('cost_estimates', 'costing');
select app.apply_resource_policies('cost_estimate_lines', 'costing');
select app.apply_resource_policies('cost_estimate_labor', 'costing');
select app.apply_resource_policies('cost_estimate_fees', 'costing');
select app.apply_resource_policies('rfqs', 'rfq');
select app.apply_resource_policies('rfq_lines', 'rfq');
select app.apply_resource_policies('rfq_vendors', 'rfq');
select app.apply_resource_policies('rfq_quotes', 'rfq');

alter table public.item_prices enable row level security;
create policy item_prices_sel on public.item_prices for select to authenticated
  using (app.can('costing','read') or app.can('po','read') or app.can('rfq','read'));
create policy item_prices_write on public.item_prices for all to authenticated
  using (app.can('costing','write') or app.can('po','write') or app.can('rfq','write'))
  with check (app.can('costing','write') or app.can('po','write') or app.can('rfq','write'));

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
revoke all on all tables in schema public from anon;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on all functions in schema app from anon, public;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on all functions in schema public from anon;
