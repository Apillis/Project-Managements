-- =============================================================================
-- 0013 (v1.1) reference data: permissions for Costing / RFQ, numbering,
-- approval rule, settings, fee rules (from the "Warning" sheet), labour step
-- templates (from "Assy Breakout Cost"), Excel import column mappings.
-- =============================================================================

insert into public.resources(code, module, name_en, name_vi, sort) values
  ('costing', 'sales',       'Cost estimates & price book', 'Dự toán giá & bảng giá', 22),
  ('rfq',     'procurement', 'RFQ (request for quotation)', 'Hỏi giá NCC (RFQ)',      52);

with m(role_code, resource, mode) as (values
  ('sales','costing','W'), ('procurement','costing','W'), ('accounting','costing','W'),
  ('pmo','costing','R'), ('engineering_lead','costing','R'),
  ('procurement','rfq','W'), ('engineering_lead','rfq','R'), ('pmo','rfq','R'), ('sales','rfq','R'), ('accounting','rfq','R'))
insert into public.permissions(role_code, resource, can_read, can_write)
select role_code, resource, true, mode = 'W' from m;

insert into public.doc_sequences(doc_type, prefix) values ('cost_estimate', 'CE'), ('rfq', 'RFQ');

insert into public.approval_rules(doc_type, step_no, name, min_amount, approver_role) values
  ('cost_estimate', 1, 'Management price approval', 0, 'management');

insert into public.app_settings(key, value, description) values
  ('rfq_email_enabled',  'true', 'Send RFQ e-mails to vendors (through the notifier)'),
  ('default_labor_rate', '0',    'Labour rate per hour in base currency when no "production" labour rate is set');

insert into public.cost_rules(code, name, basis, amount, currency_code, part_types, description, is_active) values
  ('FORWARDER', 'Forwarder fee', 'per_package', 58, 'USD', array['oem'],
   'For every package of OEM parts shipped from overseas suppliers', true),
  ('COC', 'CoC & inspection certificate', 'per_package', 233, 'USD', array['cable_assy'],
   'Power wires / cables needing a certificate of conformity — adjust part types before enabling', false);

insert into public.labor_step_templates(discipline, main_task, step_code, work_step, description, default_hours, sort) values
  ('elec', '1. Material preparation', '1.1', 'Review and analysis of drawings & BOM', 'Technician reviews drawings, BOM and wiring diagram', 0.5, 11),
  ('elec', '1. Material preparation', '1.2', 'Material preparation & kitting', 'Retrieving the enclosure and components, kitting per BOM', 0.2, 12),
  ('elec', '1. Material preparation', '1.3', 'Mounting plate fabrication', 'Marking, drilling, tapping the back plate', 0, 13),
  ('elec', '1. Material preparation', '1.4', 'DIN rail & wire duct installation', 'Mounting DIN rails and wire ducts', 0, 14),
  ('elec', '2. Main component installation', '2.1', 'Power components', 'Mounting main circuit breakers, contactors, power supplies', 0, 21),
  ('elec', '2. Main component installation', '2.2', 'Control components', 'Mounting PLC, I/O, relays, terminals', 0, 22),
  ('elec', '2. Main component installation', '2.3', 'Door devices', 'Mounting push buttons, pilot lights, HMI', 0, 23),
  ('elec', '3. Wiring', '3.1', 'Power wiring', 'Cutting, stripping, crimping and routing power wires', 0, 31),
  ('elec', '3. Wiring', '3.2', 'Control wiring', 'Control and signal wiring, shielding', 0, 32),
  ('elec', '3. Wiring', '3.3', 'Labelling', 'Wire markers, device labels, warning labels', 0, 33),
  ('elec', '4. Testing', '4.1', 'Continuity & insulation test', 'Point-to-point check, insulation resistance', 0, 41),
  ('elec', '4. Testing', '4.2', 'Power-on & I/O test', 'Energising, I/O check', 0, 42),
  ('elec', '5. QC & documentation', '5.1', 'Final inspection & as-built', 'QC checklist, as-built documents, photos', 0, 51),
  ('mech', '1. Material preparation', '1.1', 'Review and analysis of drawings & BOM', 'Technician reviews drawings and BOM', 0.2, 11),
  ('mech', '1. Material preparation', '1.2', 'Material preparation', 'Retrieving frame members and components', 0.25, 12),
  ('mech', '1. Material preparation', '1.3', 'Structural / frame machining', 'Cutting, drilling, tapping', 0, 13),
  ('mech', '1. Material preparation', '1.4', 'Surface preparation', 'Deburring cut edges, cleaning', 0, 14),
  ('mech', '2. Main component installation', '2.1', 'Base frame and structure', 'Assembling and bolting the frame', 0, 21),
  ('mech', '2. Main component installation', '2.2', 'Component installation', 'Mounting motors, gearboxes, cylinders', 0, 22),
  ('mech', '2. Main component installation', '2.3', 'Transmission installation', 'Mounting shafts, pulleys, belts', 0, 23),
  ('mech', '3. Pneumatics', '3.1', 'Pneumatic piping', 'Valves, tubing, fittings', 0, 31),
  ('mech', '4. Adjustment', '4.1', 'Alignment & adjustment', 'Alignment, sensors adjustment', 0, 41),
  ('mech', '5. QC & documentation', '5.1', 'Final inspection', 'QC checklist, photos', 0, 51),
  ('cable', '1. Preparation', '1.1', 'Review drawing & BOM', 'Cable drawing, pin-out, BOM', 0.25, 11),
  ('cable', '1. Preparation', '1.2', 'Cut wires and cables to length', 'Measuring and cutting', 0.25, 12),
  ('cable', '2. Termination', '2.1', 'Strip & crimp', 'Stripping, crimping pins / terminals', 0.5, 21),
  ('cable', '2. Termination', '2.2', 'Connector assembly', 'Inserting pins in housings, heat-shrink', 0.25, 22),
  ('cable', '3. Finishing', '3.1', 'Sleeving, ties & labels', 'Spiral wrap, cable ties, labels', 0.15, 31),
  ('cable', '4. Test', '4.1', 'Continuity / pin-out test', 'Point-to-point test, test record', 0.2, 41);

-- Column mapping for Excel imports: header aliases (case/space/"*" insensitive, prefix match)
insert into public.import_mappings(import_key, field, aliases, sort) values
  ('structure_bom', 'level',            array['level'], 1),
  ('structure_bom', 'customer_part_no', array['customer part number','customer pn','customer p/n'], 2),
  ('structure_bom', 'erp_code',         array['ecount item code','erp code','item code'], 3),
  ('structure_bom', 'description',      array['description','item name'], 4),
  ('structure_bom', 'customer_rev',     array['customer rev','rev'], 5),
  ('structure_bom', 'qty',              array['bom.qty','bom qty','qty per','quantity','qty'], 6),
  ('structure_bom', 'uom',              array['unit','uom'], 7),
  ('structure_bom', 'part_type',        array['part type'], 8),
  ('structure_bom', 'make_or_buy',      array['procument type','procurement type','make or buy'], 9),
  ('structure_bom', 'manufacturer',     array['manufacturer','manufacture'], 10),
  ('structure_bom', 'mpn',              array['manufacturer part number','manufacturer part n','mpn'], 11),
  ('structure_bom', 'find_no',          array['bom.find num','find num','find no'], 12),
  ('structure_bom', 'unit_cost',        array['part unit cost','unit cost'], 13),
  ('structure_bom', 'moq',              array['moq qty','moq'], 14),
  ('structure_bom', 'lead_time_days',   array['lead time'], 15),
  ('structure_bom', 'vendor_name',      array['supplier name','vendor'], 16),
  ('structure_bom', 'drawing_url',      array['links','link','drawing'], 17),
  ('structure_bom', 'position',         array['position','designator','ref des'], 18),
  ('structure_bom', 'notes',            array['notes','note','remark'], 19),
  ('ecount_items',  'erp_code',         array['item code'], 1),
  ('ecount_items',  'mpn',              array['item code (external)','item code external'], 2),
  ('ecount_items',  'rev',              array['rev'], 3),
  ('ecount_items',  'name',             array['item name'], 4),
  ('ecount_items',  'spec',             array['spec.','spec'], 5),
  ('ecount_items',  'uom',              array['unit'], 6),
  ('ecount_items',  'vendor_name',      array['customer/vendorname','customer/vendor/supplier name','customer/vendor'], 7),
  ('ecount_items',  'unit_cost',        array['purchase price'], 8),
  ('ecount_items',  'category',         array['item category'], 9),
  ('ecount_items',  'active',           array['active'], 10),
  ('ecount_items',  'drawing_url',      array['link'], 11);
