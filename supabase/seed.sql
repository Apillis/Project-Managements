-- Demo data for the desktop test environment only (supabase start / db reset).
-- Production starts empty and is filled through the Import page.

insert into public.exchange_rates(currency_code, rate_date, rate_to_base) values
  ('USD', current_date - 1, 26300),   -- demo values: maintain real rates in Settings
  ('EUR', current_date - 1, 30500)
on conflict do nothing;

insert into public.partners(code, name, is_customer, is_vendor, is_carrier, country, currency_code, payment_terms, incoterm, email) values
  ('C-ACME',   'ACME Automotive GmbH (demo)',      true,  false, false, 'DE', 'EUR', '30% advance, 70% after FAT', 'FCA', 'purchasing@acme.example'),
  ('C-NOVA',   'Nova Medical Devices Inc. (demo)', true,  false, false, 'US', 'USD', 'Net 45', 'EXW', 'ops@nova.example'),
  ('V-FESTO',  'Festo Vietnam (demo)',             false, true,  false, 'VN', 'VND', 'Net 30', 'DAP', 'sales@festo.example'),
  ('V-BECK',   'Beckhoff Automation VN (demo)',    false, true,  false, 'VN', 'VND', 'Net 30', 'DAP', 'sales@beckhoff.example'),
  ('V-MOUSER', 'Mouser Electronics (demo)',        false, true,  false, 'US', 'USD', 'Prepaid', 'DAP', 'sales@mouser.example'),
  ('T-DHL',    'DHL Global Forwarding (demo)',     false, false, true,  'VN', 'VND', 'Net 15', null, 'ops@dhl.example')
on conflict (code) do nothing;

insert into public.items(sku, name, manufacturer, mpn, category, item_type, uom, track_lot, track_serial, min_stock, lead_time_days) values
  ('BK-CX7000',   'Embedded PC CX7000 TwinCAT 3',  'Beckhoff', 'CX7000-0000',  'Controller', 'part', 'pcs', false, true,  0, 28),
  ('BK-EL1008',   'EtherCAT terminal 8DI 24V',     'Beckhoff', 'EL1008',       'I/O',        'part', 'pcs', false, false, 4, 21),
  ('BK-EL2008',   'EtherCAT terminal 8DO 24V',     'Beckhoff', 'EL2008',       'I/O',        'part', 'pcs', false, false, 4, 21),
  ('FE-DSBC32',   'Cylinder DSBC-32-100-PPVA-N3',  'Festo',    '1376425',      'Pneumatic',  'part', 'pcs', false, false, 2, 14),
  ('FE-VUVG-L14', 'Solenoid valve VUVG-L14-M52',   'Festo',    '8031596',      'Pneumatic',  'part', 'pcs', false, false, 2, 14),
  ('SICK-W4',     'Photoelectric sensor W4S-3',    'SICK',     'WTB4S-3P2161', 'Sensor',     'part', 'pcs', false, false, 5, 10),
  ('AL-6061-PL10','Aluminium plate 6061 t=10',     null,       null,           'Raw material','material','kg', true, false, 20, 7),
  ('CB-LIYY-0.75','Control cable LiYY 4x0.75',     'Lapp',     '0028304',      'Cable',      'consumable', 'm', false, false, 100, 7)
on conflict (sku) do nothing;

insert into public.projects(code, name, customer_id, market, standards, start_date, due_date, status, description)
select 'DEMO-001', 'Demo: screw test machine for EU customer', p.id, 'EU', array['CE','EN 60204-1','ISO 13849-1'],
       current_date, current_date + 120, 'planning', 'Demo project — open it and click "Create from life-cycle template".'
  from public.partners p where p.code = 'C-ACME'
on conflict (code) do nothing;
