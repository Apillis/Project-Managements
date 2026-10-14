-- =============================================================================
-- 0010 reference data required in every environment: roles, resources,
-- default permission matrix, settings, currencies, taxes, numbering, default
-- approval matrix, IDEF0 lifecycle template, EU/US compliance templates,
-- default warehouse. Everything here is editable on the Settings page.
-- =============================================================================

insert into public.roles(code, name_en, name_vi, sort) values
  ('admin',            'Administrator',           'Quản trị hệ thống',     1),
  ('management',       'Management',              'Ban Giám đốc',          2),
  ('pmo',              'PMO / Project Manager',   'PMO / Quản lý dự án',   3),
  ('sales',            'Sales',                   'Kinh doanh',            4),
  ('engineering_lead', 'Engineering Lead',        'Trưởng nhóm Kỹ thuật',  5),
  ('engineering',      'Engineering',             'Kỹ thuật',              6),
  ('production',       'Production / Workshop',   'Sản xuất / Xưởng',      7),
  ('procurement',      'Procurement',             'Mua hàng',              8),
  ('warehouse',        'Warehouse',               'Kho',                   9),
  ('logistics',        'Logistics',               'Vận chuyển',           10),
  ('qa',               'QA / QC',                 'Đảm bảo chất lượng',   11),
  ('accounting',       'Accounting',              'Kế toán',              12),
  ('service',          'Service / Warranty',      'Dịch vụ / Bảo hành',   13);

insert into public.resources(code, module, name_en, name_vi, sort) values
  ('settings',          'admin',       'Settings',                     'Cài đặt',                      1),
  ('users',             'admin',       'Users & roles',                'Người dùng & vai trò',         2),
  ('audit',             'admin',       'Audit log',                    'Nhật ký thay đổi',             3),
  ('partners',          'master',      'Customers / vendors',          'Khách hàng / NCC',            10),
  ('items',             'master',      'Items',                        'Vật tư',                      11),
  ('quotations',        'sales',       'Quotations',                   'Báo giá',                     20),
  ('sales_orders',      'sales',       'Sales orders',                 'Đơn hàng bán (SO)',           21),
  ('projects',          'projects',    'Projects',                     'Dự án',                       30),
  ('activities',        'projects',    'Activities (IDEF0)',           'Công việc (IDEF0)',           31),
  ('timesheets',        'projects',    'Timesheets',                   'Chấm công giờ',               32),
  ('timesheet_approve', 'projects',    'Approve timesheets',           'Duyệt giờ công',              33),
  ('documents',         'engineering', 'Documents & drawings',         'Tài liệu & bản vẽ',           40),
  ('bom',               'engineering', 'BOM',                          'BOM',                         41),
  ('eco',               'engineering', 'Engineering change (ECO)',     'Thay đổi kỹ thuật (ECO)',     42),
  ('pr',                'procurement', 'Purchase requests (PR)',       'Đề nghị mua hàng (PR)',       50),
  ('po',                'procurement', 'Purchase orders (PO, prices)', 'Đơn mua hàng (PO, có giá)',   51),
  ('po_receiving',      'warehouse',   'PO receiving (no prices)',     'PO nhận hàng (ẩn giá)',       60),
  ('warehouse',         'warehouse',   'Warehouse & stock',            'Kho & tồn kho',               61),
  ('qa',                'quality',     'Inspections',                  'Kiểm tra chất lượng',         70),
  ('nc',                'quality',     'Non-conformance (NCR)',        'Sự không phù hợp (NCR)',      71),
  ('compliance',        'quality',     'Compliance dossier (CE/UL)',   'Hồ sơ tuân thủ (CE/UL)',      72),
  ('service',           'service',     'Service tickets',              'Phiếu dịch vụ',               80),
  ('finance',           'finance',     'Costs & labour rates',         'Chi phí & đơn giá giờ công',  90);

-- Default matrix (admin = all, management = read all + what is listed)
with m(role_code, resource, mode) as (values
  ('management','projects','W'), ('management','activities','W'), ('management','timesheets','W'),
  ('management','timesheet_approve','W'),
  ('pmo','partners','R'), ('pmo','items','R'), ('pmo','quotations','R'), ('pmo','sales_orders','R'),
  ('pmo','projects','W'), ('pmo','activities','W'), ('pmo','timesheets','W'), ('pmo','timesheet_approve','W'),
  ('pmo','documents','W'), ('pmo','bom','R'), ('pmo','eco','R'), ('pmo','pr','W'), ('pmo','po','R'),
  ('pmo','po_receiving','R'), ('pmo','warehouse','R'), ('pmo','qa','R'), ('pmo','nc','R'), ('pmo','compliance','R'),
  ('pmo','service','R'), ('pmo','finance','R'),
  ('sales','partners','W'), ('sales','items','R'), ('sales','quotations','W'), ('sales','sales_orders','W'),
  ('sales','projects','W'), ('sales','activities','W'), ('sales','timesheets','W'), ('sales','documents','W'),
  ('sales','eco','R'), ('sales','qa','R'), ('sales','nc','R'), ('sales','compliance','R'), ('sales','service','R'),
  ('engineering_lead','partners','R'), ('engineering_lead','items','W'), ('engineering_lead','quotations','R'),
  ('engineering_lead','sales_orders','R'), ('engineering_lead','projects','R'), ('engineering_lead','activities','W'),
  ('engineering_lead','timesheets','W'), ('engineering_lead','timesheet_approve','W'), ('engineering_lead','documents','W'),
  ('engineering_lead','bom','W'), ('engineering_lead','eco','W'), ('engineering_lead','pr','W'), ('engineering_lead','po','R'),
  ('engineering_lead','po_receiving','R'), ('engineering_lead','warehouse','R'), ('engineering_lead','qa','R'),
  ('engineering_lead','nc','W'), ('engineering_lead','compliance','W'), ('engineering_lead','service','R'),
  ('engineering','partners','R'), ('engineering','items','W'), ('engineering','projects','R'), ('engineering','activities','W'),
  ('engineering','timesheets','W'), ('engineering','documents','W'), ('engineering','bom','W'), ('engineering','eco','W'),
  ('engineering','pr','W'), ('engineering','po_receiving','R'), ('engineering','warehouse','R'), ('engineering','qa','R'),
  ('engineering','nc','W'), ('engineering','compliance','W'), ('engineering','service','R'),
  ('production','partners','R'), ('production','items','R'), ('production','projects','R'), ('production','activities','W'),
  ('production','timesheets','W'), ('production','documents','W'), ('production','bom','R'), ('production','eco','R'),
  ('production','pr','W'), ('production','po_receiving','R'), ('production','warehouse','R'), ('production','qa','W'),
  ('production','nc','W'),
  ('procurement','partners','W'), ('procurement','items','W'), ('procurement','projects','R'), ('procurement','activities','W'),
  ('procurement','timesheets','W'), ('procurement','documents','R'), ('procurement','bom','R'), ('procurement','eco','R'),
  ('procurement','pr','W'), ('procurement','po','W'), ('procurement','po_receiving','R'), ('procurement','warehouse','R'),
  ('procurement','qa','R'), ('procurement','nc','W'),
  ('warehouse','partners','R'), ('warehouse','items','W'), ('warehouse','projects','R'), ('warehouse','activities','W'),
  ('warehouse','timesheets','W'), ('warehouse','documents','R'), ('warehouse','bom','R'), ('warehouse','pr','R'),
  ('warehouse','po_receiving','R'), ('warehouse','warehouse','W'), ('warehouse','qa','R'), ('warehouse','nc','R'),
  ('logistics','partners','W'), ('logistics','items','R'), ('logistics','projects','R'), ('logistics','activities','W'),
  ('logistics','timesheets','W'), ('logistics','documents','R'), ('logistics','sales_orders','R'),
  ('logistics','po_receiving','R'), ('logistics','warehouse','R'),
  ('qa','partners','R'), ('qa','items','R'), ('qa','projects','R'), ('qa','activities','W'), ('qa','timesheets','W'),
  ('qa','documents','W'), ('qa','bom','R'), ('qa','eco','R'), ('qa','pr','R'), ('qa','po_receiving','R'),
  ('qa','warehouse','R'), ('qa','qa','W'), ('qa','nc','W'), ('qa','compliance','W'), ('qa','service','R'),
  ('accounting','partners','W'), ('accounting','items','R'), ('accounting','quotations','R'), ('accounting','sales_orders','R'),
  ('accounting','projects','R'), ('accounting','activities','R'), ('accounting','timesheets','W'),
  ('accounting','timesheet_approve','R'), ('accounting','documents','R'), ('accounting','pr','R'), ('accounting','po','R'),
  ('accounting','warehouse','R'), ('accounting','finance','W'),
  ('service','partners','R'), ('service','items','R'), ('service','projects','R'), ('service','activities','W'),
  ('service','timesheets','W'), ('service','documents','R'), ('service','bom','R'), ('service','warehouse','R'),
  ('service','qa','R'), ('service','nc','R'), ('service','compliance','R'), ('service','service','W'))
insert into public.permissions(role_code, resource, can_read, can_write)
select role_code, resource, true, mode = 'W' from m;

insert into public.app_settings(key, value, description, is_secret) values
  ('company_name',           '"Apillis"',            'Company name printed on exports', false),
  ('base_currency',          '"VND"',                'Base (accounting) currency', false),
  ('allowed_email_domains',  '["apillis.com"]',      'Only these e-mail domains may sign in (empty list = any)', false),
  ('default_tax_code',       '"VAT10"',              'Default tax code for new lines', false),
  ('default_language',       '"vi"',                 'Default UI language (vi/en)', false),
  ('receipt_tolerance_pct',  '0',                    'Allowed over-receipt against PO lines (%)', false),
  ('approval_allow_self',    'false',                'Allow a requester to approve his own document', false),
  ('working_hours_per_day',  '8',                    'Standard working hours per day', false),
  ('notify_email_enabled',   'false',                'Send e-mail notifications (needs SMTP on the notifier)', false),
  ('notify_gchat_enabled',   'false',                'Post notifications to Google Chat', false),
  ('gchat_webhook_url',      '""',                   'Google Chat incoming-webhook URL', true),
  ('app_base_url',           '"http://localhost:5173"', 'Public URL of the web app (links in e-mails)', false);

insert into public.currencies(code, name, symbol, decimals) values
  ('VND', 'Vietnamese dong', '₫', 0),
  ('USD', 'US dollar', '$', 2),
  ('EUR', 'Euro', '€', 2),
  ('JPY', 'Japanese yen', '¥', 0),
  ('CNY', 'Chinese yuan', '¥', 2),
  ('SGD', 'Singapore dollar', 'S$', 2);

insert into public.tax_codes(code, name, rate) values
  ('VAT0',   'VAT 0% (export)', 0),
  ('VAT5',   'VAT 5%', 5),
  ('VAT8',   'VAT 8%', 8),
  ('VAT10',  'VAT 10%', 10),
  ('EXEMPT', 'Not subject to VAT', 0);

insert into public.doc_sequences(doc_type, prefix) values
  ('quotation', 'QT'), ('sales_order', 'SO'), ('eco', 'ECO'), ('purchase_request', 'PR'),
  ('purchase_order', 'PO'), ('stock_move', 'SM'), ('inspection', 'QI'), ('ncr', 'NCR'), ('service_ticket', 'SV');

insert into public.approval_rules(doc_type, step_no, name, min_amount, approver_role) values
  ('quotation',        1, 'Management review',              0,         'management'),
  ('sales_order',      1, 'Management confirmation',        0,         'management'),
  ('bom',              1, 'Engineering lead release',       0,         'engineering_lead'),
  ('eco',              1, 'Engineering lead review',        0,         'engineering_lead'),
  ('eco',              2, 'Management (cost impact ≥ 20M)', 20000000,  'management'),
  ('purchase_request', 1, 'PM approval',                    0,         'pmo'),
  ('purchase_order',   1, 'Procurement review',             0,         'procurement'),
  ('purchase_order',   2, 'Management (≥ 100M)',            100000000, 'management');

insert into public.warehouses(code, name) values ('MAIN', 'Main warehouse / Kho chính');
insert into public.locations(warehouse_id, code, name)
select w.id, l.code, l.name from public.warehouses w,
  (values ('RECV', 'Receiving / Khu nhận hàng'), ('A-01', 'Rack A-01 / Kệ A-01'),
          ('QUAR', 'Quarantine / Khu cách ly'), ('PROD', 'Workshop / Xưởng')) l(code, name)
 where w.code = 'MAIN';

-- ---------------------------------------------------------------------------
-- IDEF0 lifecycle template for machine-building projects
-- icoms: 'T|label_en|label_vi'  (T = I, C, O or M)
-- ---------------------------------------------------------------------------
create or replace function app._tpl(p_tpl uuid, p_parent uuid, p_seq int, p_en text, p_vi text, p_kind text,
                                    p_role text, p_days int, p_ms boolean, p_icoms text[]) returns uuid
language plpgsql as $$
declare v uuid; x text; parts text[]; n int := 0;
begin
  insert into public.template_nodes(template_id, parent_id, seq, title_en, title_vi, kind, role_code, duration_days, is_milestone)
  values (p_tpl, p_parent, p_seq, p_en, p_vi, p_kind, p_role, p_days, p_ms) returning id into v;
  foreach x in array p_icoms loop
    parts := string_to_array(x, '|'); n := n + 1;
    insert into public.template_icoms(node_id, icom_type, label_en, label_vi, sort) values (v, parts[1], parts[2], parts[3], n);
  end loop;
  return v;
end $$;

do $$
declare t uuid; a0 uuid; p uuid;
begin
  insert into public.lifecycle_templates(code, name_en, name_vi, description, is_default)
  values ('MACHINE', 'Automation machine project', 'Dự án máy tự động',
          'RFQ → Quotation → PO → Design → Procurement → Build → FAT → Delivery/SAT → Warranty', true)
  returning id into t;

  a0 := app._tpl(t, null, 0, 'Deliver an automation machine project', 'Thực hiện dự án máy tự động', 'context', 'pmo', 0, false,
    array['I|Customer RFQ & requirements|RFQ & yêu cầu khách hàng',
          'C|Contract & customer specification|Hợp đồng & đặc tả khách hàng',
          'C|Standards (CE / UL / NFPA 79)|Tiêu chuẩn (CE / UL / NFPA 79)',
          'C|ISO 9001 procedures|Quy trình ISO 9001',
          'O|Accepted machine|Máy được nghiệm thu',
          'O|Project documentation|Hồ sơ dự án',
          'M|Apillis team|Đội ngũ Apillis', 'M|Workshop & tools|Xưởng & dụng cụ', 'M|Suppliers|Nhà cung cấp']);

  -- A1 Sales
  p := app._tpl(t, a0, 1, 'Sell & contract', 'Bán hàng & hợp đồng', 'phase', 'sales', 0, false,
    array['I|Customer RFQ|RFQ khách hàng', 'C|Pricing policy|Chính sách giá', 'O|Customer PO|PO khách hàng', 'M|Sales|Kinh doanh']);
  perform app._tpl(t, p, 1, 'Receive & clarify RFQ', 'Tiếp nhận & làm rõ RFQ', 'task', 'sales', 2, false,
    array['I|Customer RFQ|RFQ khách hàng', 'O|Clarified requirements|Yêu cầu đã làm rõ', 'M|Sales|Kinh doanh']);
  perform app._tpl(t, p, 2, 'Prepare quotation', 'Lập báo giá', 'task', 'sales', 5, false,
    array['I|Clarified requirements|Yêu cầu đã làm rõ', 'C|Pricing policy|Chính sách giá',
          'O|Approved quotation|Báo giá đã duyệt', 'M|Sales|Kinh doanh', 'M|Engineering lead|Trưởng nhóm kỹ thuật']);
  perform app._tpl(t, p, 3, 'Negotiate & receive customer PO', 'Đàm phán & nhận PO khách hàng', 'task', 'sales', 5, true,
    array['I|Approved quotation|Báo giá đã duyệt', 'O|Customer PO|PO khách hàng', 'M|Sales|Kinh doanh']);

  -- A2 Kick-off & planning
  p := app._tpl(t, a0, 2, 'Kick-off & plan project', 'Khởi động & lập kế hoạch', 'phase', 'pmo', 0, false,
    array['I|Customer PO|PO khách hàng', 'C|Contract & customer specification|Hợp đồng & đặc tả khách hàng',
          'O|Project plan|Kế hoạch dự án', 'M|PMO|PMO']);
  perform app._tpl(t, p, 1, 'Create project & sales order', 'Tạo dự án & đơn hàng bán', 'task', 'pmo', 1, false,
    array['I|Customer PO|PO khách hàng', 'O|Project & SO|Dự án & SO', 'M|PMO|PMO']);
  perform app._tpl(t, p, 2, 'Kick-off meeting', 'Họp khởi động dự án', 'task', 'pmo', 1, true,
    array['I|Project & SO|Dự án & SO', 'O|Kick-off minutes|Biên bản họp khởi động', 'M|Project team|Đội dự án']);
  perform app._tpl(t, p, 3, 'Plan schedule & resources', 'Lập tiến độ & nguồn lực', 'task', 'pmo', 2, false,
    array['I|Kick-off minutes|Biên bản họp khởi động', 'O|Project plan|Kế hoạch dự án', 'M|PMO|PMO']);

  -- A3 Design
  p := app._tpl(t, a0, 3, 'Design machine', 'Thiết kế máy', 'phase', 'engineering_lead', 0, false,
    array['I|Project plan|Kế hoạch dự án', 'C|Contract & customer specification|Hợp đồng & đặc tả khách hàng',
          'C|Standards (CE / UL / NFPA 79)|Tiêu chuẩn (CE / UL / NFPA 79)',
          'O|Released drawings|Bản vẽ đã phát hành', 'O|Approved BOM|BOM đã duyệt', 'M|Engineering|Kỹ thuật']);
  perform app._tpl(t, p, 1, 'Concept & layout', 'Ý tưởng & bố trí tổng thể', 'task', 'engineering', 5, false,
    array['I|Customer specification|Đặc tả khách hàng', 'O|Concept layout|Bố trí tổng thể', 'M|Mechanical engineer|Kỹ sư cơ khí']);
  perform app._tpl(t, p, 2, 'Mechanical design', 'Thiết kế cơ khí', 'task', 'engineering', 10, false,
    array['I|Concept layout|Bố trí tổng thể', 'O|Mechanical drawings|Bản vẽ cơ khí', 'M|Mechanical engineer|Kỹ sư cơ khí', 'M|CAD software|Phần mềm CAD']);
  perform app._tpl(t, p, 3, 'Electrical & pneumatic design', 'Thiết kế điện & khí nén', 'task', 'engineering', 10, false,
    array['I|Concept layout|Bố trí tổng thể', 'C|EN 60204-1 / NFPA 79|EN 60204-1 / NFPA 79',
          'O|Electrical drawings|Bản vẽ điện', 'M|Electrical engineer|Kỹ sư điện', 'M|E-CAD software|Phần mềm E-CAD']);
  perform app._tpl(t, p, 4, 'PLC/HMI software design', 'Thiết kế phần mềm PLC/HMI', 'task', 'engineering', 5, false,
    array['I|Concept layout|Bố trí tổng thể', 'O|Software specification|Đặc tả phần mềm', 'M|Automation engineer|Kỹ sư tự động hóa']);
  perform app._tpl(t, p, 5, 'Risk assessment', 'Đánh giá rủi ro', 'task', 'engineering_lead', 3, false,
    array['I|Concept layout|Bố trí tổng thể', 'C|ISO 12100 / ISO 13849-1|ISO 12100 / ISO 13849-1',
          'O|Risk assessment|Đánh giá rủi ro', 'M|Engineering lead|Trưởng nhóm kỹ thuật']);
  perform app._tpl(t, p, 6, 'Design review & BOM release', 'Duyệt thiết kế & phát hành BOM', 'task', 'engineering_lead', 2, true,
    array['I|Mechanical drawings|Bản vẽ cơ khí', 'I|Electrical drawings|Bản vẽ điện', 'I|Software specification|Đặc tả phần mềm',
          'C|Risk assessment|Đánh giá rủi ro', 'O|Approved BOM|BOM đã duyệt', 'O|Released drawings|Bản vẽ đã phát hành',
          'M|Engineering lead|Trưởng nhóm kỹ thuật']);

  -- A4 Procurement
  p := app._tpl(t, a0, 4, 'Procure materials', 'Mua sắm vật tư', 'phase', 'procurement', 0, false,
    array['I|Approved BOM|BOM đã duyệt', 'C|Approved vendor list|Danh sách NCC được duyệt', 'C|Project budget|Ngân sách dự án',
          'O|Accepted materials|Vật tư đạt kiểm tra', 'M|Procurement|Mua hàng', 'M|Warehouse|Kho']);
  perform app._tpl(t, p, 1, 'Raise purchase requests', 'Lập đề nghị mua hàng', 'task', 'procurement', 2, false,
    array['I|Approved BOM|BOM đã duyệt', 'O|Approved PR|PR đã duyệt', 'M|Procurement|Mua hàng']);
  perform app._tpl(t, p, 2, 'Source & issue purchase orders', 'Hỏi giá & phát hành PO', 'task', 'procurement', 5, false,
    array['I|Approved PR|PR đã duyệt', 'C|Approved vendor list|Danh sách NCC được duyệt', 'O|Approved PO|PO đã duyệt', 'M|Procurement|Mua hàng']);
  perform app._tpl(t, p, 3, 'Expedite & receive goods', 'Theo dõi & nhận hàng', 'task', 'warehouse', 20, false,
    array['I|Approved PO|PO đã duyệt', 'O|Received materials|Vật tư đã nhận', 'M|Warehouse|Kho']);
  perform app._tpl(t, p, 4, 'Incoming inspection', 'Kiểm tra đầu vào', 'task', 'qa', 3, false,
    array['I|Received materials|Vật tư đã nhận', 'C|Drawings & specifications|Bản vẽ & thông số',
          'O|Accepted materials|Vật tư đạt kiểm tra', 'M|QA/QC|QA/QC']);

  -- A5 Build
  p := app._tpl(t, a0, 5, 'Fabricate & assemble', 'Gia công & lắp ráp', 'phase', 'production', 0, false,
    array['I|Accepted materials|Vật tư đạt kiểm tra', 'C|Released drawings|Bản vẽ đã phát hành',
          'O|Assembled machine|Máy đã lắp ráp', 'M|Technicians|Kỹ thuật viên', 'M|Workshop & tools|Xưởng & dụng cụ']);
  perform app._tpl(t, p, 1, 'Machining & fabrication', 'Gia công chi tiết', 'task', 'production', 10, false,
    array['I|Accepted materials|Vật tư đạt kiểm tra', 'C|Released drawings|Bản vẽ đã phát hành',
          'O|Fabricated parts|Chi tiết đã gia công', 'M|Technicians|Kỹ thuật viên']);
  perform app._tpl(t, p, 2, 'Mechanical assembly', 'Lắp ráp cơ khí', 'task', 'production', 10, false,
    array['I|Fabricated parts|Chi tiết đã gia công', 'O|Mechanical assembly|Cụm cơ khí', 'M|Technicians|Kỹ thuật viên']);
  perform app._tpl(t, p, 3, 'Control panel build & wiring', 'Lắp tủ điện & đi dây', 'task', 'production', 7, false,
    array['I|Mechanical assembly|Cụm cơ khí', 'C|Electrical drawings|Bản vẽ điện', 'O|Wired machine|Máy đã đi dây',
          'M|Technicians|Kỹ thuật viên']);
  perform app._tpl(t, p, 4, 'In-process inspection', 'Kiểm tra trong quá trình', 'task', 'qa', 2, false,
    array['I|Wired machine|Máy đã đi dây', 'O|Assembled machine|Máy đã lắp ráp', 'M|QA/QC|QA/QC']);

  -- A6 Program & FAT
  p := app._tpl(t, a0, 6, 'Program, commission & FAT', 'Lập trình, chạy thử & FAT', 'phase', 'engineering', 0, false,
    array['I|Assembled machine|Máy đã lắp ráp', 'C|FAT protocol|Quy trình FAT', 'O|FAT-accepted machine|Máy đạt FAT',
          'M|Automation engineer|Kỹ sư tự động hóa', 'M|QA/QC|QA/QC']);
  perform app._tpl(t, p, 1, 'PLC/HMI programming', 'Lập trình PLC/HMI', 'task', 'engineering', 10, false,
    array['I|Software specification|Đặc tả phần mềm', 'O|PLC/HMI program|Chương trình PLC/HMI',
          'M|Automation engineer|Kỹ sư tự động hóa', 'M|TwinCAT / TIA Portal|TwinCAT / TIA Portal']);
  perform app._tpl(t, p, 2, 'I/O check & dry run', 'Kiểm tra I/O & chạy thử', 'task', 'engineering', 5, false,
    array['I|Assembled machine|Máy đã lắp ráp', 'I|PLC/HMI program|Chương trình PLC/HMI', 'O|Commissioned machine|Máy đã chạy thử',
          'M|Automation engineer|Kỹ sư tự động hóa']);
  perform app._tpl(t, p, 3, 'Internal pre-FAT', 'Pre-FAT nội bộ', 'task', 'qa', 2, false,
    array['I|Commissioned machine|Máy đã chạy thử', 'C|FAT protocol|Quy trình FAT', 'O|Pre-FAT report|Báo cáo pre-FAT', 'M|QA/QC|QA/QC']);
  perform app._tpl(t, p, 4, 'FAT with customer', 'FAT với khách hàng', 'task', 'qa', 2, true,
    array['I|Pre-FAT report|Báo cáo pre-FAT', 'C|FAT protocol|Quy trình FAT', 'O|FAT report|Biên bản FAT',
          'O|FAT-accepted machine|Máy đạt FAT', 'M|QA/QC|QA/QC', 'M|Customer|Khách hàng']);

  -- A7 Deliver
  p := app._tpl(t, a0, 7, 'Deliver, install & SAT', 'Giao hàng, lắp đặt & SAT', 'phase', 'logistics', 0, false,
    array['I|FAT-accepted machine|Máy đạt FAT', 'C|Machinery Directive / NFPA 79|Chỉ thị máy / NFPA 79',
          'O|Accepted machine|Máy được nghiệm thu', 'O|Project documentation|Hồ sơ dự án',
          'M|Logistics|Vận chuyển', 'M|Service|Dịch vụ']);
  perform app._tpl(t, p, 1, 'Technical file & declaration', 'Hồ sơ kỹ thuật & tuyên bố hợp chuẩn', 'task', 'engineering_lead', 3, false,
    array['I|FAT report|Biên bản FAT', 'C|Machinery Directive / NFPA 79|Chỉ thị máy / NFPA 79',
          'O|Technical file|Hồ sơ kỹ thuật', 'O|Declaration of conformity|Tuyên bố hợp chuẩn', 'M|Engineering lead|Trưởng nhóm kỹ thuật']);
  perform app._tpl(t, p, 2, 'Pack & ship', 'Đóng gói & vận chuyển', 'task', 'logistics', 5, false,
    array['I|FAT-accepted machine|Máy đạt FAT', 'C|Incoterms|Incoterms', 'O|Delivered machine|Máy đã giao', 'M|Logistics|Vận chuyển', 'M|Carrier|Đơn vị vận tải']);
  perform app._tpl(t, p, 3, 'Install & commission on site', 'Lắp đặt & chạy thử tại nhà máy', 'task', 'service', 5, false,
    array['I|Delivered machine|Máy đã giao', 'O|Installed machine|Máy đã lắp đặt', 'M|Service|Dịch vụ']);
  perform app._tpl(t, p, 4, 'SAT & handover', 'SAT & bàn giao', 'task', 'pmo', 2, true,
    array['I|Installed machine|Máy đã lắp đặt', 'I|Technical file|Hồ sơ kỹ thuật', 'O|SAT report|Biên bản SAT',
          'O|Accepted machine|Máy được nghiệm thu', 'M|PMO|PMO', 'M|Customer|Khách hàng']);

  -- A8 Warranty & close
  p := app._tpl(t, a0, 8, 'Support & close project', 'Bảo hành & đóng dự án', 'phase', 'pmo', 0, false,
    array['I|Accepted machine|Máy được nghiệm thu', 'C|Warranty terms|Điều khoản bảo hành',
          'O|Closed project|Dự án đã đóng', 'M|Service|Dịch vụ', 'M|PMO|PMO']);
  perform app._tpl(t, p, 1, 'Warranty support', 'Hỗ trợ bảo hành', 'task', 'service', 1, false,
    array['I|Accepted machine|Máy được nghiệm thu', 'C|Warranty terms|Điều khoản bảo hành', 'O|Service records|Hồ sơ dịch vụ', 'M|Service|Dịch vụ']);
  perform app._tpl(t, p, 2, 'Lessons learned & close', 'Rút kinh nghiệm & đóng dự án', 'task', 'pmo', 1, true,
    array['I|Service records|Hồ sơ dịch vụ', 'O|Closed project|Dự án đã đóng', 'O|Lessons learned|Bài học kinh nghiệm', 'M|PMO|PMO']);
end $$;

drop function app._tpl(uuid, uuid, int, text, text, text, text, int, boolean, text[]);

-- ---------------------------------------------------------------------------
-- Compliance dossier templates (verify against the current editions!)
-- ---------------------------------------------------------------------------
insert into public.compliance_templates(market, code, title_en, title_vi, standard_ref, category, sort) values
  ('EU','EU-MD',    'Conformity with Machinery Directive (Annex I EHSR checklist)', 'Phù hợp Chỉ thị Máy (checklist Phụ lục I)', '2006/42/EC', 'directive', 10),
  ('EU','EU-MR',    'Machinery Regulation transition check (applies from 20 Jan 2027)', 'Kiểm tra chuyển tiếp Quy định Máy (áp dụng từ 20/01/2027)', '(EU) 2023/1230', 'directive', 11),
  ('EU','EU-LVD',   'Low Voltage Directive assessment', 'Đánh giá Chỉ thị Điện áp thấp', '2014/35/EU', 'directive', 12),
  ('EU','EU-EMC',   'EMC Directive assessment', 'Đánh giá Chỉ thị EMC', '2014/30/EU', 'directive', 13),
  ('EU','EU-12100', 'Risk assessment & risk reduction', 'Đánh giá & giảm thiểu rủi ro', 'EN ISO 12100', 'standard', 20),
  ('EU','EU-13849', 'Safety functions — PL calculation (e.g. SISTEMA report)', 'Chức năng an toàn — tính PL (báo cáo SISTEMA)', 'EN ISO 13849-1/-2', 'standard', 21),
  ('EU','EU-60204', 'Electrical equipment of machines — verification tests', 'Thiết bị điện của máy — thử nghiệm xác nhận', 'EN 60204-1', 'standard', 22),
  ('EU','EU-4414',  'Pneumatic system safety', 'An toàn hệ thống khí nén', 'EN ISO 4414', 'standard', 23),
  ('EU','EU-TF',    'Technical construction file compiled', 'Lập hồ sơ kỹ thuật (Technical File)', '2006/42/EC Annex VII', 'document', 30),
  ('EU','EU-DOC',   'EU Declaration of Conformity signed', 'Ký Tuyên bố hợp chuẩn EU (DoC)', '2006/42/EC Annex II 1.A', 'document', 31),
  ('EU','EU-CE',    'CE marking & nameplate fixed', 'Gắn dấu CE & nhãn máy', '2006/42/EC Annex III', 'marking', 32),
  ('EU','EU-MAN',   'Instruction manual in the language of the destination country', 'Hướng dẫn sử dụng bằng ngôn ngữ nước nhận', '2006/42/EC Annex I 1.7.4', 'document', 33),
  ('US','US-NFPA79','Electrical design per NFPA 79', 'Thiết kế điện theo NFPA 79', 'NFPA 79', 'standard', 40),
  ('US','US-508A',  'Industrial control panel built per UL 508A (listed panel)', 'Tủ điều khiển theo UL 508A (tủ listed)', 'UL 508A', 'standard', 41),
  ('US','US-SCCR',  'Short-circuit current rating (SCCR) calculated & marked', 'Tính & ghi nhãn SCCR', 'UL 508A SB / NFPA 79', 'marking', 42),
  ('US','US-B11',   'Risk assessment & safeguarding', 'Đánh giá rủi ro & che chắn an toàn', 'ANSI B11.0 / B11.19', 'standard', 43),
  ('US','US-OSHA',  'Machine guarding & lockout/tagout provisions', 'Che chắn máy & khóa/treo thẻ (LOTO)', 'OSHA 29 CFR 1910.212 / 1910.147', 'standard', 44),
  ('US','US-FE',    'Field evaluation / listing by NRTL if required by the AHJ', 'Đánh giá hiện trường / chứng nhận NRTL nếu AHJ yêu cầu', 'NFPA 790/791', 'test', 45),
  ('US','US-LBL',   'Safety labels & English manual', 'Nhãn an toàn & tài liệu tiếng Anh', 'ANSI Z535', 'document', 46),
  ('CA','CA-CSA',   'Industrial control equipment per CSA', 'Thiết bị điều khiển công nghiệp theo CSA', 'CSA C22.2 No. 14', 'standard', 50),
  ('GLOBAL','GL-FAT',  'FAT protocol & signed FAT report', 'Quy trình FAT & biên bản FAT đã ký', 'Contract', 'test', 90),
  ('GLOBAL','GL-SAT',  'SAT report signed by the customer', 'Biên bản SAT có chữ ký khách hàng', 'Contract', 'test', 91),
  ('GLOBAL','GL-TRC',  'Material traceability (lot/serial) records', 'Hồ sơ truy xuất vật tư (lot/serial)', 'ISO 9001 §8.5.2', 'document', 92),
  ('GLOBAL','GL-CAL',  'Calibration certificates of measuring instruments', 'Chứng chỉ hiệu chuẩn thiết bị đo', 'ISO 9001 §7.1.5', 'document', 93),
  ('GLOBAL','GL-SPR',  'Spare parts & wear parts list', 'Danh mục phụ tùng thay thế', 'Contract', 'document', 94),
  ('GLOBAL','GL-TRN',  'Operator & maintenance training record', 'Biên bản đào tạo vận hành & bảo trì', 'Contract', 'training', 95);
