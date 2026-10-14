-- =============================================================================
-- 0007 Row Level Security. Every table in public has RLS ON. Generic tables are
-- mapped to a "resource" of the permission matrix; special tables get custom
-- policies. anon gets nothing.
-- =============================================================================

create or replace function app.apply_resource_policies(p_table text, p_resource text,
                                                        p_insert boolean default true,
                                                        p_update boolean default true,
                                                        p_delete boolean default true)
returns void language plpgsql as $$
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('create policy %I on public.%I for select to authenticated using (app.can(%L, ''read''))',
                 p_table || '_sel', p_table, p_resource);
  if p_insert then
    execute format('create policy %I on public.%I for insert to authenticated with check (app.can(%L, ''write''))',
                   p_table || '_ins', p_table, p_resource);
  end if;
  if p_update then
    execute format('create policy %I on public.%I for update to authenticated using (app.can(%L, ''write'')) with check (app.can(%L, ''write''))',
                   p_table || '_upd', p_table, p_resource, p_resource);
  end if;
  if p_delete then
    execute format('create policy %I on public.%I for delete to authenticated using (app.can(%L, ''write''))',
                   p_table || '_del', p_table, p_resource);
  end if;
end $$;

select app.apply_resource_policies('partners', 'partners');
select app.apply_resource_policies('items', 'items');
select app.apply_resource_policies('warehouses', 'warehouse');
select app.apply_resource_policies('locations', 'warehouse');
select app.apply_resource_policies('quotations', 'quotations');
select app.apply_resource_policies('quotation_lines', 'quotations');
select app.apply_resource_policies('sales_orders', 'sales_orders');
select app.apply_resource_policies('sales_order_lines', 'sales_orders');
select app.apply_resource_policies('projects', 'projects');
select app.apply_resource_policies('project_members', 'projects');
select app.apply_resource_policies('activities', 'activities');
select app.apply_resource_policies('activity_icoms', 'activities');
select app.apply_resource_policies('lifecycle_templates', 'settings');
select app.apply_resource_policies('template_nodes', 'settings');
select app.apply_resource_policies('template_icoms', 'settings');
select app.apply_resource_policies('compliance_templates', 'settings');
select app.apply_resource_policies('documents', 'documents');
select app.apply_resource_policies('boms', 'bom');
select app.apply_resource_policies('bom_lines', 'bom');
select app.apply_resource_policies('ecos', 'eco');
select app.apply_resource_policies('purchase_requests', 'pr');
select app.apply_resource_policies('pr_lines', 'pr');
select app.apply_resource_policies('purchase_orders', 'po');
select app.apply_resource_policies('po_lines', 'po');
select app.apply_resource_policies('stock_moves', 'warehouse', true, false, false);
select app.apply_resource_policies('inspections', 'qa');
select app.apply_resource_policies('ncrs', 'nc');
select app.apply_resource_policies('project_compliance', 'compliance');
select app.apply_resource_policies('service_tickets', 'service');
select app.apply_resource_policies('approval_rules', 'settings');
select app.apply_resource_policies('roles', 'settings');
select app.apply_resource_policies('resources', 'settings');
select app.apply_resource_policies('permissions', 'settings');
select app.apply_resource_policies('currencies', 'settings');
select app.apply_resource_policies('exchange_rates', 'settings');
select app.apply_resource_policies('tax_codes', 'settings');
select app.apply_resource_policies('doc_sequences', 'settings');

-- Reference tables every signed-in user must read (drop-downs, matrix)
do $$
declare t text;
begin
  foreach t in array array['roles','resources','permissions','currencies','exchange_rates','tax_codes',
                           'doc_sequences','approval_rules','lifecycle_templates','template_nodes',
                           'template_icoms','compliance_templates','locations','warehouses'] loop
    execute format('drop policy %I on public.%I', t || '_sel', t);
    execute format('create policy %I on public.%I for select to authenticated using (auth.uid() is not null)', t || '_sel', t);
  end loop;
end $$;

-- labour rates: finance
alter table public.labor_rates enable row level security;
create policy labor_rates_sel on public.labor_rates for select to authenticated using (app.can('finance','read'));
create policy labor_rates_all on public.labor_rates for all to authenticated
  using (app.can('finance','write') or app.can('settings','write'))
  with check (app.can('finance','write') or app.can('settings','write'));

-- settings: secrets only for settings writers
alter table public.app_settings enable row level security;
create policy app_settings_sel on public.app_settings for select to authenticated
  using (not is_secret or app.can('settings','write'));
create policy app_settings_write on public.app_settings for all to authenticated
  using (app.can('settings','write')) with check (app.can('settings','write'));

-- profiles
alter table public.profiles enable row level security;
create policy profiles_sel on public.profiles for select to authenticated using (auth.uid() is not null);
create policy profiles_upd on public.profiles for update to authenticated
  using (id = auth.uid() or app.can('users','write'))
  with check (id = auth.uid() or app.can('users','write'));

alter table public.user_roles enable row level security;
create policy user_roles_sel on public.user_roles for select to authenticated using (auth.uid() is not null);
create policy user_roles_write on public.user_roles for all to authenticated
  using (app.can('users','write')) with check (app.can('users','write'));

-- Keep at least one admin
create or replace function app.trg_keep_admin() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.role_code = 'admin' and not exists (
       select 1 from public.user_roles where role_code = 'admin' and user_id <> old.user_id) then
    raise exception 'At least one administrator must remain' using errcode = 'P0001';
  end if;
  return old;
end $$;
create trigger user_roles_keep_admin before delete on public.user_roles
  for each row execute function app.trg_keep_admin();

-- timesheets: own rows, approvers, finance
alter table public.timesheets enable row level security;
create policy timesheets_sel on public.timesheets for select to authenticated
  using (user_id = auth.uid() or app.can('timesheet_approve','read') or app.can('finance','read'));
create policy timesheets_ins on public.timesheets for insert to authenticated
  with check (user_id = auth.uid() and app.can('timesheets','write'));
create policy timesheets_upd on public.timesheets for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy timesheets_del on public.timesheets for delete to authenticated
  using (user_id = auth.uid());

-- approvals: visible to whoever can read the document, the requester or an approver
create or replace function app.can_see_request(p_request_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.approval_requests r
     where r.id = p_request_id
       and (app.can(app.doc_resource(r.doc_type), 'read') or r.requested_by = auth.uid()
            or exists (select 1 from public.approval_steps s where s.request_id = r.id
                        and (s.approver_user_id = auth.uid() or app.has_role(s.approver_role)))))
$$;

alter table public.approval_requests enable row level security;
create policy approval_requests_sel on public.approval_requests for select to authenticated
  using (app.can_see_request(id));
alter table public.approval_steps enable row level security;
create policy approval_steps_sel on public.approval_steps for select to authenticated
  using (app.can_see_request(request_id));

alter table public.audit_log enable row level security;
create policy audit_log_sel on public.audit_log for select to authenticated using (app.can('audit','read'));

alter table public.notifications enable row level security;
create policy notifications_sel on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_upd on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_del on public.notifications for delete to authenticated using (user_id = auth.uid());

alter table public.notification_outbox enable row level security;   -- service role only

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema app to authenticated, service_role;
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema app from anon, public;
grant execute on all functions in schema app to authenticated, service_role;
