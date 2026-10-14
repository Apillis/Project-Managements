-- =============================================================================
-- 0008 reporting / export views. All views use security_invoker = on so the
-- caller's RLS applies (a user exports only what he may see), except
-- v_po_receiving which deliberately hides prices for Warehouse/QA/Logistics.
-- =============================================================================

-- ---------------------------------------------------------------- Sales
create view public.v_quotations with (security_invoker = on) as
select q.id, q.doc_no, q.quote_date, q.title, q.status, q.market, q.probability, q.valid_until, q.expected_close,
       q.customer_id, c.code as customer_code, c.name as customer_name,
       q.sales_owner_id, so.full_name as sales_owner,
       q.currency_code, q.exchange_rate,
       coalesce(t.net, 0) as net_amount, coalesce(t.tax, 0) as tax_amount, coalesce(t.net, 0) + coalesce(t.tax, 0) as total_amount,
       round(coalesce(t.net, 0) * coalesce(q.exchange_rate, 1), 2) as net_amount_base,
       q.lost_reason, q.notes, q.created_at, q.updated_at
  from public.quotations q
  join public.partners c on c.id = q.customer_id
  left join public.profiles so on so.id = q.sales_owner_id
  left join lateral (
    select sum(app.line_net(l.qty, l.unit_price, l.discount_pct)) net,
           sum(app.line_net(l.qty, l.unit_price, l.discount_pct) * app.tax_rate(l.tax_code) / 100) tax
      from public.quotation_lines l where l.quotation_id = q.id) t on true;

create view public.v_sales_pipeline with (security_invoker = on) as
select date_trunc('month', quote_date)::date as month, status, customer_name, sales_owner, market,
       count(*) as quotations,
       sum(net_amount_base) as net_amount_base,
       round(sum(net_amount_base * probability / 100.0), 2) as weighted_amount_base,
       count(*) filter (where status = 'won') as won,
       count(*) filter (where status = 'lost') as lost
  from public.v_quotations
 group by 1, 2, 3, 4, 5;

create view public.v_sales_orders with (security_invoker = on) as
select s.id, s.doc_no, s.order_date, s.delivery_date, s.status, s.customer_po_no,
       s.customer_id, c.code as customer_code, c.name as customer_name,
       s.quotation_id, q.doc_no as quotation_no, s.project_id, p.code as project_code,
       s.currency_code, s.exchange_rate, s.incoterm, s.payment_terms,
       coalesce(t.net, 0) as net_amount, coalesce(t.tax, 0) as tax_amount, coalesce(t.net, 0) + coalesce(t.tax, 0) as total_amount,
       round(coalesce(t.net, 0) * coalesce(s.exchange_rate, 1), 2) as net_amount_base,
       s.notes, s.created_at
  from public.sales_orders s
  join public.partners c on c.id = s.customer_id
  left join public.quotations q on q.id = s.quotation_id
  left join public.projects p on p.id = s.project_id
  left join lateral (
    select sum(app.line_net(l.qty, l.unit_price, l.discount_pct)) net,
           sum(app.line_net(l.qty, l.unit_price, l.discount_pct) * app.tax_rate(l.tax_code) / 100) tax
      from public.sales_order_lines l where l.sales_order_id = s.id) t on true;

-- ---------------------------------------------------------------- Projects
create view public.v_activities with (security_invoker = on) as
select a.id, a.project_id, p.code as project_code, p.name as project_name,
       a.parent_id, pa.node_code as parent_code, a.node_code, a.depth, a.seq, a.title, a.description, a.kind,
       a.role_code, a.assignee_id, u.full_name as assignee_name,
       a.planned_start, a.planned_end, a.actual_start, a.actual_end, a.est_hours, a.progress_pct, a.status, a.is_milestone,
       (a.status not in ('done','cancelled') and a.planned_end < current_date) as is_overdue,
       case when a.status not in ('done','cancelled') and a.planned_end < current_date
            then current_date - a.planned_end else 0 end as days_overdue,
       (select string_agg(i.label, '; ' order by i.sort) from public.activity_icoms i where i.activity_id = a.id and i.icom_type = 'I') as inputs,
       (select string_agg(i.label, '; ' order by i.sort) from public.activity_icoms i where i.activity_id = a.id and i.icom_type = 'C') as controls,
       (select string_agg(i.label, '; ' order by i.sort) from public.activity_icoms i where i.activity_id = a.id and i.icom_type = 'O') as outputs,
       (select string_agg(i.label, '; ' order by i.sort) from public.activity_icoms i where i.activity_id = a.id and i.icom_type = 'M') as mechanisms,
       (select coalesce(sum(t.hours), 0) from public.timesheets t where t.activity_id = a.id and t.status <> 'rejected') as logged_hours,
       exists (select 1 from public.activities c where c.parent_id = a.id) as has_children,
       a.created_at, a.updated_at
  from public.activities a
  join public.projects p on p.id = a.project_id
  left join public.activities pa on pa.id = a.parent_id
  left join public.profiles u on u.id = a.assignee_id;

create view public.v_overdue_activities with (security_invoker = on) as
select * from public.v_activities where is_overdue;

create view public.v_projects with (security_invoker = on) as
select p.id, p.code, p.name, p.status, p.market, p.standards, p.start_date, p.due_date, p.closed_at,
       p.customer_id, c.name as customer_name, p.sales_order_id, s.doc_no as sales_order_no,
       p.pm_id, pm.full_name as pm_name, p.engineering_lead_id, el.full_name as engineering_lead_name,
       p.budget_amount, p.budget_currency,
       coalesce(r.progress_pct, 0) as progress_pct,
       (select count(*) from public.activities a where a.project_id = p.id and a.status not in ('done','cancelled')
           and a.planned_end < current_date
           and not exists (select 1 from public.activities c where c.parent_id = a.id)) as overdue_tasks,
       (select count(*) from public.ncrs n where n.project_id = p.id and n.status not in ('closed','cancelled')) as open_ncrs,
       (select count(*) from public.project_compliance pc where pc.project_id = p.id and pc.status in ('not_started','in_progress')) as open_compliance_items,
       (p.status in ('planning','active') and p.due_date < current_date) as is_late,
       p.description, p.created_at, p.updated_at
  from public.projects p
  left join public.partners c on c.id = p.customer_id
  left join public.sales_orders s on s.id = p.sales_order_id
  left join public.profiles pm on pm.id = p.pm_id
  left join public.profiles el on el.id = p.engineering_lead_id
  left join public.activities r on r.project_id = p.id and r.parent_id is null;

create view public.v_timesheets with (security_invoker = on) as
select t.id, t.work_date, date_trunc('month', t.work_date)::date as month, t.user_id, u.full_name as user_name, u.email,
       t.project_id, p.code as project_code, t.activity_id, a.node_code, a.title as activity_title,
       t.hours, t.description, t.status, t.decided_at, d.full_name as decided_by_name, t.reject_reason
  from public.timesheets t
  join public.profiles u on u.id = t.user_id
  join public.projects p on p.id = t.project_id
  left join public.activities a on a.id = t.activity_id
  left join public.profiles d on d.id = t.decided_by;

create view public.v_timesheet_summary with (security_invoker = on) as
select month, project_code, user_name, sum(hours) as hours,
       sum(hours) filter (where status = 'approved') as approved_hours
  from public.v_timesheets where status <> 'rejected'
 group by month, project_code, user_name;

-- ---------------------------------------------------------------- Engineering
create view public.v_bom_lines with (security_invoker = on) as
select l.id, l.bom_id, b.project_id, p.code as project_code, b.name as bom_name, b.revision, b.status as bom_status,
       l.line_no, l.item_id, i.sku, l.description, l.manufacturer, l.mpn, l.qty, l.uom, l.position, l.discipline,
       l.make_or_buy, l.notes
  from public.bom_lines l
  join public.boms b on b.id = l.bom_id
  join public.projects p on p.id = b.project_id
  left join public.items i on i.id = l.item_id;

create view public.v_boms with (security_invoker = on) as
select b.id, b.project_id, p.code as project_code, b.name, b.rev_no, b.revision, b.status, b.approved_at,
       b.based_on_id, b.eco_id, e.doc_no as eco_no,
       (select count(*) from public.bom_lines l where l.bom_id = b.id) as line_count,
       b.notes, b.created_at, b.updated_at
  from public.boms b
  join public.projects p on p.id = b.project_id
  left join public.ecos e on e.id = b.eco_id;

create view public.v_bom_vs_actual with (security_invoker = on) as
with req as (
  select b.project_id, l.item_id, max(l.description) as description, max(l.uom) as uom, sum(l.qty) as bom_qty
    from public.bom_lines l join public.boms b on b.id = l.bom_id
   where b.status = 'approved' and l.item_id is not null
   group by b.project_id, l.item_id),
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

create view public.v_ecos with (security_invoker = on) as
select e.id, e.doc_no, e.project_id, p.code as project_code, e.title, e.reason, e.status, e.impact_cost, e.impact_currency,
       e.impact_days, b.revision as from_revision, nb.revision as new_revision, e.description, e.created_at,
       u.full_name as created_by_name
  from public.ecos e
  join public.projects p on p.id = e.project_id
  left join public.boms b on b.id = e.bom_id
  left join public.boms nb on nb.id = e.implemented_bom_id
  left join public.profiles u on u.id = e.created_by;

create view public.v_documents with (security_invoker = on) as
select d.id, d.project_id, p.code as project_code, d.category, d.doc_no, d.title, d.revision, d.status,
       d.file_name, d.file_size, d.storage_path, a.node_code, d.notes, d.created_at, d.updated_at,
       u.full_name as uploaded_by
  from public.documents d
  left join public.projects p on p.id = d.project_id
  left join public.activities a on a.id = d.activity_id
  left join public.profiles u on u.id = d.created_by;

-- ---------------------------------------------------------------- Procurement
create view public.v_pr_lines with (security_invoker = on) as
select l.id, l.pr_id, r.doc_no as pr_no, r.status as pr_status, r.priority, r.needed_by as pr_needed_by,
       r.project_id, p.code as project_code, b.revision as bom_revision,
       l.line_no, l.item_id, i.sku, l.description, l.qty, l.uom, l.ordered_qty,
       greatest(l.qty - l.ordered_qty, 0) as open_qty, coalesce(l.needed_by, r.needed_by) as needed_by,
       u.full_name as requested_by_name, r.created_at
  from public.pr_lines l
  join public.purchase_requests r on r.id = l.pr_id
  left join public.projects p on p.id = r.project_id
  left join public.boms b on b.id = r.bom_id
  left join public.items i on i.id = l.item_id
  left join public.profiles u on u.id = r.requested_by;

create view public.v_purchase_orders with (security_invoker = on) as
select o.id, o.doc_no, o.order_date, o.promised_date, o.status, o.vendor_id, v.code as vendor_code, v.name as vendor_name,
       o.project_id, p.code as project_code, o.currency_code, o.exchange_rate, o.incoterm, o.payment_terms, o.vendor_ref,
       coalesce(t.net, 0) as net_amount, coalesce(t.tax, 0) as tax_amount, coalesce(t.net, 0) + coalesce(t.tax, 0) as total_amount,
       round(coalesce(t.net, 0) * coalesce(o.exchange_rate, 1), 2) as net_amount_base,
       bu.full_name as buyer_name, o.notes, o.created_at
  from public.purchase_orders o
  join public.partners v on v.id = o.vendor_id
  left join public.projects p on p.id = o.project_id
  left join public.profiles bu on bu.id = o.buyer_id
  left join lateral (
    select sum(app.line_net(l.qty, l.unit_price, l.discount_pct)) net,
           sum(app.line_net(l.qty, l.unit_price, l.discount_pct) * app.tax_rate(l.tax_code) / 100) tax
      from public.po_lines l where l.po_id = o.id) t on true;

create view public.v_po_lines with (security_invoker = on) as
select l.id, l.po_id, o.doc_no as po_no, o.status as po_status, o.order_date, o.vendor_id, v.code as vendor_code,
       v.name as vendor_name, l.project_id, p.code as project_code, pr.doc_no as pr_no,
       l.line_no, l.item_id, i.sku, i.manufacturer, i.mpn, l.description, l.qty, l.uom, l.unit_price, l.discount_pct,
       l.tax_code, o.currency_code, o.exchange_rate,
       app.line_net(l.qty, l.unit_price, l.discount_pct) as net_amount,
       round(app.line_net(l.qty, l.unit_price, l.discount_pct) * coalesce(o.exchange_rate, 1), 2) as net_amount_base,
       coalesce(l.promised_date, o.promised_date) as promised_date,
       l.received_qty, greatest(l.qty - l.received_qty, 0) as open_qty,
       (l.received_qty < l.qty and coalesce(l.promised_date, o.promised_date) < current_date
        and o.status in ('approved','ordered','partially_received')) as is_late
  from public.po_lines l
  join public.purchase_orders o on o.id = l.po_id
  join public.partners v on v.id = o.vendor_id
  left join public.projects p on p.id = l.project_id
  left join public.items i on i.id = l.item_id
  left join public.pr_lines pl on pl.id = l.pr_line_id
  left join public.purchase_requests pr on pr.id = pl.pr_id;

create view public.v_open_po_lines with (security_invoker = on) as
select * from public.v_po_lines
 where open_qty > 0 and po_status in ('approved','ordered','partially_received');

create view public.v_vendor_price_history with (security_invoker = on) as
select l.item_id, i.sku, i.name as item_name, i.manufacturer, i.mpn, o.vendor_id, v.name as vendor_name,
       o.doc_no as po_no, o.order_date, l.qty, l.unit_price, l.discount_pct, o.currency_code,
       round(l.unit_price * (1 - l.discount_pct / 100.0) * coalesce(o.exchange_rate, 1), 4) as unit_price_base
  from public.po_lines l
  join public.purchase_orders o on o.id = l.po_id
  join public.partners v on v.id = o.vendor_id
  join public.items i on i.id = l.item_id
 where o.status not in ('draft','rejected','cancelled','pending_approval');

create view public.v_vendor_performance with (security_invoker = on) as
with recv as (
  select m.po_line_id, max(m.move_date)::date as last_receipt, min(m.move_date)::date as first_receipt
    from public.stock_moves m where m.po_line_id is not null group by m.po_line_id),
lines as (
  select o.vendor_id, o.order_date, coalesce(l.promised_date, o.promised_date) as promised_date,
         l.qty, l.received_qty, r.last_receipt
    from public.po_lines l
    join public.purchase_orders o on o.id = l.po_id
    left join recv r on r.po_line_id = l.id
   where o.status not in ('draft','pending_approval','rejected','cancelled'))
select v.id as vendor_id, v.code as vendor_code, v.name as vendor_name,
       count(*) as po_lines,
       count(*) filter (where received_qty >= qty) as delivered_lines,
       count(*) filter (where received_qty >= qty and (promised_date is null or last_receipt <= promised_date)) as otif_lines,
       round(100.0 * count(*) filter (where received_qty >= qty and (promised_date is null or last_receipt <= promised_date))
             / nullif(count(*) filter (where received_qty >= qty), 0), 1) as otif_pct,
       round(avg(last_receipt - order_date) filter (where received_qty >= qty), 1) as avg_lead_time_days,
       count(*) filter (where received_qty < qty and promised_date < current_date) as late_open_lines,
       (select count(*) from public.ncrs n where n.vendor_id = v.id) as ncr_count
  from lines join public.partners v on v.id = lines.vendor_id
 group by v.id, v.code, v.name;

-- No prices: warehouse / QA / logistics receive against this view
create view public.v_po_receiving as
select l.id as po_line_id, o.id as po_id, o.doc_no as po_no, o.status as po_status, o.order_date,
       v.name as vendor_name, p.code as project_code, l.project_id,
       l.line_no, l.item_id, i.sku, i.track_lot, i.track_serial, l.description, l.qty, l.uom, l.received_qty,
       greatest(l.qty - l.received_qty, 0) as open_qty, coalesce(l.promised_date, o.promised_date) as promised_date
  from public.po_lines l
  join public.purchase_orders o on o.id = l.po_id
  join public.partners v on v.id = o.vendor_id
  left join public.projects p on p.id = l.project_id
  left join public.items i on i.id = l.item_id
 where o.status in ('approved','ordered','partially_received','received','closed')
   and (app.can('po_receiving', 'read') or app.can('po', 'read'));

-- ---------------------------------------------------------------- Warehouse
create view public.v_stock_balance with (security_invoker = on) as
with flows as (
  select item_id, to_location_id as location_id, coalesce(to_project_id, project_id) as project_id, lot_no, serial_no, qty
    from public.stock_moves where to_location_id is not null
  union all
  select item_id, from_location_id, project_id, lot_no, serial_no, -qty
    from public.stock_moves where from_location_id is not null)
select f.item_id, i.sku, i.name as item_name, i.uom, i.category, f.location_id, w.code as warehouse_code,
       lc.code as location_code, f.project_id, p.code as project_code, f.lot_no, f.serial_no, sum(f.qty) as qty
  from flows f
  join public.items i on i.id = f.item_id
  join public.locations lc on lc.id = f.location_id
  join public.warehouses w on w.id = lc.warehouse_id
  left join public.projects p on p.id = f.project_id
 group by f.item_id, i.sku, i.name, i.uom, i.category, f.location_id, w.code, lc.code, f.project_id, p.code, f.lot_no, f.serial_no
having sum(f.qty) <> 0;

create view public.v_stock_moves with (security_invoker = on) as
select m.id, m.doc_no, m.move_type, m.move_date, m.item_id, i.sku, i.name as item_name, m.qty, i.uom,
       fl.code as from_location, tl.code as to_location,
       p.code as project_code, tp.code as to_project_code, cp.code as consume_project_code,
       m.project_id, m.consume_project_id, po.doc_no as po_no, m.lot_no, m.serial_no, m.reference, m.notes,
       u.full_name as created_by_name, m.created_at
  from public.stock_moves m
  join public.items i on i.id = m.item_id
  left join public.locations fl on fl.id = m.from_location_id
  left join public.locations tl on tl.id = m.to_location_id
  left join public.projects p on p.id = m.project_id
  left join public.projects tp on tp.id = m.to_project_id
  left join public.projects cp on cp.id = m.consume_project_id
  left join public.po_lines pl on pl.id = m.po_line_id
  left join public.purchase_orders po on po.id = pl.po_id
  left join public.profiles u on u.id = m.created_by;

create view public.v_inventory_aging with (security_invoker = on) as
select b.*, r.last_receipt::date as last_receipt_date,
       (current_date - r.last_receipt::date) as age_days,
       case when r.last_receipt is null then 'unknown'
            when current_date - r.last_receipt::date <= 30 then '0-30'
            when current_date - r.last_receipt::date <= 90 then '31-90'
            when current_date - r.last_receipt::date <= 180 then '91-180'
            else '>180' end as age_bucket
  from public.v_stock_balance b
  left join lateral (
    select max(m.move_date) as last_receipt from public.stock_moves m
     where m.item_id = b.item_id and m.to_location_id = b.location_id
       and coalesce(m.to_project_id, m.project_id) is not distinct from b.project_id) r on true
 where b.qty > 0;

create view public.v_low_stock with (security_invoker = on) as
select i.id as item_id, i.sku, i.name as item_name, i.uom, i.min_stock,
       coalesce(sum(b.qty) filter (where b.project_id is null), 0) as free_qty,
       coalesce(sum(b.qty), 0) as total_qty,
       i.min_stock - coalesce(sum(b.qty) filter (where b.project_id is null), 0) as shortage_qty,
       v.name as default_vendor, i.lead_time_days
  from public.items i
  left join public.v_stock_balance b on b.item_id = i.id
  left join public.partners v on v.id = i.default_vendor_id
 where i.is_active and i.is_stocked and i.min_stock > 0
 group by i.id, i.sku, i.name, i.uom, i.min_stock, v.name, i.lead_time_days
having coalesce(sum(b.qty) filter (where b.project_id is null), 0) < i.min_stock;

-- ---------------------------------------------------------------- Quality / service
create view public.v_inspections with (security_invoker = on) as
select x.id, x.doc_no, x.inspection_type, x.result, x.inspected_at, x.project_id, p.code as project_code,
       a.node_code, i.sku, i.name as item_name, po.doc_no as po_no, v.name as vendor_name,
       x.qty_inspected, x.qty_rejected, u.full_name as inspector_name, x.customer_witness, x.notes, x.created_at
  from public.inspections x
  left join public.projects p on p.id = x.project_id
  left join public.activities a on a.id = x.activity_id
  left join public.items i on i.id = x.item_id
  left join public.po_lines pl on pl.id = x.po_line_id
  left join public.purchase_orders po on po.id = pl.po_id
  left join public.partners v on v.id = po.vendor_id
  left join public.profiles u on u.id = x.inspector_id;

create view public.v_ncrs with (security_invoker = on) as
select n.id, n.doc_no, n.created_at::date as opened_on, n.status, n.severity, n.disposition, n.title, n.description,
       n.project_id, p.code as project_code, i.sku, i.name as item_name, n.vendor_id, v.name as vendor_name,
       x.doc_no as inspection_no, n.qty, n.root_cause, n.corrective_action, n.preventive_action,
       o.full_name as owner_name, n.due_date, n.closed_at, n.cost_impact,
       case when n.status in ('closed','cancelled') then (n.closed_at::date - n.created_at::date)
            else current_date - n.created_at::date end as age_days,
       (n.status not in ('closed','cancelled') and n.due_date < current_date) as is_overdue
  from public.ncrs n
  left join public.projects p on p.id = n.project_id
  left join public.items i on i.id = n.item_id
  left join public.partners v on v.id = n.vendor_id
  left join public.inspections x on x.id = n.inspection_id
  left join public.profiles o on o.id = n.owner_id;

create view public.v_ncr_by_vendor with (security_invoker = on) as
select coalesce(vendor_name, '(internal)') as vendor_name, sku, item_name, severity,
       count(*) as ncr_count,
       count(*) filter (where status not in ('closed','cancelled')) as open_count,
       sum(coalesce(qty, 0)) as qty, sum(coalesce(cost_impact, 0)) as cost_impact,
       min(opened_on) as first_ncr, max(opened_on) as last_ncr
  from public.v_ncrs
 group by 1, 2, 3, 4;

create view public.v_compliance with (security_invoker = on) as
select c.id, c.project_id, p.code as project_code, p.market as project_market, c.market, c.code, c.title,
       c.standard_ref, c.category, c.status, u.full_name as responsible_name, c.due_date,
       d.title as document_title, d.revision as document_revision, c.evidence_note,
       v.full_name as verified_by_name, c.verified_at,
       (c.status in ('not_started','in_progress') and c.due_date < current_date) as is_overdue, c.sort
  from public.project_compliance c
  join public.projects p on p.id = c.project_id
  left join public.profiles u on u.id = c.responsible_id
  left join public.documents d on d.id = c.document_id
  left join public.profiles v on v.id = c.verified_by;

create view public.v_service_tickets with (security_invoker = on) as
select s.id, s.doc_no, s.reported_at, s.status, s.priority, s.is_warranty, s.title, s.description,
       s.project_id, p.code as project_code, c.name as customer_name, u.full_name as assignee_name,
       s.resolution, s.closed_at,
       extract(day from coalesce(s.closed_at, now()) - s.reported_at)::int as age_days
  from public.service_tickets s
  left join public.projects p on p.id = s.project_id
  left join public.partners c on c.id = s.customer_id
  left join public.profiles u on u.id = s.assignee_id;

-- ---------------------------------------------------------------- Finance (read: finance)
create view public.v_project_cost with (security_invoker = on) as
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
   group by s.project_id)
select p.id as project_id, p.code as project_code, p.name as project_name, p.status,
       round(coalesce(so.revenue, 0), 2) as contract_value_base,
       round(app.to_base_safe(coalesce(p.budget_amount, 0), coalesce(p.budget_currency, app.base_currency()), null, current_date), 2) as budget_base,
       coalesce(labor.hours, 0) as approved_hours,
       round(coalesce(labor.cost, 0), 2) as labor_cost_base,
       round(coalesce(po.committed, 0), 2) as po_committed_base,
       round(coalesce(po.received, 0), 2) as po_received_base,
       round(coalesce(labor.cost, 0) + coalesce(po.committed, 0), 2) as total_cost_base,
       round(coalesce(so.revenue, 0) - coalesce(labor.cost, 0) - coalesce(po.committed, 0), 2) as gross_margin_base
  from public.projects p
  left join labor on labor.project_id = p.id
  left join po on po.project_id = p.id
  left join so on so.project_id = p.id
 where app.can('finance', 'read');

grant select on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;
