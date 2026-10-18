-- =============================================================================
-- 0016 (v1.2) project finance — SRS: "verify customer prepayments", "finance
-- triggers milestone billing", "aggregates costs in real time (PO + freight +
-- timesheets)", "final debt reconciliation and project P&L", export "Project
-- P&L and cash-flow statement".
--   billing_milestones  payment schedule of the contract (30 % advance, 60 %
--                       after FAT …), optionally tied to an IDEF0 activity:
--                       when the activity is done the milestone becomes
--                       "ready" and Accounting is notified to invoice it.
--   invoices (+lines)   customer invoices (AR); external_ref = e-invoice no.
--                       from the accounting software (MISA).
--   payments            cash in (customer, against an invoice or advance) and
--                       cash out (vendor against a PO, carrier freight …).
-- The legal books stay in the accounting software; this is project control.
-- =============================================================================

create table public.billing_milestones (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  sales_order_id  uuid references public.sales_orders(id),
  seq             smallint not null default 1 check (seq between 1 and 99),
  name            text not null check (btrim(name) <> ''),
  percent         numeric(7,3) check (percent > 0 and percent <= 100),
  amount          numeric(18,2) check (amount > 0),
  currency_code   char(3) references public.currencies(code),
  activity_id     uuid references public.activities(id) on delete set null,
  planned_date    date,
  status          text not null default 'planned' check (status in ('planned','ready','invoiced','paid','cancelled')),
  invoice_id      uuid,
  notes           text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  check (percent is not null or amount is not null)
);
create index billing_milestones_project_idx on public.billing_milestones(project_id, seq);
create index billing_milestones_activity_idx on public.billing_milestones(activity_id);
select app.attach_std('public.billing_milestones');

create table public.invoices (
  id               uuid primary key default gen_random_uuid(),
  doc_no           text not null unique,
  customer_id      uuid not null references public.partners(id),
  project_id       uuid references public.projects(id),
  sales_order_id   uuid references public.sales_orders(id),
  milestone_id     uuid references public.billing_milestones(id),
  invoice_date     date not null default current_date,
  due_date         date,
  currency_code    char(3) not null references public.currencies(code),
  exchange_rate    numeric(18,6) check (exchange_rate > 0),
  external_ref     text,
  status           text not null default 'draft' check (status in ('draft','issued','partially_paid','paid','cancelled')),
  paid_amount      numeric(18,2) not null default 0,
  issued_at        timestamptz,
  cancelled_reason text,
  notes            text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  check (due_date is null or due_date >= invoice_date)
);
create index invoices_project_idx on public.invoices(project_id, status);
create index invoices_customer_idx on public.invoices(customer_id, status);
select app.attach_std('public.invoices', 'invoice');
create trigger invoices_rate before insert or update on public.invoices
  for each row execute function app.trg_fill_rate();
create trigger invoices_customer_chk before insert or update of customer_id on public.invoices
  for each row execute function app.trg_check_partner_role('customer_id', 'is_customer');
alter table public.billing_milestones
  add constraint billing_milestones_invoice_fk foreign key (invoice_id) references public.invoices(id) on delete set null;

create table public.invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  line_no       int not null default 0,
  item_id       uuid references public.items(id),
  description   text not null,
  qty           numeric(18,4) not null check (qty > 0),
  uom           text not null references public.uoms(code) on update cascade,
  unit_price    numeric(18,4) not null default 0 check (unit_price >= 0),
  discount_pct  numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  tax_code      text references public.tax_codes(code),
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id)
);
create index invoice_lines_invoice_idx on public.invoice_lines(invoice_id);
select app.attach_std('public.invoice_lines');
create trigger invoice_lines_no before insert on public.invoice_lines
  for each row execute function app.trg_line_no('invoice_id');
create trigger invoice_lines_zz_uom before insert or update of uom, item_id on public.invoice_lines
  for each row execute function app.trg_norm_uom('SET');
create trigger invoice_lines_guard before insert or update or delete on public.invoice_lines
  for each row execute function app.trg_guard_lines('invoices', 'invoice_id');

create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,
  direction       text not null check (direction in ('in','out')),
  partner_id      uuid not null references public.partners(id),
  project_id      uuid references public.projects(id),
  invoice_id      uuid references public.invoices(id),
  po_id           uuid references public.purchase_orders(id),
  payment_date    date not null default current_date,
  amount          numeric(18,2) not null check (amount > 0),
  currency_code   char(3) not null references public.currencies(code),
  exchange_rate   numeric(18,6) check (exchange_rate > 0),
  method          text not null default 'bank' check (method in ('bank','cash','card','offset','other')),
  reference       text,
  notes           text,
  created_at timestamptz not null default now(), created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references public.profiles(id),
  check (direction = 'in' or invoice_id is null),
  check (direction = 'out' or po_id is null)
);
create index payments_invoice_idx on public.payments(invoice_id);
create index payments_po_idx on public.payments(po_id);
create index payments_project_idx on public.payments(project_id, payment_date);
select app.attach_std('public.payments', 'payment');
create trigger payments_rate before insert or update on public.payments
  for each row execute function app.trg_fill_rate();

-- ---------------------------------------------------------------------------
-- Amount helpers
-- ---------------------------------------------------------------------------
create or replace function app.so_net(p_so uuid) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(app.line_net(qty, unit_price, discount_pct)), 0) from public.sales_order_lines where sales_order_id = p_so
$$;

create or replace function app.milestone_amount(p_id uuid) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(m.amount, round(app.so_net(m.sales_order_id) * m.percent / 100.0, 2))
    from public.billing_milestones m where m.id = p_id
$$;

create or replace function app.invoice_totals(p_id uuid, out net numeric, out tax numeric, out total numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(app.line_net(qty, unit_price, discount_pct)), 0),
         coalesce(round(sum(app.line_net(qty, unit_price, discount_pct) * app.tax_rate(tax_code) / 100), 2), 0),
         coalesce(sum(app.line_net(qty, unit_price, discount_pct)), 0)
           + coalesce(round(sum(app.line_net(qty, unit_price, discount_pct) * app.tax_rate(tax_code) / 100), 2), 0)
    from public.invoice_lines where invoice_id = p_id
$$;

create or replace function app.po_total(p_id uuid) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(app.line_net(qty, unit_price, discount_pct) * (1 + app.tax_rate(tax_code) / 100)), 0)
    from public.po_lines where po_id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Billing milestones
-- ---------------------------------------------------------------------------
create or replace function app.trg_milestone() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; v_sum numeric; v_ctx text := coalesce(current_setting('app.ctx', true), '');
begin
  if new.sales_order_id is not null then
    select project_id, currency_code, status into s from public.sales_orders where id = new.sales_order_id;
    if s.project_id is not null and s.project_id <> new.project_id then
      raise exception 'The sales order belongs to another project' using errcode = 'P0001';
    end if;
    new.currency_code := coalesce(new.currency_code, s.currency_code);
  end if;
  if new.percent is not null and new.amount is null and new.sales_order_id is null then
    raise exception 'A percentage milestone needs the sales order it is a percentage of' using errcode = 'P0001';
  end if;
  new.currency_code := coalesce(new.currency_code, app.base_currency());
  if new.activity_id is not null and not exists (
      select 1 from public.activities where id = new.activity_id and project_id = new.project_id) then
    raise exception 'The activity belongs to another project' using errcode = 'P0001';
  end if;
  if new.percent is not null and new.sales_order_id is not null and new.status <> 'cancelled' then
    select coalesce(sum(percent), 0) into v_sum from public.billing_milestones
     where sales_order_id = new.sales_order_id and status <> 'cancelled' and id <> new.id;
    if v_sum + new.percent > 100 then
      raise exception 'Milestones of this sales order exceed 100 %% (% + %)', v_sum, new.percent using errcode = 'P0001';
    end if;
  end if;

  if v_ctx = 'system' or auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if new.status not in ('planned','ready') then
      raise exception 'New milestones start as planned or ready' using errcode = 'P0001';
    end if;
    if new.activity_id is not null and exists (select 1 from public.activities where id = new.activity_id and status = 'done') then
      new.status := 'ready';
    end if;
    new.invoice_id := null;
    return new;
  end if;
  new.invoice_id := old.invoice_id;
  if new.status is distinct from old.status then
    if new.status in ('invoiced','paid') or old.status in ('invoiced','paid') then
      raise exception 'Invoiced / paid status is set by the invoice workflow' using errcode = 'P0001';
    end if;
    if old.status = 'cancelled' then
      raise exception 'The milestone is cancelled' using errcode = 'P0001';
    end if;
  end if;
  if old.status in ('invoiced','paid') and (new.percent, new.amount, new.currency_code, new.sales_order_id, new.project_id)
       is distinct from (old.percent, old.amount, old.currency_code, old.sales_order_id, old.project_id) then
    raise exception 'The milestone is invoiced; its amount is locked' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger billing_milestones_check before insert or update on public.billing_milestones
  for each row execute function app.trg_milestone();

-- IDEF0 activity done (e.g. "FAT with customer") → milestone ready → Accounting notified
create or replace function app.trg_activity_milestone() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare m record; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    perform set_config('app.ctx', 'system', true);
    for m in update public.billing_milestones set status = 'ready'
              where activity_id = new.id and status = 'planned' returning id, name, project_id loop
      perform app.notify_roles(array['accounting'], 'Billing milestone ready: ' || m.name,
        'Project ' || (select code from public.projects where id = m.project_id) || ' — activity ' || new.node_code
        || ' "' || new.title || '" is done. Issue the invoice.', '/r/billing_milestones');
      perform app.notify_chat('💰 Billing milestone ready: ' || m.name || ' · project '
        || (select code from public.projects where id = m.project_id));
    end loop;
    perform set_config('app.ctx', v_prev, true);
  end if;
  return null;
end $$;
create trigger activities_milestone after update of status on public.activities
  for each row execute function app.trg_activity_milestone();

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
-- tg_argv[1] = header columns that stay editable after issue (same convention as app.trg_guard_doc)
create or replace function app.trg_invoice_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ctx text := coalesce(current_setting('app.ctx', true), '');
  v_free text[] := array['status','notes','updated_at','updated_by'] || string_to_array(coalesce(tg_argv[1], ''), ',');
  t record; m record;
begin
  if new.milestone_id is not null and (tg_op = 'INSERT' or new.milestone_id is distinct from old.milestone_id) then
    select * into m from public.billing_milestones where id = new.milestone_id;
    if m.status not in ('planned','ready') then
      raise exception 'The milestone is already % ', m.status using errcode = 'P0001';
    end if;
    if exists (select 1 from public.invoices where milestone_id = new.milestone_id and status <> 'cancelled' and id <> new.id) then
      raise exception 'The milestone already has an invoice' using errcode = 'P0001';
    end if;
    new.project_id := coalesce(new.project_id, m.project_id);
    new.sales_order_id := coalesce(new.sales_order_id, m.sales_order_id);
  end if;

  if v_ctx = 'system' or auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'New invoices start as draft' using errcode = 'P0001'; end if;
    new.paid_amount := 0; new.issued_at := null;
    return new;
  end if;
  new.paid_amount := old.paid_amount;
  new.issued_at := old.issued_at;
  if new.status is distinct from old.status then
    if new.status in ('partially_paid','paid') then
      raise exception 'Paid status is set by the payments' using errcode = 'P0001';
    end if;
    if old.status = 'cancelled' then raise exception 'The invoice is cancelled' using errcode = 'P0001'; end if;
    if new.status = 'draft' then raise exception 'An issued invoice cannot go back to draft; cancel it' using errcode = 'P0001'; end if;
    if new.status = 'issued' then
      if old.status <> 'draft' then raise exception 'Status change % → issued is not allowed', old.status using errcode = 'P0001'; end if;
      select * into t from app.invoice_totals(new.id);
      if t.total <= 0 then raise exception 'Add at least one line with an amount before issuing' using errcode = 'P0001'; end if;
      new.issued_at := now();
      new.due_date := coalesce(new.due_date, new.invoice_date + coalesce((app.setting('default_payment_days') #>> '{}')::int, 30));
    end if;
    if new.status = 'cancelled' then
      if old.status in ('partially_paid','paid') or exists (select 1 from public.payments where invoice_id = new.id) then
        raise exception 'The invoice has payments; delete them first' using errcode = 'P0001';
      end if;
      if old.status = 'issued' and coalesce(btrim(new.cancelled_reason), '') = '' then
        raise exception 'A reason is required to cancel an issued invoice' using errcode = 'P0001';
      end if;
    end if;
  end if;
  if old.status <> 'draft' and (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
    raise exception 'The invoice is % — only notes, e-invoice no. and due date can change', old.status using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger invoices_guard before insert or update on public.invoices
  for each row execute function app.trg_invoice_guard('', 'external_ref,due_date,cancelled_reason');
create trigger invoices_guard_del before delete on public.invoices
  for each row execute function app.trg_guard_doc_delete();

create or replace function app.trg_invoice_after() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if new.milestone_id is null or new.status is not distinct from old.status then return null; end if;
  perform set_config('app.ctx', 'system', true);
  if new.status = 'issued' and old.status = 'draft' then
    update public.billing_milestones set status = 'invoiced', invoice_id = new.id where id = new.milestone_id;
  elsif new.status = 'cancelled' then
    -- an issued invoice was cancelled: the milestone is billable again
    update public.billing_milestones set status = 'ready', invoice_id = null
     where id = new.milestone_id and invoice_id = new.id and status = 'invoiced';
  elsif new.status = 'paid' then
    update public.billing_milestones set status = 'paid' where id = new.milestone_id and invoice_id = new.id;
  elsif new.status in ('issued','partially_paid') and old.status = 'paid' then
    update public.billing_milestones set status = 'invoiced' where id = new.milestone_id and invoice_id = new.id;
  end if;
  perform set_config('app.ctx', v_prev, true);
  return null;
end $$;
create trigger invoices_after after update of status on public.invoices
  for each row execute function app.trg_invoice_after();

-- paid amount and status from the payments
create or replace function app.refresh_invoice(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_paid numeric; t record; v_status text; v_prev text := coalesce(current_setting('app.ctx', true), '');
begin
  if p_id is null then return; end if;
  select coalesce(sum(amount), 0) into v_paid from public.payments where invoice_id = p_id;
  select * into t from app.invoice_totals(p_id);
  select status into v_status from public.invoices where id = p_id;
  perform set_config('app.ctx', 'system', true);
  update public.invoices
     set paid_amount = v_paid,
         status = case when v_status not in ('issued','partially_paid','paid') then status
                       when t.total > 0 and v_paid >= t.total - 0.005 then 'paid'
                       when v_paid > 0 then 'partially_paid' else 'issued' end
   where id = p_id;
  perform set_config('app.ctx', v_prev, true);
end $$;

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
create or replace function app.trg_payment_check() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare i record; t record; o record; v_paid numeric; v_total numeric; p record;
  v_free text[] := array['notes','reference','method','updated_at','updated_by'];
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('app.ctx', true), '') <> 'system'
     and (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
    raise exception 'Payments cannot be changed — delete and enter them again' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then return new; end if;

  if new.invoice_id is not null then
    select * into i from public.invoices where id = new.invoice_id;
    if i.status not in ('issued','partially_paid') then
      raise exception 'Payments can be recorded only against an issued, unpaid invoice (status: %)', i.status using errcode = 'P0001';
    end if;
    if new.currency_code is not null and new.currency_code <> i.currency_code then
      raise exception 'The payment currency must be the invoice currency (%)', i.currency_code using errcode = 'P0001';
    end if;
    new.partner_id := i.customer_id;
    new.project_id := coalesce(new.project_id, i.project_id);
    new.currency_code := i.currency_code;
    select * into t from app.invoice_totals(i.id);
    select coalesce(sum(amount), 0) into v_paid from public.payments where invoice_id = i.id;
    if v_paid + new.amount > t.total + 0.01 then
      raise exception 'Over-payment: % already paid + % > invoice total %', v_paid, new.amount, t.total using errcode = 'P0001';
    end if;
  end if;
  if new.po_id is not null then
    select * into o from public.purchase_orders where id = new.po_id;
    if o.status not in ('approved','ordered','partially_received','received','closed') then
      raise exception 'Payments to vendors need an approved purchase order (status: %)', o.status using errcode = 'P0001';
    end if;
    if new.currency_code is not null and new.currency_code <> o.currency_code then
      raise exception 'The payment currency must be the PO currency (%)', o.currency_code using errcode = 'P0001';
    end if;
    new.partner_id := o.vendor_id;
    new.project_id := coalesce(new.project_id, o.project_id);
    new.currency_code := o.currency_code;
    v_total := app.po_total(o.id);
    select coalesce(sum(amount), 0) into v_paid from public.payments where po_id = o.id;
    if v_paid + new.amount > v_total + 0.01 then
      raise exception 'Over-payment: % already paid + % > PO total %', v_paid, new.amount, round(v_total, 2) using errcode = 'P0001';
    end if;
  end if;
  select is_customer, is_vendor, is_carrier into p from public.partners where id = new.partner_id;
  if new.direction = 'in' and not coalesce(p.is_customer, false) then
    raise exception 'Money in comes from a customer' using errcode = 'P0001';
  end if;
  if new.direction = 'out' and not (coalesce(p.is_vendor, false) or coalesce(p.is_carrier, false)) then
    raise exception 'Money out goes to a vendor or carrier' using errcode = 'P0001';
  end if;
  return new;
end $$;
-- "check" sorts before "doc_no", "rate" and "touch": partner/currency are set before the rate is filled
create trigger payments_check before insert or update on public.payments
  for each row execute function app.trg_payment_check();

create or replace function app.trg_payment_after() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op <> 'INSERT' then perform app.refresh_invoice(old.invoice_id); end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id) then
    perform app.refresh_invoice(new.invoice_id);
  end if;
  return null;
end $$;
create trigger payments_after after insert or update or delete on public.payments
  for each row execute function app.trg_payment_after();

-- ---------------------------------------------------------------------------
-- RPC: milestone → draft invoice
-- ---------------------------------------------------------------------------
create or replace function public.create_invoice_from_milestone(p_milestone_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.billing_milestones; s public.sales_orders; v_customer uuid; v_inv uuid; v_amount numeric; v_tax text;
begin
  if not app.can('invoices', 'write') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into m from public.billing_milestones where id = p_milestone_id;
  if not found then raise exception 'Milestone not found' using errcode = 'P0001'; end if;
  if m.status not in ('planned','ready') then
    raise exception 'The milestone is already %', m.status using errcode = 'P0001';
  end if;
  -- a row-type variable stays all-null when the milestone has no sales order
  select * into s from public.sales_orders where id = m.sales_order_id;
  v_customer := coalesce(s.customer_id, (select customer_id from public.projects where id = m.project_id));
  if v_customer is null then raise exception 'The project has no customer' using errcode = 'P0001'; end if;
  v_amount := app.milestone_amount(m.id);
  if coalesce(v_amount, 0) <= 0 then raise exception 'The milestone amount is zero (sales order without lines?)' using errcode = 'P0001'; end if;
  v_tax := coalesce((select tax_code from public.sales_order_lines where sales_order_id = m.sales_order_id and tax_code is not null
                      order by line_no limit 1), app.setting_text('default_tax_code'));

  insert into public.invoices(customer_id, project_id, sales_order_id, milestone_id, currency_code, exchange_rate)
  values (v_customer, m.project_id, m.sales_order_id, m.id, m.currency_code,
          case when s.currency_code = m.currency_code then s.exchange_rate end)
  returning id into v_inv;
  insert into public.invoice_lines(invoice_id, description, qty, uom, unit_price, tax_code)
  values (v_inv, m.name || coalesce(' — ' || coalesce(s.customer_po_no, s.doc_no), '')
                 || case when m.percent is not null then ' (' || trim(to_char(m.percent, 'FM990.###')) || ' %)' else '' end,
          1, 'LOT', v_amount, v_tax);
  return v_inv;
end $$;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
create view public.v_billing_milestones with (security_invoker = on) as
select m.id, m.project_id, p.code as project_code, p.name as project_name, m.sales_order_id, so.doc_no as sales_order_no,
       m.seq, m.name, m.percent, m.amount, m.currency_code,
       app.milestone_amount(m.id) as amount_due,
       round(app.to_base_safe(app.milestone_amount(m.id), m.currency_code,
             case when so.currency_code = m.currency_code then so.exchange_rate end, coalesce(m.planned_date, current_date)), 2) as amount_due_base,
       m.activity_id, a.node_code, a.title as activity_title, a.status as activity_status, a.planned_end as activity_planned_end,
       m.planned_date, m.status, m.invoice_id, i.doc_no as invoice_no, i.status as invoice_status,
       (m.status in ('planned','ready') and m.planned_date < current_date) as is_late,
       m.notes, m.created_at, m.updated_at
  from public.billing_milestones m
  join public.projects p on p.id = m.project_id
  left join public.sales_orders so on so.id = m.sales_order_id
  left join public.activities a on a.id = m.activity_id
  left join public.invoices i on i.id = m.invoice_id;

create view public.v_invoices with (security_invoker = on) as
select i.id, i.doc_no, i.invoice_date, i.due_date, i.status, i.customer_id, c.code as customer_code, c.name as customer_name,
       i.project_id, p.code as project_code, i.sales_order_id, so.doc_no as sales_order_no, i.milestone_id, m.name as milestone_name,
       i.currency_code, i.exchange_rate, i.external_ref,
       t.net as net_amount, t.tax as tax_amount, t.total as total_amount, i.paid_amount,
       greatest(t.total - i.paid_amount, 0) as balance,
       round(app.to_base_safe(t.net, i.currency_code, i.exchange_rate, i.invoice_date), 2) as net_amount_base,
       round(app.to_base_safe(t.total, i.currency_code, i.exchange_rate, i.invoice_date), 2) as total_amount_base,
       round(app.to_base_safe(greatest(t.total - i.paid_amount, 0), i.currency_code, i.exchange_rate, i.invoice_date), 2) as balance_base,
       case when i.status in ('issued','partially_paid') and i.due_date < current_date then current_date - i.due_date else 0 end as days_overdue,
       (i.status in ('issued','partially_paid') and i.due_date < current_date) as is_overdue,
       case when i.status not in ('issued','partially_paid') then null
            when i.due_date is null or i.due_date >= current_date then 'current'
            when current_date - i.due_date <= 30 then '1-30'
            when current_date - i.due_date <= 60 then '31-60'
            when current_date - i.due_date <= 90 then '61-90' else '>90' end as aging_bucket,
       i.issued_at, i.cancelled_reason, i.notes, i.created_at, i.updated_at
  from public.invoices i
  join public.partners c on c.id = i.customer_id
  left join public.projects p on p.id = i.project_id
  left join public.sales_orders so on so.id = i.sales_order_id
  left join public.billing_milestones m on m.id = i.milestone_id
  cross join lateral app.invoice_totals(i.id) t;

create view public.v_receivables with (security_invoker = on) as
select * from public.v_invoices where status in ('issued','partially_paid');

create view public.v_payments with (security_invoker = on) as
select y.id, y.doc_no, y.direction, y.payment_date, y.partner_id, pt.code as partner_code, pt.name as partner_name,
       y.project_id, p.code as project_code, y.invoice_id, i.doc_no as invoice_no, y.po_id, o.doc_no as po_no,
       y.amount, y.currency_code, y.exchange_rate,
       round(app.to_base_safe(y.amount, y.currency_code, y.exchange_rate, y.payment_date), 2) as amount_base,
       round(app.to_base_safe(y.amount, y.currency_code, y.exchange_rate, y.payment_date), 2)
         * case when y.direction = 'in' then 1 else -1 end as signed_amount_base,
       y.method, y.reference, y.notes, u.full_name as created_by_name, y.created_at
  from public.payments y
  join public.partners pt on pt.id = y.partner_id
  left join public.projects p on p.id = y.project_id
  left join public.invoices i on i.id = y.invoice_id
  left join public.purchase_orders o on o.id = y.po_id
  left join public.profiles u on u.id = y.created_by;

-- Project P&L: contract, billing, collection, committed / actual cost, margin, cash
create view public.v_project_pnl with (security_invoker = on) as
with rate as (
  select ur.user_id, max(app.to_base_safe(lr.hourly_rate, lr.currency_code, null, current_date)) as rate_base
    from public.user_roles ur join public.labor_rates lr on lr.role_code = ur.role_code
   group by ur.user_id),
labor as (
  select t.project_id, sum(t.hours) as hours, sum(t.hours * coalesce(r.rate_base, 0)) as cost
    from public.timesheets t left join rate r on r.user_id = t.user_id
   where t.status = 'approved' group by t.project_id),
po as (
  select l.project_id,
         sum(app.line_net(l.qty, l.unit_price, l.discount_pct) * coalesce(o.exchange_rate, 1)) as committed,
         sum(app.line_net(l.received_qty, l.unit_price, l.discount_pct) * coalesce(o.exchange_rate, 1)) as received
    from public.po_lines l join public.purchase_orders o on o.id = l.po_id
   where o.status not in ('draft','pending_approval','rejected','cancelled') and l.project_id is not null
   group by l.project_id),
so as (
  select s.project_id, sum(app.line_net(l.qty, l.unit_price, l.discount_pct) * coalesce(s.exchange_rate, 1)) as revenue
    from public.sales_orders s join public.sales_order_lines l on l.sales_order_id = s.id
   where s.status not in ('draft','pending_approval','rejected','cancelled') and s.project_id is not null
   group by s.project_id),
inv as (
  select project_id, sum(net_amount_base) as invoiced, sum(balance_base) as receivable,
         sum(balance_base) filter (where is_overdue) as overdue
    from public.v_invoices where status in ('issued','partially_paid','paid') and project_id is not null
   group by project_id),
pay as (
  select project_id, sum(amount_base) filter (where direction = 'in') as cash_in,
         sum(amount_base) filter (where direction = 'out') as cash_out
    from public.v_payments where project_id is not null group by project_id),
fr as (
  select project_id, sum(total_cost_base) as freight
    from public.v_shipments where status <> 'cancelled' and project_id is not null group by project_id)
select p.id as project_id, p.code as project_code, p.name as project_name, p.status, c.name as customer_name,
       round(coalesce(so.revenue, 0), 2) as contract_value_base,
       round(app.to_base_safe(coalesce(p.budget_amount, 0), coalesce(p.budget_currency, app.base_currency()), null, current_date), 2) as budget_base,
       round(coalesce(inv.invoiced, 0), 2) as invoiced_base,
       round(greatest(coalesce(so.revenue, 0) - coalesce(inv.invoiced, 0), 0), 2) as unbilled_base,
       round(coalesce(pay.cash_in, 0), 2) as collected_base,
       round(coalesce(inv.receivable, 0), 2) as receivable_base,
       round(coalesce(inv.overdue, 0), 2) as overdue_receivable_base,
       coalesce(labor.hours, 0) as approved_hours,
       round(coalesce(labor.cost, 0), 2) as labor_cost_base,
       round(coalesce(po.committed, 0), 2) as po_committed_base,
       round(coalesce(po.received, 0), 2) as po_received_base,
       round(coalesce(fr.freight, 0), 2) as freight_cost_base,
       round(coalesce(labor.cost, 0) + coalesce(po.committed, 0) + coalesce(fr.freight, 0), 2) as total_cost_base,
       round(coalesce(so.revenue, 0) - coalesce(labor.cost, 0) - coalesce(po.committed, 0) - coalesce(fr.freight, 0), 2) as gross_margin_base,
       round(100 * (coalesce(so.revenue, 0) - coalesce(labor.cost, 0) - coalesce(po.committed, 0) - coalesce(fr.freight, 0))
             / nullif(so.revenue, 0), 1) as gross_margin_pct,
       round(app.to_base_safe(coalesce(p.budget_amount, 0), coalesce(p.budget_currency, app.base_currency()), null, current_date)
             - coalesce(labor.cost, 0) - coalesce(po.committed, 0) - coalesce(fr.freight, 0), 2) as budget_remaining_base,
       round(coalesce(pay.cash_out, 0), 2) as paid_out_base,
       round(coalesce(pay.cash_in, 0) - coalesce(pay.cash_out, 0), 2) as net_cash_base
  from public.projects p
  left join public.partners c on c.id = p.customer_id
  left join labor on labor.project_id = p.id
  left join po on po.project_id = p.id
  left join so on so.project_id = p.id
  left join inv on inv.project_id = p.id
  left join pay on pay.project_id = p.id
  left join fr on fr.project_id = p.id
 where app.can('finance', 'read');

-- Monthly cash flow per project: actual (payments) + forecast (open invoices,
-- billing milestones not invoiced yet, unpaid PO amounts by promised date)
create view public.v_project_cashflow with (security_invoker = on) as
with actual as (
  select project_id, date_trunc('month', payment_date)::date as month,
         sum(amount_base) filter (where direction = 'in') as actual_in,
         sum(amount_base) filter (where direction = 'out') as actual_out
    from public.v_payments where project_id is not null group by 1, 2),
fin as (
  select project_id, date_trunc('month', greatest(coalesce(due_date, invoice_date), current_date))::date as month, sum(balance_base) as amt
    from public.v_invoices where status in ('issued','partially_paid') and project_id is not null group by 1, 2
  union all
  select project_id, date_trunc('month', greatest(coalesce(planned_date, current_date), current_date))::date, sum(amount_due_base)
    from public.v_billing_milestones where status in ('planned','ready') group by 1, 2),
fout as (
  select o.project_id, date_trunc('month', greatest(coalesce(o.promised_date, o.order_date), current_date))::date as month,
         sum(greatest(app.to_base_safe(app.po_total(o.id), o.currency_code, o.exchange_rate, o.order_date)
               - coalesce((select sum(app.to_base_safe(y.amount, y.currency_code, y.exchange_rate, y.payment_date))
                             from public.payments y where y.po_id = o.id), 0), 0)) as amt
    from public.purchase_orders o
   where o.project_id is not null and o.status in ('approved','ordered','partially_received','received','closed')
   group by 1, 2),
keys as (
  select project_id, month from actual union select project_id, month from fin union select project_id, month from fout),
m as (
  select k.project_id, k.month,
         round(coalesce(a.actual_in, 0), 2) as actual_in, round(coalesce(a.actual_out, 0), 2) as actual_out,
         round(coalesce((select sum(amt) from fin where fin.project_id = k.project_id and fin.month = k.month), 0), 2) as forecast_in,
         round(coalesce((select sum(amt) from fout where fout.project_id = k.project_id and fout.month = k.month), 0), 2) as forecast_out
    from keys k left join actual a on a.project_id = k.project_id and a.month = k.month)
select m.project_id, p.code as project_code, m.month, m.actual_in, m.actual_out, m.forecast_in, m.forecast_out,
       m.actual_in + m.forecast_in - m.actual_out - m.forecast_out as net_flow,
       sum(m.actual_in + m.forecast_in - m.actual_out - m.forecast_out)
         over (partition by m.project_id order by m.month rows unbounded preceding) as cumulative_net,
       (m.month < date_trunc('month', current_date)::date) as is_past
  from m join public.projects p on p.id = m.project_id
 where app.can('finance', 'read');

-- the existing project cost view also counts freight now (columns appended)
create or replace view public.v_project_cost with (security_invoker = on) as
select project_id, project_code, project_name, status, contract_value_base, budget_base, approved_hours, labor_cost_base,
       po_committed_base, po_received_base, total_cost_base, gross_margin_base, freight_cost_base, invoiced_base, collected_base
  from public.v_project_pnl;

-- RLS
select app.apply_resource_policies('billing_milestones', 'invoices');
select app.apply_resource_policies('invoices', 'invoices');
select app.apply_resource_policies('invoice_lines', 'invoices');
select app.apply_resource_policies('payments', 'payments');

grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
revoke all on all tables in schema public from anon;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on all functions in schema app from anon, public;
grant execute on all functions in schema app to authenticated, service_role;
revoke execute on all functions in schema public from anon;
