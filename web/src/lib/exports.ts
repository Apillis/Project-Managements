// Excel export catalogue — which data each department can pull into Excel,
// with which filters. Every export runs with the user's own token, so RLS
// limits rows/columns exactly as on screen.
import { E } from './resources';

export type XType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'percent' | 'bool' | 'status' | 'enum';

export interface XColumn {
  key: string;
  label: string;          // i18n key
  type?: XType;
  enumKey?: string;
  width?: number;
}

export interface ExportSpec {
  key: string;
  module: 'sales' | 'projects' | 'engineering' | 'procurement' | 'warehouse' | 'quality' | 'service' | 'finance' | 'master';
  title: string;          // i18n key
  purpose: string;        // i18n key: why this export exists
  kind: 'list' | 'analysis';
  source: string;         // view / table
  resource: string;       // permission resource needed to read
  projectColumn?: string;
  dateColumn?: string;
  statusColumn?: string;
  statuses?: readonly string[];
  orderBy?: { column: string; asc?: boolean }[];
  columns: XColumn[];
}

const c = (key: string, label: string, type?: XType, extra: Partial<XColumn> = {}): XColumn => ({ key, label, type, ...extra });

export const EXPORTS: ExportSpec[] = [
  // ------------------------------------------------------------------ sales
  {
    key: 'quotations', module: 'sales', kind: 'list', title: 'x.quotations', purpose: 'xp.quotations',
    source: 'v_quotations', resource: 'quotations', dateColumn: 'quote_date', statusColumn: 'status', statuses: E.quotationStatus,
    orderBy: [{ column: 'quote_date', asc: false }],
    columns: [c('doc_no', 'f.doc_no'), c('quote_date', 'f.quote_date', 'date'), c('customer_code', 'f.customer_code'),
      c('customer_name', 'f.customer'), c('title', 'f.title'), c('market', 'f.market'), c('currency_code', 'f.currency_code'),
      c('net_amount', 'f.net_amount', 'money'), c('tax_amount', 'f.tax_amount', 'money'), c('total_amount', 'f.total_amount', 'money'),
      c('net_amount_base', 'f.net_amount_base', 'money'), c('probability', 'f.probability', 'percent'),
      c('expected_close', 'f.expected_close', 'date'), c('status', 'f.status', 'status'), c('sales_owner', 'f.sales_owner'),
      c('lost_reason', 'f.lost_reason')],
  },
  {
    key: 'sales_pipeline', module: 'sales', kind: 'analysis', title: 'x.sales_pipeline', purpose: 'xp.sales_pipeline',
    source: 'v_sales_pipeline', resource: 'quotations', dateColumn: 'month', statusColumn: 'status', statuses: E.quotationStatus,
    orderBy: [{ column: 'month' }, { column: 'customer_name' }],
    columns: [c('month', 'f.month', 'date'), c('customer_name', 'f.customer'), c('sales_owner', 'f.sales_owner'), c('market', 'f.market'),
      c('status', 'f.status', 'status'), c('quotations', 'f.count', 'number'), c('net_amount_base', 'f.net_amount_base', 'money'),
      c('weighted_amount_base', 'f.weighted_amount_base', 'money'), c('won', 'f.won', 'number'), c('lost', 'f.lost', 'number')],
  },
  {
    key: 'cost_estimates', module: 'sales', kind: 'list', title: 'x.cost_estimates', purpose: 'xp.cost_estimates',
    source: 'v_cost_estimates', resource: 'costing', projectColumn: 'project_id', dateColumn: 'created_at',
    statusColumn: 'status', statuses: E.estimateStatus, orderBy: [{ column: 'created_at', asc: false }],
    columns: [c('doc_no', 'f.doc_no'), c('title', 'f.title', 'text', { width: 36 }), c('project_code', 'f.project'),
      c('bom_revision', 'f.revision'), c('build_qty', 'f.build_qty', 'number'), c('build_location', 'f.build_location'),
      c('b_material_cost', 'ce.B', 'money'), c('c_labor_cost', 'ce.C', 'money'), c('d_apillis_cost', 'ce.D', 'money'),
      c('e_material_with_markup', 'ce.E', 'money'), c('f_subtotal', 'ce.F', 'money'), c('g_vat', 'ce.G', 'money'),
      c('h_fees_logistics', 'ce.H', 'money'), c('k_sale_price_base', 'ce.K', 'money'), c('l_sale_price_moq_base', 'ce.L', 'money'),
      c('currency_code', 'f.quote_currency'), c('unit_sale_price', 'f.unit_sale_price', 'money'), c('total_sale_price', 'f.total_sale_price', 'money'),
      c('gross_margin_base', 'f.gross_margin_base', 'money'), c('labor_hours', 'f.labor_hours', 'number'),
      c('missing_prices', 'f.missing_prices', 'number'), c('max_lead_time', 'f.max_lead_time', 'number'),
      c('quotation_no', 'f.quotation'), c('status', 'f.status', 'status')],
  },
  {
    key: 'cost_estimate_lines', module: 'sales', kind: 'list', title: 'x.cost_estimate_lines', purpose: 'xp.cost_estimate_lines',
    source: 'v_cost_estimate_lines', resource: 'costing', orderBy: [{ column: 'estimate_id' }, { column: 'line_no' }],
    columns: [c('line_no', 'f.line_no', 'number'), c('find_no', 'f.find_no'), c('customer_part_no', 'f.customer_part_no'),
      c('erp_code', 'f.erp_code'), c('description', 'f.description', 'text', { width: 36 }), c('manufacturer', 'f.manufacturer'), c('mpn', 'f.mpn'),
      c('part_type', 'f.part_type', 'enum', { enumKey: 'partType' }), c('per_unit_qty', 'f.qty_per_unit', 'number'),
      c('required_qty', 'f.required_qty', 'number'), c('purchase_qty', 'f.purchase_qty', 'number'), c('uom', 'f.uom'),
      c('unit_cost', 'f.unit_cost', 'money'), c('currency_code', 'f.currency_code'), c('unit_cost_base', 'f.unit_cost_base', 'money'),
      c('vendor_name', 'f.vendor'), c('price_source', 'f.price_source', 'enum', { enumKey: 'priceSource' }),
      c('lead_time_days', 'f.lead_time_days', 'number'), c('material_base', 'f.material_base', 'money'),
      c('moq_extra_base', 'f.moq_extra_base', 'money'), c('import_tax_base', 'f.import_tax_base', 'money'),
      c('shipping_cost', 'f.shipping_cost', 'money'), c('missing_price', 'f.missing_price', 'bool')],
  },
  {
    key: 'sales_orders', module: 'sales', kind: 'list', title: 'x.sales_orders', purpose: 'xp.sales_orders',
    source: 'v_sales_orders', resource: 'sales_orders', projectColumn: 'project_id', dateColumn: 'order_date',
    statusColumn: 'status', statuses: E.soStatus, orderBy: [{ column: 'order_date', asc: false }],
    columns: [c('doc_no', 'f.doc_no'), c('order_date', 'f.order_date', 'date'), c('customer_name', 'f.customer'),
      c('customer_po_no', 'f.customer_po_no'), c('quotation_no', 'f.quotation'), c('project_code', 'f.project'),
      c('delivery_date', 'f.delivery_date', 'date'), c('currency_code', 'f.currency_code'), c('net_amount', 'f.net_amount', 'money'),
      c('total_amount', 'f.total_amount', 'money'), c('net_amount_base', 'f.net_amount_base', 'money'), c('status', 'f.status', 'status')],
  },
  // ------------------------------------------------------------------ projects
  {
    key: 'projects', module: 'projects', kind: 'list', title: 'x.projects', purpose: 'xp.projects',
    source: 'v_projects', resource: 'projects', projectColumn: 'id', dateColumn: 'start_date', statusColumn: 'status',
    statuses: E.projectStatus, orderBy: [{ column: 'code' }],
    columns: [c('code', 'f.project_code'), c('name', 'f.name'), c('customer_name', 'f.customer'), c('market', 'f.market'),
      c('pm_name', 'f.pm'), c('engineering_lead_name', 'f.engineering_lead'), c('start_date', 'f.start_date', 'date'),
      c('due_date', 'f.due_date', 'date'), c('progress_pct', 'f.progress', 'percent'), c('overdue_tasks', 'f.overdue_tasks', 'number'),
      c('open_ncrs', 'f.open_ncrs', 'number'), c('open_compliance_items', 'f.open_compliance_items', 'number'),
      c('is_late', 'f.is_late', 'bool'), c('status', 'f.status', 'status')],
  },
  {
    key: 'activities', module: 'projects', kind: 'list', title: 'x.activities', purpose: 'xp.activities',
    source: 'v_activities', resource: 'activities', projectColumn: 'project_id', dateColumn: 'planned_end', statusColumn: 'status',
    statuses: E.activityStatus, orderBy: [{ column: 'project_code' }, { column: 'node_code' }],
    columns: [c('project_code', 'f.project'), c('node_code', 'f.node_code'), c('title', 'f.title', 'text', { width: 40 }),
      c('kind', 'f.kind', 'enum', { enumKey: 'activityKind' }), c('assignee_name', 'f.assignee'),
      c('role_code', 'f.role', 'enum', { enumKey: 'role' }), c('planned_start', 'f.planned_start', 'date'),
      c('planned_end', 'f.planned_end', 'date'), c('actual_start', 'f.actual_start', 'date'), c('actual_end', 'f.actual_end', 'date'),
      c('est_hours', 'f.est_hours', 'number'), c('logged_hours', 'f.logged_hours', 'number'), c('progress_pct', 'f.progress', 'percent'),
      c('status', 'f.status', 'status'), c('days_overdue', 'f.days_overdue', 'number'),
      c('inputs', 'icom.I', 'text', { width: 30 }), c('controls', 'icom.C', 'text', { width: 30 }),
      c('outputs', 'icom.O', 'text', { width: 30 }), c('mechanisms', 'icom.M', 'text', { width: 30 })],
  },
  {
    key: 'overdue_activities', module: 'projects', kind: 'analysis', title: 'x.overdue_activities', purpose: 'xp.overdue_activities',
    source: 'v_overdue_activities', resource: 'activities', projectColumn: 'project_id', dateColumn: 'planned_end',
    orderBy: [{ column: 'days_overdue', asc: false }],
    columns: [c('project_code', 'f.project'), c('node_code', 'f.node_code'), c('title', 'f.title'), c('assignee_name', 'f.assignee'),
      c('planned_end', 'f.planned_end', 'date'), c('days_overdue', 'f.days_overdue', 'number'), c('progress_pct', 'f.progress', 'percent'),
      c('status', 'f.status', 'status')],
  },
  {
    key: 'timesheets', module: 'projects', kind: 'list', title: 'x.timesheets', purpose: 'xp.timesheets',
    source: 'v_timesheets', resource: 'timesheets', projectColumn: 'project_id', dateColumn: 'work_date', statusColumn: 'status',
    statuses: E.timesheetStatus, orderBy: [{ column: 'work_date' }, { column: 'user_name' }],
    columns: [c('work_date', 'f.work_date', 'date'), c('user_name', 'f.user'), c('project_code', 'f.project'),
      c('node_code', 'f.node_code'), c('activity_title', 'f.activity'), c('hours', 'f.hours', 'number'),
      c('description', 'f.description'), c('status', 'f.status', 'status'), c('decided_by_name', 'f.decided_by')],
  },
  {
    key: 'timesheet_summary', module: 'projects', kind: 'analysis', title: 'x.timesheet_summary', purpose: 'xp.timesheet_summary',
    source: 'v_timesheet_summary', resource: 'timesheets', dateColumn: 'month',
    orderBy: [{ column: 'month' }, { column: 'project_code' }, { column: 'user_name' }],
    columns: [c('month', 'f.month', 'date'), c('project_code', 'f.project'), c('user_name', 'f.user'),
      c('hours', 'f.hours', 'number'), c('approved_hours', 'f.approved_hours', 'number')],
  },
  // ------------------------------------------------------------------ engineering
  {
    key: 'bom_lines', module: 'engineering', kind: 'list', title: 'x.bom_lines', purpose: 'xp.bom_lines',
    source: 'v_bom_lines', resource: 'bom', projectColumn: 'project_id', statusColumn: 'bom_status', statuses: E.bomStatus,
    orderBy: [{ column: 'project_code' }, { column: 'revision' }, { column: 'line_no' }],
    columns: [c('project_code', 'f.project'), c('bom_name', 'f.bom'), c('revision', 'f.revision'), c('bom_status', 'f.status', 'status'),
      c('line_no', 'f.line_no', 'number'), c('position', 'f.position'), c('sku', 'f.sku'), c('description', 'f.description', 'text', { width: 40 }),
      c('manufacturer', 'f.manufacturer'), c('mpn', 'f.mpn'), c('qty', 'f.qty', 'number'), c('uom', 'f.uom'),
      c('discipline', 'f.discipline', 'enum', { enumKey: 'discipline' }), c('make_or_buy', 'f.make_or_buy', 'enum', { enumKey: 'makeOrBuy' }),
      c('notes', 'f.notes')],
  },
  {
    key: 'bom_tree', module: 'engineering', kind: 'list', title: 'x.bom_tree', purpose: 'xp.bom_tree',
    source: 'v_bom_tree', resource: 'bom', projectColumn: 'project_id', statusColumn: 'bom_status', statuses: E.bomStatus,
    orderBy: [{ column: 'project_code' }, { column: 'revision' }, { column: 'sort_path' }],
    columns: [c('project_code', 'f.project'), c('bom_name', 'f.bom'), c('revision', 'f.revision'), c('level', 'f.level', 'number'),
      c('find_no', 'f.find_no'), c('customer_part_no', 'f.customer_part_no'), c('customer_rev', 'f.customer_rev'),
      c('erp_code', 'f.erp_code'), c('sku', 'f.sku'), c('description', 'f.description', 'text', { width: 40 }),
      c('qty', 'f.qty_per', 'number'), c('required_qty', 'f.required_qty', 'number'), c('uom', 'f.uom'),
      c('part_type', 'f.part_type', 'enum', { enumKey: 'partType' }), c('make_or_buy', 'f.make_or_buy', 'enum', { enumKey: 'makeOrBuy' }),
      c('manufacturer', 'f.manufacturer'), c('mpn', 'f.mpn'), c('position', 'f.position'), c('drawing_url', 'f.drawing_url'),
      c('notes', 'f.notes')],
  },
  {
    key: 'bom_flat', module: 'engineering', kind: 'analysis', title: 'x.bom_flat', purpose: 'xp.bom_flat',
    source: 'v_bom_flat', resource: 'bom', projectColumn: 'project_id', statusColumn: 'bom_status', statuses: E.bomStatus,
    orderBy: [{ column: 'project_code' }, { column: 'revision' }, { column: 'sku' }],
    columns: [c('project_code', 'f.project'), c('bom_name', 'f.bom'), c('revision', 'f.revision'), c('erp_code', 'f.erp_code'),
      c('sku', 'f.sku'), c('customer_part_no', 'f.customer_part_no'), c('description', 'f.description', 'text', { width: 40 }),
      c('manufacturer', 'f.manufacturer'), c('mpn', 'f.mpn'), c('part_type', 'f.part_type', 'enum', { enumKey: 'partType' }),
      c('per_unit_qty', 'f.qty_per_unit', 'number'), c('required_qty', 'f.required_qty', 'number'), c('uom', 'f.uom'),
      c('line_count', 'f.line_count', 'number'), c('find_nos', 'f.find_nos')],
  },
  {
    key: 'bom_net_requirement', module: 'procurement', kind: 'analysis', title: 'x.bom_net_requirement', purpose: 'xp.bom_net_requirement',
    source: 'v_bom_net_requirement', resource: 'bom', projectColumn: 'project_id', statusColumn: 'bom_status', statuses: E.bomStatus,
    orderBy: [{ column: 'project_code' }, { column: 'revision' }, { column: 'sort_path' }],
    columns: [c('project_code', 'f.project'), c('revision', 'f.revision'), c('find_no', 'f.find_no'), c('erp_code', 'f.erp_code'),
      c('sku', 'f.sku'), c('description', 'f.description', 'text', { width: 40 }), c('mpn', 'f.mpn'), c('uom', 'f.uom'),
      c('required_qty', 'f.required_qty', 'number'), c('requested_qty', 'f.requested_qty', 'number'), c('ordered_qty', 'f.ordered_qty', 'number'),
      c('reserved_qty', 'f.reserved_qty', 'number'), c('remaining_qty', 'f.remaining_qty', 'number'), c('free_stock', 'f.free_stock', 'number'),
      c('project_stock', 'f.project_stock', 'number'), c('net_qty', 'f.net_qty', 'number'), c('moq', 'f.moq', 'number'),
      c('order_multiple', 'f.order_multiple', 'number'), c('suggested_order_qty', 'f.suggested_order_qty', 'number'),
      c('lead_time_days', 'f.lead_time_days', 'number')],
  },
  {
    key: 'bom_vs_actual', module: 'engineering', kind: 'analysis', title: 'x.bom_vs_actual', purpose: 'xp.bom_vs_actual',
    source: 'v_bom_vs_actual', resource: 'bom', projectColumn: 'project_id', orderBy: [{ column: 'project_code' }, { column: 'sku' }],
    columns: [c('project_code', 'f.project'), c('sku', 'f.sku'), c('description', 'f.description', 'text', { width: 40 }), c('uom', 'f.uom'),
      c('bom_qty', 'f.bom_qty', 'number'), c('requested_qty', 'f.requested_qty', 'number'), c('ordered_qty', 'f.ordered_qty', 'number'),
      c('received_qty', 'f.received_qty', 'number'), c('issued_qty', 'f.issued_qty', 'number'), c('returned_qty', 'f.returned_qty', 'number'),
      c('consumed_qty', 'f.consumed_qty', 'number'), c('variance_qty', 'f.variance_qty', 'number'), c('variance_pct', 'f.variance_pct', 'percent')],
  },
  {
    key: 'ecos', module: 'engineering', kind: 'list', title: 'x.ecos', purpose: 'xp.ecos',
    source: 'v_ecos', resource: 'eco', projectColumn: 'project_id', dateColumn: 'created_at', statusColumn: 'status', statuses: E.ecoStatus,
    orderBy: [{ column: 'created_at', asc: false }],
    columns: [c('doc_no', 'f.doc_no'), c('project_code', 'f.project'), c('title', 'f.title'), c('reason', 'f.reason', 'enum', { enumKey: 'ecoReason' }),
      c('impact_cost', 'f.impact_cost', 'money'), c('impact_currency', 'f.currency_code'), c('impact_days', 'f.impact_days', 'number'),
      c('from_revision', 'f.from_revision'), c('new_revision', 'f.new_revision'), c('status', 'f.status', 'status'),
      c('created_by_name', 'f.created_by'), c('created_at', 'f.created_at', 'datetime')],
  },
  {
    key: 'documents', module: 'engineering', kind: 'list', title: 'x.documents', purpose: 'xp.documents',
    source: 'v_documents', resource: 'documents', projectColumn: 'project_id', dateColumn: 'created_at', statusColumn: 'status',
    statuses: E.docStatus, orderBy: [{ column: 'project_code' }, { column: 'category' }, { column: 'doc_no' }],
    columns: [c('project_code', 'f.project'), c('category', 'f.category', 'enum', { enumKey: 'docCategory' }), c('doc_no', 'f.drawing_no'),
      c('title', 'f.title', 'text', { width: 40 }), c('revision', 'f.revision'), c('status', 'f.status', 'status'), c('node_code', 'f.node_code'),
      c('file_name', 'f.file'), c('uploaded_by', 'f.uploaded_by'), c('updated_at', 'f.updated_at', 'datetime')],
  },
  // ------------------------------------------------------------------ procurement
  {
    key: 'pr_lines', module: 'procurement', kind: 'list', title: 'x.pr_lines', purpose: 'xp.pr_lines',
    source: 'v_pr_lines', resource: 'pr', projectColumn: 'project_id', dateColumn: 'created_at', statusColumn: 'pr_status',
    statuses: E.prStatus, orderBy: [{ column: 'pr_no' }, { column: 'line_no' }],
    columns: [c('pr_no', 'f.pr'), c('pr_status', 'f.status', 'status'), c('priority', 'f.priority', 'enum', { enumKey: 'priority' }),
      c('project_code', 'f.project'), c('bom_revision', 'f.revision'), c('line_no', 'f.line_no', 'number'), c('sku', 'f.sku'),
      c('description', 'f.description', 'text', { width: 40 }), c('qty', 'f.qty', 'number'), c('uom', 'f.uom'),
      c('ordered_qty', 'f.ordered_qty', 'number'), c('open_qty', 'f.open_qty', 'number'), c('needed_by', 'f.needed_by', 'date'),
      c('requested_by_name', 'f.requested_by')],
  },
  {
    key: 'po_lines', module: 'procurement', kind: 'list', title: 'x.po_lines', purpose: 'xp.po_lines',
    source: 'v_po_lines', resource: 'po', projectColumn: 'project_id', dateColumn: 'order_date', statusColumn: 'po_status',
    statuses: E.poStatus, orderBy: [{ column: 'po_no' }, { column: 'line_no' }],
    columns: [c('po_no', 'f.po'), c('order_date', 'f.order_date', 'date'), c('po_status', 'f.status', 'status'), c('vendor_name', 'f.vendor'),
      c('project_code', 'f.project'), c('pr_no', 'f.pr'), c('line_no', 'f.line_no', 'number'), c('sku', 'f.sku'),
      c('manufacturer', 'f.manufacturer'), c('mpn', 'f.mpn'), c('description', 'f.description', 'text', { width: 40 }),
      c('qty', 'f.qty', 'number'), c('uom', 'f.uom'), c('unit_price', 'f.unit_price', 'money'), c('discount_pct', 'f.discount_pct', 'percent'),
      c('currency_code', 'f.currency_code'), c('net_amount', 'f.net_amount', 'money'), c('net_amount_base', 'f.net_amount_base', 'money'),
      c('promised_date', 'f.promised_date', 'date'), c('received_qty', 'f.received_qty', 'number'), c('open_qty', 'f.open_qty', 'number'),
      c('is_late', 'f.is_late', 'bool')],
  },
  {
    key: 'open_po_lines', module: 'procurement', kind: 'analysis', title: 'x.open_po_lines', purpose: 'xp.open_po_lines',
    source: 'v_open_po_lines', resource: 'po', projectColumn: 'project_id', dateColumn: 'promised_date',
    orderBy: [{ column: 'promised_date' }],
    columns: [c('po_no', 'f.po'), c('vendor_name', 'f.vendor'), c('project_code', 'f.project'), c('sku', 'f.sku'),
      c('description', 'f.description', 'text', { width: 40 }), c('qty', 'f.qty', 'number'), c('received_qty', 'f.received_qty', 'number'),
      c('open_qty', 'f.open_qty', 'number'), c('promised_date', 'f.promised_date', 'date'), c('is_late', 'f.is_late', 'bool')],
  },
  {
    key: 'rfq_comparison', module: 'procurement', kind: 'analysis', title: 'x.rfq_comparison', purpose: 'xp.rfq_comparison',
    source: 'v_rfq_comparison', resource: 'rfq', orderBy: [{ column: 'rfq_no' }, { column: 'line_no' }, { column: 'price_rank' }],
    columns: [c('rfq_no', 'f.doc_no'), c('line_no', 'f.line_no', 'number'), c('description', 'f.description', 'text', { width: 36 }),
      c('mpn', 'f.mpn'), c('qty', 'f.qty', 'number'), c('uom', 'f.uom'), c('vendor_name', 'f.vendor'),
      c('unit_price', 'f.unit_price', 'money'), c('currency_code', 'f.currency_code'), c('unit_price_base', 'f.unit_price_base', 'money'),
      c('total_base', 'f.total_base', 'money'), c('moq', 'f.moq', 'number'), c('lead_time_days', 'f.lead_time_days', 'number'),
      c('valid_until', 'f.valid_until', 'date'), c('price_rank', 'f.price_rank', 'number'), c('is_awarded', 'f.is_awarded', 'bool')],
  },
  {
    key: 'item_prices', module: 'procurement', kind: 'list', title: 'x.item_prices', purpose: 'xp.item_prices',
    source: 'v_item_prices', resource: 'costing', dateColumn: 'valid_from', orderBy: [{ column: 'sku' }, { column: 'valid_from', asc: false }],
    columns: [c('sku', 'f.sku'), c('erp_code', 'f.erp_code'), c('item_name', 'f.item', 'text', { width: 36 }), c('manufacturer', 'f.manufacturer'),
      c('mpn', 'f.mpn'), c('vendor_name', 'f.vendor'), c('unit_price', 'f.unit_price', 'money'), c('currency_code', 'f.currency_code'),
      c('unit_price_base', 'f.unit_price_base', 'money'), c('moq', 'f.moq', 'number'), c('order_multiple', 'f.order_multiple', 'number'),
      c('lead_time_days', 'f.lead_time_days', 'number'), c('valid_from', 'f.valid_from', 'date'), c('valid_to', 'f.valid_until', 'date'),
      c('is_valid', 'f.is_valid', 'bool'), c('source', 'f.price_source', 'enum', { enumKey: 'priceSource' }), c('notes', 'f.notes')],
  },
  {
    key: 'vendor_price_history', module: 'procurement', kind: 'analysis', title: 'x.vendor_price_history', purpose: 'xp.vendor_price_history',
    source: 'v_vendor_price_history', resource: 'po', dateColumn: 'order_date', orderBy: [{ column: 'sku' }, { column: 'order_date' }],
    columns: [c('sku', 'f.sku'), c('item_name', 'f.item'), c('manufacturer', 'f.manufacturer'), c('mpn', 'f.mpn'), c('vendor_name', 'f.vendor'),
      c('po_no', 'f.po'), c('order_date', 'f.order_date', 'date'), c('qty', 'f.qty', 'number'), c('unit_price', 'f.unit_price', 'money'),
      c('discount_pct', 'f.discount_pct', 'percent'), c('currency_code', 'f.currency_code'), c('unit_price_base', 'f.unit_price_base', 'money')],
  },
  {
    key: 'vendor_performance', module: 'procurement', kind: 'analysis', title: 'x.vendor_performance', purpose: 'xp.vendor_performance',
    source: 'v_vendor_performance', resource: 'po', orderBy: [{ column: 'vendor_name' }],
    columns: [c('vendor_code', 'f.code'), c('vendor_name', 'f.vendor'), c('po_lines', 'f.po_lines', 'number'),
      c('delivered_lines', 'f.delivered_lines', 'number'), c('otif_lines', 'f.otif_lines', 'number'), c('otif_pct', 'f.otif_pct', 'percent'),
      c('avg_lead_time_days', 'f.avg_lead_time_days', 'number'), c('late_open_lines', 'f.late_open_lines', 'number'),
      c('ncr_count', 'f.ncr_count', 'number')],
  },
  // ------------------------------------------------------------------ warehouse
  {
    key: 'stock_balance', module: 'warehouse', kind: 'list', title: 'x.stock_balance', purpose: 'xp.stock_balance',
    source: 'v_stock_balance', resource: 'warehouse', projectColumn: 'project_id', orderBy: [{ column: 'sku' }, { column: 'location_code' }],
    columns: [c('sku', 'f.sku'), c('item_name', 'f.item', 'text', { width: 40 }), c('category', 'f.category'), c('warehouse_code', 'f.warehouse'),
      c('location_code', 'f.location'), c('project_code', 'f.stock_bucket'), c('lot_no', 'f.lot_no'), c('serial_no', 'f.serial_no'),
      c('qty', 'f.qty', 'number'), c('uom', 'f.uom')],
  },
  {
    key: 'stock_moves', module: 'warehouse', kind: 'list', title: 'x.stock_moves', purpose: 'xp.stock_moves',
    source: 'v_stock_moves', resource: 'warehouse', projectColumn: 'project_id', dateColumn: 'move_date', statusColumn: 'move_type',
    statuses: E.moveType, orderBy: [{ column: 'move_date' }],
    columns: [c('doc_no', 'f.doc_no'), c('move_date', 'f.move_date', 'datetime'), c('move_type', 'f.move_type', 'enum', { enumKey: 'moveType' }),
      c('sku', 'f.sku'), c('item_name', 'f.item'), c('qty', 'f.qty', 'number'), c('uom', 'f.uom'), c('from_location', 'f.from_location'),
      c('to_location', 'f.to_location'), c('project_code', 'f.stock_bucket'), c('consume_project_code', 'f.consume_project'),
      c('po_no', 'f.po'), c('lot_no', 'f.lot_no'), c('serial_no', 'f.serial_no'), c('reference', 'f.reference'), c('notes', 'f.notes'),
      c('created_by_name', 'f.created_by')],
  },
  {
    key: 'po_receiving', module: 'warehouse', kind: 'list', title: 'x.po_receiving', purpose: 'xp.po_receiving',
    source: 'v_po_receiving', resource: 'po_receiving', projectColumn: 'project_id', dateColumn: 'promised_date', statusColumn: 'po_status',
    statuses: ['approved', 'ordered', 'partially_received', 'received', 'closed'], orderBy: [{ column: 'promised_date' }],
    columns: [c('po_no', 'f.po'), c('vendor_name', 'f.vendor'), c('project_code', 'f.project'), c('sku', 'f.sku'),
      c('description', 'f.description', 'text', { width: 40 }), c('qty', 'f.qty', 'number'), c('received_qty', 'f.received_qty', 'number'),
      c('open_qty', 'f.open_qty', 'number'), c('uom', 'f.uom'), c('promised_date', 'f.promised_date', 'date'), c('po_status', 'f.status', 'status')],
  },
  {
    key: 'inventory_aging', module: 'warehouse', kind: 'analysis', title: 'x.inventory_aging', purpose: 'xp.inventory_aging',
    source: 'v_inventory_aging', resource: 'warehouse', projectColumn: 'project_id', orderBy: [{ column: 'age_days', asc: false }],
    columns: [c('sku', 'f.sku'), c('item_name', 'f.item'), c('location_code', 'f.location'), c('project_code', 'f.stock_bucket'),
      c('lot_no', 'f.lot_no'), c('qty', 'f.qty', 'number'), c('last_receipt_date', 'f.last_receipt_date', 'date'),
      c('age_days', 'f.age_days', 'number'), c('age_bucket', 'f.age_bucket')],
  },
  {
    key: 'low_stock', module: 'warehouse', kind: 'analysis', title: 'x.low_stock', purpose: 'xp.low_stock',
    source: 'v_low_stock', resource: 'warehouse', orderBy: [{ column: 'shortage_qty', asc: false }],
    columns: [c('sku', 'f.sku'), c('item_name', 'f.item'), c('uom', 'f.uom'), c('min_stock', 'f.min_stock', 'number'),
      c('free_qty', 'f.free_qty', 'number'), c('total_qty', 'f.total_qty', 'number'), c('shortage_qty', 'f.shortage_qty', 'number'),
      c('default_vendor', 'f.default_vendor'), c('lead_time_days', 'f.lead_time_days', 'number')],
  },
  // ------------------------------------------------------------------ quality
  {
    key: 'inspections', module: 'quality', kind: 'list', title: 'x.inspections', purpose: 'xp.inspections',
    source: 'v_inspections', resource: 'qa', projectColumn: 'project_id', dateColumn: 'created_at', statusColumn: 'result',
    statuses: E.inspectionResult, orderBy: [{ column: 'created_at' }],
    columns: [c('doc_no', 'f.doc_no'), c('inspection_type', 'f.inspection_type', 'enum', { enumKey: 'inspectionType' }),
      c('project_code', 'f.project'), c('node_code', 'f.node_code'), c('sku', 'f.sku'), c('item_name', 'f.item'), c('po_no', 'f.po'),
      c('vendor_name', 'f.vendor'), c('qty_inspected', 'f.qty_inspected', 'number'), c('qty_rejected', 'f.qty_rejected', 'number'),
      c('result', 'f.result', 'status'), c('inspector_name', 'f.inspector'), c('inspected_at', 'f.inspected_at', 'datetime'),
      c('customer_witness', 'f.customer_witness'), c('notes', 'f.notes')],
  },
  {
    key: 'ncrs', module: 'quality', kind: 'list', title: 'x.ncrs', purpose: 'xp.ncrs',
    source: 'v_ncrs', resource: 'nc', projectColumn: 'project_id', dateColumn: 'opened_on', statusColumn: 'status',
    statuses: E.ncrStatus, orderBy: [{ column: 'opened_on' }],
    columns: [c('doc_no', 'f.doc_no'), c('opened_on', 'f.opened_on', 'date'), c('title', 'f.title', 'text', { width: 40 }),
      c('project_code', 'f.project'), c('sku', 'f.sku'), c('vendor_name', 'f.vendor'), c('severity', 'f.severity', 'enum', { enumKey: 'severity' }),
      c('qty', 'f.qty', 'number'), c('disposition', 'f.disposition', 'enum', { enumKey: 'disposition' }), c('root_cause', 'f.root_cause'),
      c('corrective_action', 'f.corrective_action'), c('preventive_action', 'f.preventive_action'), c('owner_name', 'f.owner'),
      c('due_date', 'f.due_date', 'date'), c('status', 'f.status', 'status'), c('age_days', 'f.age_days', 'number'),
      c('is_overdue', 'f.is_overdue', 'bool'), c('cost_impact', 'f.cost_impact', 'money')],
  },
  {
    key: 'ncr_by_vendor', module: 'quality', kind: 'analysis', title: 'x.ncr_by_vendor', purpose: 'xp.ncr_by_vendor',
    source: 'v_ncr_by_vendor', resource: 'nc', orderBy: [{ column: 'ncr_count', asc: false }],
    columns: [c('vendor_name', 'f.vendor'), c('sku', 'f.sku'), c('item_name', 'f.item'), c('severity', 'f.severity', 'enum', { enumKey: 'severity' }),
      c('ncr_count', 'f.ncr_count', 'number'), c('open_count', 'f.open_count', 'number'), c('qty', 'f.qty', 'number'),
      c('cost_impact', 'f.cost_impact', 'money'), c('first_ncr', 'f.first_ncr', 'date'), c('last_ncr', 'f.last_ncr', 'date')],
  },
  {
    key: 'compliance', module: 'quality', kind: 'list', title: 'x.compliance', purpose: 'xp.compliance',
    source: 'v_compliance', resource: 'compliance', projectColumn: 'project_id', dateColumn: 'due_date', statusColumn: 'status',
    statuses: E.complianceStatus, orderBy: [{ column: 'project_code' }, { column: 'sort' }],
    columns: [c('project_code', 'f.project'), c('market', 'f.market'), c('code', 'f.code'), c('title', 'f.title', 'text', { width: 45 }),
      c('standard_ref', 'f.standard_ref'), c('category', 'f.category', 'enum', { enumKey: 'complianceCategory' }),
      c('responsible_name', 'f.responsible'), c('due_date', 'f.due_date', 'date'), c('status', 'f.status', 'status'),
      c('document_title', 'f.document'), c('document_revision', 'f.revision'), c('evidence_note', 'f.evidence_note'),
      c('verified_by_name', 'f.verified_by'), c('verified_at', 'f.verified_at', 'datetime'), c('is_overdue', 'f.is_overdue', 'bool')],
  },
  // ------------------------------------------------------------------ service / finance / master
  {
    key: 'service_tickets', module: 'service', kind: 'list', title: 'x.service_tickets', purpose: 'xp.service_tickets',
    source: 'v_service_tickets', resource: 'service', projectColumn: 'project_id', dateColumn: 'reported_at', statusColumn: 'status',
    statuses: E.serviceStatus, orderBy: [{ column: 'reported_at' }],
    columns: [c('doc_no', 'f.doc_no'), c('reported_at', 'f.reported_at', 'datetime'), c('title', 'f.title', 'text', { width: 40 }),
      c('project_code', 'f.project'), c('customer_name', 'f.customer'), c('priority', 'f.priority', 'enum', { enumKey: 'priority' }),
      c('is_warranty', 'f.is_warranty', 'bool'), c('assignee_name', 'f.assignee'), c('status', 'f.status', 'status'),
      c('resolution', 'f.resolution'), c('closed_at', 'f.closed_at', 'datetime'), c('age_days', 'f.age_days', 'number')],
  },
  {
    key: 'project_cost', module: 'finance', kind: 'analysis', title: 'x.project_cost', purpose: 'xp.project_cost',
    source: 'v_project_cost', resource: 'finance', projectColumn: 'project_id', statusColumn: 'status', statuses: E.projectStatus,
    orderBy: [{ column: 'project_code' }],
    columns: [c('project_code', 'f.project'), c('project_name', 'f.name'), c('status', 'f.status', 'status'),
      c('contract_value_base', 'f.contract_value_base', 'money'), c('budget_base', 'f.budget_base', 'money'),
      c('approved_hours', 'f.approved_hours', 'number'), c('labor_cost_base', 'f.labor_cost_base', 'money'),
      c('po_committed_base', 'f.po_committed_base', 'money'), c('po_received_base', 'f.po_received_base', 'money'),
      c('total_cost_base', 'f.total_cost_base', 'money'), c('gross_margin_base', 'f.gross_margin_base', 'money')],
  },
  {
    key: 'partners', module: 'master', kind: 'list', title: 'x.partners', purpose: 'xp.partners',
    source: 'partners', resource: 'partners', orderBy: [{ column: 'code' }],
    columns: [c('code', 'f.code'), c('name', 'f.name', 'text', { width: 40 }), c('is_customer', 'f.is_customer', 'bool'),
      c('is_vendor', 'f.is_vendor', 'bool'), c('is_carrier', 'f.is_carrier', 'bool'), c('tax_code', 'f.tax_id'), c('country', 'f.country'),
      c('address', 'f.address'), c('contact_name', 'f.contact_name'), c('email', 'f.email'), c('phone', 'f.phone'),
      c('currency_code', 'f.currency_code'), c('payment_terms', 'f.payment_terms'), c('is_active', 'f.is_active', 'bool')],
  },
  {
    key: 'items', module: 'master', kind: 'list', title: 'x.items', purpose: 'xp.items',
    source: 'items', resource: 'items', orderBy: [{ column: 'sku' }],
    columns: [c('sku', 'f.sku'), c('erp_code', 'f.erp_code'), c('name', 'f.name', 'text', { width: 40 }), c('manufacturer', 'f.manufacturer'), c('mpn', 'f.mpn'),
      c('category', 'f.category'), c('item_type', 'f.item_type', 'enum', { enumKey: 'itemType' }),
      c('part_type', 'f.part_type', 'enum', { enumKey: 'partType' }), c('procurement_type', 'f.procurement_type', 'enum', { enumKey: 'makeOrBuy' }),
      c('uom', 'f.uom'), c('moq', 'f.moq', 'number'), c('order_multiple', 'f.order_multiple', 'number'), c('drawing_url', 'f.drawing_url'),
      c('track_lot', 'f.track_lot', 'bool'), c('track_serial', 'f.track_serial', 'bool'), c('min_stock', 'f.min_stock', 'number'),
      c('lead_time_days', 'f.lead_time_days', 'number'), c('hs_code', 'f.hs_code'), c('country_of_origin', 'f.country_of_origin'),
      c('is_active', 'f.is_active', 'bool')],
  },
];

export const EXPORT_MODULES = ['sales', 'projects', 'engineering', 'procurement', 'warehouse', 'quality', 'service', 'finance', 'master'] as const;

export function findExport(key: string): ExportSpec | undefined {
  return EXPORTS.find((e) => e.key === key);
}
