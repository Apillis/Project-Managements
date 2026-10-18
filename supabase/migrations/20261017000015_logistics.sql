-- =============================================================================
-- 0015 (v1.2) logistics — SRS: "view delivery schedules, dispatch vehicles, log
-- transportation costs directly to the Project_ID"; export "Freight cost by
-- route / project". A shipment is one transport job (inbound from a vendor,
-- outbound to the customer site or internal between sites) with its packing
-- list, route, carrier / vehicle and freight cost.
-- =============================================================================

create table public.shipments (
  id                    uuid primary key default gen_random_uuid(),
  doc_no                text not null unique,
  direction             text not null default 'outbound' check (direction in ('inbound','outbound','internal')),
  project_id            uuid references public.projects(id),
  sales_order_id        uuid references public.sales_orders(id),
  po_id                 uuid references public.purchase_orders(id),
  carrier_id            uuid references public.partners(id),
  origin                text not null check (btrim(origin) <> ''),
  destination           text not null check (btrim(destination) <> ''),
  incoterm              text,
  tracking_no           text,
  vehicle               text,
  driver                text,
  packages              int check (packages >= 0),
  gross_weight_kg       numeric(12,2) check (gross_weight_kg >= 0),
  volume_m3             numeric(12,3) check (volume_m3 >= 0),
  planned_ship_date     date,
  planned_delivery_date date,
  shipped_at            timestamptz,
  delivered_at          timestamptz,
  status                text not null default 'planned'
                        check (status in ('planned','booked','in_transit','delivered','cancelled')),
  freight_cost          numeric(18,2) not null default 0 check (freight_cost >= 0),
  other_cost            numeric(18,2) not null default 0 check (other_cost >= 0),
  currency_code         char(3) not null references public.currencies(code),
  exchange_rate         numeric(18,6) check (exchange_rate > 0),
  notes                 text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  check (planned_delivery_date is null or planned_ship_date is null or planned_delivery_date >= planned_ship_date)
);
create index shipments_project_idx on public.shipments(project_id, status);
create index shipments_dates_idx on public.shipments(planned_ship_date);
select app.attach_std('public.shipments', 'shipment');
create trigger shipments_rate before insert or update on public.shipments
  for each row execute function app.trg_fill_rate();
create trigger shipments_carrier_chk before insert or update of carrier_id on public.shipments
  for each row execute function app.trg_check_partner_role('carrier_id', 'is_carrier');

create table public.shipment_lines (
  id            uuid primary key default gen_random_uuid(),
  shipment_id   uuid not null references public.shipments(id) on delete cascade,
  line_no       int not null default 0,
  item_id       uuid references public.items(id),
  description   text not null default '',
  qty           numeric(18,4) not null check (qty > 0),
  uom           text not null references public.uoms(code) on update cascade,
  package_no    text,
  lot_no        text,
  serial_no     text,
  notes         text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index shipment_lines_shipment_idx on public.shipment_lines(shipment_id);
select app.attach_std('public.shipment_lines');
create trigger shipment_lines_no before insert on public.shipment_lines
  for each row execute function app.trg_line_no('shipment_id');
create trigger shipment_lines_zz_uom before insert or update of uom, item_id on public.shipment_lines
  for each row execute function app.trg_norm_uom('EA');

create or replace function app.trg_shipment_line_item() returns trigger
language plpgsql as $$
begin
  if new.item_id is not null and coalesce(new.description, '') = '' then
    select name into new.description from public.items where id = new.item_id;
  end if;
  if coalesce(new.description, '') = '' then
    raise exception 'Description is required' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger shipment_lines_item before insert or update on public.shipment_lines
  for each row execute function app.trg_shipment_line_item();

-- defaults from the linked documents, status stamps, no edits once delivered
create or replace function app.trg_shipment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; o record;
begin
  if new.sales_order_id is not null and (tg_op = 'INSERT' or new.sales_order_id is distinct from old.sales_order_id) then
    select project_id, incoterm into s from public.sales_orders where id = new.sales_order_id;
    new.project_id := coalesce(new.project_id, s.project_id);
    new.incoterm := coalesce(nullif(new.incoterm, ''), s.incoterm);
  end if;
  if new.po_id is not null and (tg_op = 'INSERT' or new.po_id is distinct from old.po_id) then
    select project_id, incoterm into o from public.purchase_orders where id = new.po_id;
    new.project_id := coalesce(new.project_id, o.project_id);
    new.incoterm := coalesce(nullif(new.incoterm, ''), o.incoterm);
  end if;

  if tg_op = 'UPDATE' and coalesce(current_setting('app.ctx', true), '') <> 'system' then
    if old.status in ('delivered','cancelled') and new.status is distinct from old.status then
      raise exception 'The shipment is % and cannot change status', old.status using errcode = 'P0001';
    end if;
    if old.status = 'cancelled' and (to_jsonb(new) - array['notes','updated_at','updated_by'])
                                   is distinct from (to_jsonb(old) - array['notes','updated_at','updated_by']) then
      raise exception 'The shipment is cancelled' using errcode = 'P0001';
    end if;
  end if;
  if new.status in ('in_transit','delivered') then new.shipped_at := coalesce(new.shipped_at, now()); end if;
  if new.status = 'delivered' then new.delivered_at := coalesce(new.delivered_at, now()); end if;
  if new.status in ('planned','booked') then new.shipped_at := null; new.delivered_at := null; end if;
  return new;
end $$;
create trigger shipments_flow before insert or update on public.shipments
  for each row execute function app.trg_shipment();

create or replace function app.trg_shipment_delivered() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_proj text;
begin
  if new.status = 'delivered' and old.status <> 'delivered' then
    select code into v_proj from public.projects where id = new.project_id;
    perform app.notify_roles(array['pmo','logistics'] || case when new.direction = 'outbound' then array['sales'] else '{}'::text[] end,
      'Shipment ' || new.doc_no || ' delivered',
      new.origin || ' → ' || new.destination || coalesce(' · project ' || v_proj, ''), '/r/shipments');
  end if;
  return null;
end $$;
create trigger shipments_delivered after update of status on public.shipments
  for each row execute function app.trg_shipment_delivered();

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
create view public.v_shipments with (security_invoker = on) as
select s.id, s.doc_no, s.direction, s.status, s.project_id, p.code as project_code, s.sales_order_id, so.doc_no as sales_order_no,
       s.po_id, po.po_no, s.carrier_id, c.name as carrier_name, s.origin, s.destination,
       s.origin || ' → ' || s.destination as route, s.incoterm, s.tracking_no, s.vehicle, s.driver,
       s.packages, s.gross_weight_kg, s.volume_m3, s.planned_ship_date, s.planned_delivery_date, s.shipped_at, s.delivered_at,
       s.freight_cost, s.other_cost, s.freight_cost + s.other_cost as total_cost, s.currency_code, s.exchange_rate,
       round(app.to_base_safe(s.freight_cost + s.other_cost, s.currency_code, s.exchange_rate,
                              coalesce(s.shipped_at::date, s.planned_ship_date, current_date)), 2) as total_cost_base,
       case when s.delivered_at is not null and s.shipped_at is not null then s.delivered_at::date - s.shipped_at::date end as transit_days,
       (s.status not in ('delivered','cancelled') and s.planned_delivery_date < current_date) as is_late,
       case when s.status = 'delivered' and s.planned_delivery_date is not null
            then s.delivered_at::date <= s.planned_delivery_date end as on_time,
       (select count(*) from public.shipment_lines l where l.shipment_id = s.id) as line_count,
       s.notes, s.created_at, s.updated_at
  from public.shipments s
  left join public.projects p on p.id = s.project_id
  left join public.sales_orders so on so.id = s.sales_order_id
  left join public.v_po_receiving_docs po on po.po_id = s.po_id
  left join public.partners c on c.id = s.carrier_id;

-- SRS export "Freight cost by route / project"
create view public.v_freight_by_route with (security_invoker = on) as
select origin, destination, route, direction, project_id, project_code, carrier_name,
       count(*) as shipments,
       count(*) filter (where status = 'delivered') as delivered,
       round(100.0 * count(*) filter (where on_time) / nullif(count(*) filter (where status = 'delivered' and on_time is not null), 0), 1) as on_time_pct,
       sum(total_cost_base) as total_cost_base,
       round(avg(total_cost_base), 2) as avg_cost_base,
       sum(gross_weight_kg) as gross_weight_kg,
       round(sum(total_cost_base) / nullif(sum(gross_weight_kg), 0), 2) as cost_per_kg_base,
       round(avg(transit_days), 1) as avg_transit_days,
       min(planned_ship_date) as first_ship_date, max(planned_ship_date) as last_ship_date
  from public.v_shipments
 where status <> 'cancelled'
 group by origin, destination, route, direction, project_id, project_code, carrier_name;

select app.apply_resource_policies('shipments', 'logistics');
select app.apply_resource_policies('shipment_lines', 'logistics');

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
revoke all on all tables in schema public from anon;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on all functions in schema app from anon, public;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on all functions in schema public from anon;
