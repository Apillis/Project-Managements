-- =============================================================================
-- 0018 (v1.2) reference data: permission resources and default matrix for
-- material requests, logistics, invoices and payments; numbering; approval
-- rule; settings; realtime.
-- =============================================================================

insert into public.resources(code, module, name_en, name_vi, sort) values
  ('mr',        'warehouse', 'Material requests (issue to project)', 'Phiếu yêu cầu vật tư (xuất cho dự án)', 62),
  ('logistics', 'logistics', 'Shipments & freight cost',             'Vận chuyển & cước phí',                 65),
  ('invoices',  'finance',   'Billing milestones & invoices',        'Mốc thanh toán & hoá đơn',              91),
  ('payments',  'finance',   'Payments (cash in / out)',             'Thu / chi tiền',                        92);

with m(role_code, resource, mode) as (values
  ('pmo','mr','W'), ('engineering_lead','mr','W'), ('engineering','mr','W'), ('production','mr','W'), ('service','mr','W'),
  ('warehouse','mr','R'), ('qa','mr','R'), ('procurement','mr','R'), ('logistics','mr','R'), ('accounting','mr','R'),
  ('logistics','logistics','W'), ('pmo','logistics','R'), ('sales','logistics','R'), ('warehouse','logistics','R'),
  ('procurement','logistics','R'), ('production','logistics','R'), ('service','logistics','R'), ('accounting','logistics','R'),
  ('accounting','invoices','W'), ('sales','invoices','R'), ('pmo','invoices','R'),
  ('accounting','payments','W'), ('pmo','payments','R'),
  ('logistics','sales_orders','R'))
insert into public.permissions(role_code, resource, can_read, can_write)
select role_code, resource, true, mode = 'W' from m
on conflict (role_code, resource) do nothing;

insert into public.doc_sequences(doc_type, prefix) values
  ('material_request', 'MR'), ('shipment', 'SH'), ('invoice', 'INV'), ('payment', 'PAY');

insert into public.approval_rules(doc_type, step_no, name, min_amount, approver_role) values
  ('material_request', 1, 'PM approval', 0, 'pmo');

insert into public.app_settings(key, value, description) values
  ('issue_requires_request', 'false', 'Stock issues must reference an approved material request'),
  ('default_payment_days',   '30',    'Days from invoice date to due date when the invoice has none'),
  ('project_close_strict',   'true',  'Refuse to close a project while the closure checklist has open items'),
  ('digest_enabled',         'true',  'Send the daily reminder digest (overdue tasks, approvals, late POs …)'),
  ('digest_hour',            '7',     'Hour (local time) after which the daily digest is sent'),
  ('timezone',               '"Asia/Ho_Chi_Minh"', 'Time zone of the company (daily digest)'),
  ('approval_reminder_days', '2',     'Remind approvers about documents waiting longer than this (days)');

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['material_requests','shipments','invoices'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                      and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
