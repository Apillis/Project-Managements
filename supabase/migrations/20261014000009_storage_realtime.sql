-- =============================================================================
-- 0009 file storage bucket (project documents) and realtime publication.
-- Object path convention: <project_id or 'general'>/<document_id>/<file name>
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('project-files', 'project-files', false, 104857600)  -- 100 MB per file
on conflict (id) do nothing;

create policy project_files_read on storage.objects for select to authenticated
  using (bucket_id = 'project-files' and app.can('documents', 'read'));
create policy project_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'project-files' and app.can('documents', 'write'));
create policy project_files_update on storage.objects for update to authenticated
  using (bucket_id = 'project-files' and app.can('documents', 'write'));
create policy project_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'project-files' and app.can('documents', 'write'));

-- Realtime: push changes of the most collaborative tables to open browsers
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['activities','approval_requests','notifications','purchase_orders','stock_moves','ncrs'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                      and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
