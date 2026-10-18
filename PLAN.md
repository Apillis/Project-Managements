# PLAN — Apillis PMLC (Project Management Life Cycle) Software

| | |
|---|---|
| Document | APL-IT-PM-002 · PLAN.md |
| Revision | 1.0 (2026-10-14) |
| Owner | Truong (Automation / Software) |
| Inputs | `SRS - Enterprise Project Management Life Cycle Software.docx` (v1.0), `Kiến trúc Apillis PM Server.html` (APL-IT-PM-001 Rev A), review notes and the decisions below |

## 0. Decisions captured from the stakeholder (2026-10-14)

| # | Topic | Decision |
|---|---|---|
| 1 | Lifecycle | RFQ → Quotation → Customer PO → Kick-off → Design (Mech/Elec/PLC) → Design review → Procurement → Fabrication/Assembly/Wiring → Programming & dry-run → FAT → Pack & ship → SAT/Installation → Warranty → Close |
| 2 | Departments | Sales, PMO, Engineering, Engineering Lead, Production (workshop/technicians), Procurement, Warehouse, Logistics, QA/QC, Accounting, Service/Warranty, Management, Admin |
| 3 | MVP scope | Everything except Accounting and Logistics business modules (wave 2). Task management is hierarchical and follows **IDEF0 (ICOM)** |
| 4 | Approvals | Approval matrix is fully configurable on the Settings page |
| 5 | Project code | Typed by the user (unique). Other documents auto-numbered (configurable prefix) |
| 6 | Currency / tax | Selectable per document; currencies, exchange rates and tax codes maintained in Settings |
| 7 | EU/US market | Compliance dossier per project (CE / UL / NFPA 79 / ISO …), audit trail, lot/serial traceability |
| 8 | Timesheets | Yes — hours per activity per day, approval, labour-rate costing |
| 9 | Warehouse | Yes — multi-warehouse/location, project-reserved stock, lot/serial, QR labels |
| 10 | Import | Excel import for legacy data (partners, items, projects, BOM, opening stock) |
| 11 | Integrations | Deferred (MISA, BOM price tool, Fabrication PM) — design keeps hooks |
| 12 | Excel export | Every module; filters by project, date range and status (PR/PO/SO…) |
| 13 | Language | Bilingual Vietnamese / English with a switch |
| 14 | Stack | Supabase (self-host) + React/TypeScript/Vite |
| 15 | Server | Not yet bought → first run on a desktop (Supabase CLI on Docker Desktop) |
| 16 | Repo | https://github.com/Apillis/Project-Managements.git |
| 17 | Login | Google Workspace @apillis.com (+ email/password fallback), domain-restricted |
| 18 | Domain | None yet → `localhost` on the desktop; `tls internal` on the server |
| 19 | Notifications | In-app + e-mail + Google Chat (incoming webhook) |
| 20 | Code location | `pm-app/` inside the `Project managements life cycle` folder |

## 1. Architecture

```
Browser (React SPA, VI/EN)  ──HTTPS──▶  Caddy ──▶ pm-web (nginx, static dist/)
        │                                  └──▶ Kong ─▶ GoTrue (auth) / PostgREST (rest) / Realtime / Storage
        │                                                      │
        └── ExcelJS (export/import runs in the browser,        ▼
            so every export obeys the user's RLS rights)   PostgreSQL 15+  ◀── notifier (Node) polls
                                                             · RLS on every table          notification_outbox
                                                             · business rules in triggers  → SMTP e-mail
                                                             · RPC functions (approvals…)  → Google Chat webhook
```

* **No custom backend.** PostgREST exposes tables/views/RPCs; all rules live in PostgreSQL (RLS, triggers, SECURITY DEFINER RPCs). A UI bug therefore cannot bypass a rule — the database is the interlock.
* **notifier** is the only server-side process we write: it reads `notification_outbox` with `FOR UPDATE SKIP LOCKED` and delivers e-mail / Google Chat messages, retrying with back-off.
* **Desktop test** = `supabase start` (Supabase CLI, Docker Desktop) + `npm run dev`. **Server** = official Supabase self-host compose + `deploy/compose.override.yml` (Caddy, pm-web, notifier).

## 2. Security model

* `roles` (13 codes) ↔ `user_roles` (a user may hold several roles).
* `permissions(role, resource, can_read, can_write)` — the **permission matrix, editable in Settings**. `app.can(resource, 'read'|'write')` is used by every RLS policy. `admin` = everything, `management` = read everything.
* Column-level hiding: Warehouse/QA/Logistics read POs through `v_po_receiving` (no prices) and have no right on `po` itself.
* Read-only inheritance: BOM quantities flow into PR/PO lines and are locked by triggers (item can’t differ from the BOM line; requested qty can’t exceed BOM qty).
* Document lock: once a document leaves `draft/rejected`, its lines are frozen and only whitelisted header fields can change. Status `pending_approval/approved/rejected` can only be set by the approval engine.
* Audit log trigger on all business tables (who/when/old/new) — ISO 9001 / CE technical-file traceability.
* Sign-up restricted to the domain in `app_settings.allowed_email_domain` (default `apillis.com`). First user becomes admin (bootstrap).

## 3. Database schema (PostgreSQL, schema `public`; helpers in schema `app`)

**Admin & settings** — `roles`, `profiles`, `user_roles`, `permissions`, `app_settings` (key/jsonb), `currencies`, `exchange_rates`, `tax_codes`, `doc_sequences`, `labor_rates`, `audit_log`, `notifications`, `notification_outbox`, `lifecycle_templates`, `template_nodes`, `template_icoms`, `compliance_templates`.

**Master data** — `partners` (customer/vendor/carrier flags), `items` (SKU, manufacturer, MPN, UoM, lot/serial flags, min stock, lead time), `warehouses`, `locations`.

**Sales** — `quotations` + `quotation_lines`, `sales_orders` + `sales_order_lines`.

**Projects / IDEF0** — `projects` (user-typed `code`), `project_members`, `activities` (IDEF0 node tree: `parent_id`, `seq` 1–9, auto node code `A0`, `A1`, `A12`, `A121`…, assignee, dates, est. hours, progress, status, milestone flag), `activity_icoms` (type `I/C/O/M`, label, optional reference to document/BOM/PO/user/item, optional `source_icom_id` linking a sibling’s Output to this Input/Control → the flow on the diagram).

**Time** — `timesheets` (user, date, project, activity, hours, status draft→submitted→approved/rejected).

**Engineering** — `documents` (category, doc no, revision, status, storage path), `boms` (name + revision letter, status, `eco_id`), `bom_lines`, `ecos` (engineering change orders, cost/schedule impact).

**Procurement** — `purchase_requests` + `pr_lines` (linked to BOM lines), `purchase_orders` + `po_lines` (price, discount, tax, promised date, received qty).

**Warehouse** — `stock_moves` (insert-only ledger: receipt / issue / return / transfer / adjust; lot, serial, project ownership, PO line) → views `v_stock_balance`, `v_inventory_aging`, `v_low_stock`.

**QA** — `inspections` (incoming / in-process / FAT / SAT / final; failing one auto-creates an NCR), `ncrs` (severity, disposition, root cause, CAPA), `project_compliance` (dossier checklist generated from `compliance_templates` for EU / US markets).

**Service** — `service_tickets`.

**Approvals** — `approval_rules` (doc type, step no., amount range in base currency, approver role or user), `approval_requests`, `approval_steps`.

Document types under approval: `quotation`, `sales_order`, `bom`, `eco`, `purchase_request`, `purchase_order`.

## 4. API (PostgREST)

* CRUD on every table (`/rest/v1/<table>`), filtered by RLS.
* Report/export views (`security_invoker = on` → RLS applies): `v_quotations`, `v_sales_pipeline`, `v_sales_orders`, `v_projects`, `v_activities`, `v_overdue_activities`, `v_timesheets`, `v_bom_lines`, `v_bom_vs_actual`, `v_ecos`, `v_pr_lines`, `v_po_lines`, `v_open_po_lines`, `v_vendor_price_history`, `v_vendor_performance` (OTIF), `v_po_receiving` (no price), `v_stock_balance`, `v_stock_moves`, `v_inventory_aging`, `v_low_stock`, `v_inspections`, `v_ncrs`, `v_ncr_by_vendor`, `v_compliance`, `v_service_tickets`, `v_project_cost`.
* RPC (`/rest/v1/rpc/<fn>`):
  `submit_for_approval(doc_type, doc_id)`, `decide_approval(request_id, decision, comment)`, `cancel_approval(request_id)`,
  `apply_lifecycle_template(project_id, template_id, lang)`, `apply_compliance_templates(project_id, markets[])`, `move_activity(activity_id, new_parent, new_seq)`,
  `new_bom_revision(bom_id, eco_id)`, `create_pr_from_bom(bom_id, needed_by)`,
  `submit_timesheets(from, to)`, `decide_timesheets(ids[], decision)`,
  `my_permissions()`, `mark_notifications_read(ids[])`.

## 5. Excel export catalogue (filters: project · date range · status)

| Module | Operational lists | Analysis |
|---|---|---|
| Sales | Quotations, Sales orders (SO) | Pipeline by stage/month, win-loss |
| Projects/PMO | Projects, IDEF0 activity list (with ICOM), overdue activities | Timesheet hours by project/person, project cost (labour + committed PO) |
| Engineering | BOM (per revision), ECO log, documents register | BOM vs actual (required / requested / ordered / received / issued) |
| Procurement | PR lines, PO lines, open PO lines | Vendor price history, vendor OTIF & lead time |
| Warehouse | Stock balance, stock moves, PO receiving (no price) | Inventory aging, low-stock alert |
| QA | Inspections, NCRs, compliance dossier | NCR by vendor/item |
| Service | Service tickets | — |

Workbook layout: company/report title, filters applied, exported by/at, styled header, frozen pane, auto-filter, number/date formats. Export uses the caller’s token → the user can only export what they can see.

## 6. Excel import (legacy data)

Template download → upload → validation preview (required fields, look-ups by code/SKU, duplicates) → upsert. Entities: partners, items, projects, BOM lines (into a draft BOM), opening stock (adjust moves).

## 7. Task breakdown

| # | Task | Verification |
|---|---|---|
| T1 | PLAN.md | review |
| T2 | Migrations 0001–0010 + seed (roles, permission matrix, currencies, taxes, sequences, lifecycle template with ICOMs, compliance templates) | applied on clean PG16 |
| T3 | DB test suite (Node `node:test` + `pg`, Supabase auth stub): RLS matrix, price hiding, approval engine, locks, BOM revision/ECO, PR ≤ BOM, receipts/over-receipt, negative stock, IDEF0 codes, timesheet rules, audit, domain restriction | `npm run test:db` green |
| T4 | Web app: layout, auth (Google + password), i18n VI/EN, generic list/form engine, project workspace with IDEF0 tree & diagram, approvals inbox, settings (general, currencies, taxes, numbering, approval matrix, permission matrix, labour rates, templates, notifications), export centre, import wizard, dashboard | `vitest`, `tsc`, `vite build`, Playwright smoke against PostgREST + GoTrue |
| T5 | notifier (SMTP + Google Chat) | unit tests with fake transports |
| T6 | Deployment: desktop guide (Supabase CLI), server compose override, Caddyfile, deploy/backup/restore scripts, Dockerfiles, GitHub Actions CI | CI config lint, scripts `bash -n` |
| T7 | End-to-end verification, copy to `pm-app/`, git commit/push | all suites green |

## 8. Deployment strategy

1. **Desktop (now):** Docker Desktop + Supabase CLI → `supabase start` applies `supabase/migrations` + `seed.sql`; `npm run dev` in `web/`; `npm start` in `notifier/` (optional).
2. **Server (later, per APL-IT-PM-001):** Ubuntu 24.04, official Supabase compose in `/opt/apillis-pm/supabase`, plus `deploy/compose.override.yml` (caddy, pm-web, notifier). `deploy/deploy.sh <tag>` = backup → migrate → build → restart. Rollback of a migration = restore the `pre-deploy` dump (git checkout alone does not undo schema changes).
3. **CI:** GitHub Actions — DB tests on a `postgres:16` service, web typecheck/test/build, notifier tests.

## 9. Wave 2 (out of MVP)

~~Accounting (invoices, payments, milestone billing, P&L), Logistics (shipments, carriers, freight cost)~~ — delivered in v1.2 (§12) as project-level control; the legal books stay in MISA. Still open: integrations (MISA, BOM price API, Fabrication PM), Power BI read-only role, mobile scanning PWA, approval delegation (deputy while on leave).

## 10. Verification status (v1.0.0, 2026-10-14)

| Suite | Result |
|---|---|
| `db-tests` — schema, RLS matrix, price hiding, approval engine, document locks, BOM/ECO revisions, PR ≤ BOM, PO ≤ PR, receipts/over-receipt, negative stock, lot/serial, IDEF0 codes/moves/roll-up, timesheets, audit, notifications, project cost | 41 / 41 pass |
| `web` — typecheck, i18n completeness (VI/EN), filters, Excel builder/reader, importer, IDEF0 layout, resource config, **UI ↔ DB contract** (every table/view/column/enum/guard used by the UI exists) | 47 / 47 pass |
| `notifier` — delivery, retry/back-off, permanent failure, SKIP LOCKED concurrency, stuck rows, Google Chat & SMTP adapters | 8 / 8 pass |
| `deploy` — key generator (JWT signatures), script syntax, migration runner idempotency | pass |
| `e2e` — real GoTrue + PostgREST + Chromium: sign-up/admin bootstrap, domain block, VI/EN, IDEF0 template & diagram, BOM → approval → PR → PO → post-approval edit → receiving → stock → Gantt → Excel download verified | pass, no browser errors |
| Production build (`vite build`) | pass |

Not verified here (needs the real environment): Supabase Storage upload/download, Realtime push, Google OAuth, SMTP to a real mailbox, Docker image builds and the self-host compose stack.


## 11. v1.1 — BOM improvements, Costing and RFQ (from the AZTAKD610 Structure-BOM review)

| # | Improvement | Implementation |
|---|---|---|
| 1 | Multi-level BOM | `bom_lines.parent_line_id` (+ level, sort path, cycle guard); views `v_bom_tree` (indented, required qty = qty-per × parents × build qty), `v_bom_flat` (summed by item). UI: indented tree with L1/L2… markers, parent picker. |
| 2 | Customer PN / rev, ERP code | `items.erp_code` (unique, Ecount item code), `item_customer_refs` (customer × PN × rev), BOM header/line customer PN + rev, top item. |
| 3 | Part / procurement type | `items.part_type` (OEM, fabricated, cable assy, PCBA, sub-assembly, raw/sub material, consumable, FG, service, intangible), `procurement_type` / `make_or_buy` incl. customer-supplied and subcontract. Only purchasable leaves go to PR / RFQ. |
| 4 | Costing module | Price book `item_prices` (`best_price`), fee rules (`cost_rules`: forwarder per package, CoC…), labour templates (`labor_step_templates` from "Assy Breakout Cost"). `cost_estimates` + lines/labour/fees with the quote-sheet build-up B…L (material, labour, Apillis cost, markup, subtotal, VAT, fees/logistics, selling price, + MOQ excess). RPCs `build_cost_estimate`, `refresh_cost_estimate_prices`, `push_estimate_to_quotation`; approval doc type `cost_estimate`. |
| 5 | RFQ module | `rfqs`, `rfq_lines`, `rfq_vendors`, `rfq_quotes`; `create_rfq_from_bom` (all purchasable lines or only lines without a valid price), `send_rfq` (e-mail per vendor contact through the notifier), quote matrix `v_rfq_comparison` (price / lead-time rank), `award_rfq_quote` (→ price book), `create_pos_from_rfq` (one draft PO per awarded vendor, linked to approved PR lines). |
| 6 | Net requirement | `v_bom_net_requirement`: required − requested − reserved − usable stock, rounded up to MOQ / order multiple; `create_pr_from_bom(…, p_use_stock, p_reserve)` with `bom_reservations` so stock is not counted twice; PR lines carry `moq_qty`. |
| 7 | UoM master | `uoms` + `uom_conversions`; every `uom` column normalised (`app.norm_uom`: each→EA, meter→M…) and FK-checked. |
| 8 | Drawing links | `drawing_url` / `drawing_document_id` on items, BOM and RFQ lines; links shown in tables, sent in RFQ e-mails. |
| 9 | Build site | `boms.build_location` / `cost_estimates.build_location` (VN / US / other) — fee rules can apply per site. |
| 10 | Excel import with mapping | `import_mappings` (header aliases per field, editable in Settings). Import page tabs **Structure BOM** (sheet + header row auto-detected, Level → tree, items matched by ERP code → MPN → customer PN, created when missing, unit costs → price book) and **Ecount item list** (upsert by item code, new units, purchase prices). |

New Excel exports: multi-level BOM, flattened BOM, net requirement, cost estimates (A–L), estimate material lines, RFQ comparison, price book (37 reports in total).

### Verification status (v1.1.0, 2026-10-14)

| Suite | Result |
|---|---|
| `db-tests` (+ multi-level BOM, net requirement & reservations, UoM, import_bom_tree, price book, costing reproduces the AZTAKD610 quote sheet B…L, RFQ send/quote/award/PO, RLS on new tables) | 56 / 56 pass |
| `web` (+ header detection & mapping, level → tree, Ecount normalisation, raw workbook reader, ref pickers search text columns only, v1.1 enums/i18n, client vs DB unit normalisation) | 66 / 66 pass |
| `notifier`, `deploy` | 8 / 8, 2 / 2 pass |
| `e2e` (+ Structure BOM import from a customer-format workbook, net requirement, BOM Excel export, cost estimate → approval → quotation, RFQ → send → quote → award → PO, Ecount import) | pass, no browser errors |

## 12. v1.2 — gap analysis against the SRS and practice (2026-10-17)

The v1.1 code was reviewed module by module against the SRS (`SRS - Enterprise Project Management Life Cycle Software.docx`) and day-to-day use. Gaps found and how v1.2 closes them:

| # | Gap | Source | v1.2 implementation |
|---|---|---|---|
| 1 | Warehouse issued material freely; SRS: "issued to the site based on approved PMO requests" | SRS phase 3 | `material_requests` + lines (approval doc type `material_request`, default approver PMO), `stock_moves.mr_line_id` (no over-issue, consuming project forced), setting `issue_requires_request`; page **Issue to projects** |
| 2 | No Logistics module (role existed without a screen); SRS export "Freight cost by route / project" | SRS roles, phase 3, §5 | `shipments` + packing-list lines (carrier check, status stamps, delivered notification), `v_shipments`, `v_freight_by_route`; freight is part of project cost |
| 3 | No Accountancy module: prepayment, milestone billing, collections, P&L, cash flow | SRS phases 1, 4, 5, §5 | `billing_milestones` (% of SO ≤ 100 %, tied to an IDEF0 activity → *ready* + Accounting notified), `invoices` + lines (draft → issued → partially paid / paid, lines locked once issued, e-invoice no.), `payments` in / out (capped by invoice / PO total, immutable, partner role checked), RPC `create_invoice_from_milestone`; views `v_invoices`, `v_receivables` (aging), `v_payments`, `v_project_pnl`, `v_project_cashflow` (actual + forecast); `v_project_cost` now includes freight |
| 4 | Closing a project locked nothing | SRS phase 5 "locking all documents" | `project_close_check()` checklist (12 items) enforced when status → closed (`project_close_strict`); `trg_project_lock` on 32 project tables makes every record of a closed / cancelled project read-only; only Management reopens; closed projects cannot be deleted; warranty tickets stay open |
| 5 | No reminders: overdue work was only visible when someone opened the app | practice | `app.run_daily_digest()` (once a day after `digest_hour`, recipient language, idempotent via `digest_runs`), called by the notifier every cycle; "Send digest now" in Settings |
| 6 | Bug: approval inbox opened `/r/undefined/…` for cost estimates | code review | `DOC_ROUTE` typed over every approvable doc type (compile-time completeness) + unit test |
| 7 | Bug: PO filter of the receiving page read `purchase_orders`, empty for the Warehouse role (no price right) | code review | `v_po_receiving_docs` (built on `v_po_receiving`, no prices) |
| 8 | No self-service password reset | practice | "Forgot password?" on the login page (Supabase recovery e-mail → profile page) |
| 9 | Two v1.1 settings had no Vietnamese label | contract test added in v1.2 | labels added; the contract test now checks every `app_settings` key |

New Excel exports (46 in total): material requests, shipments, freight by route, billing milestones, invoices, receivables aging, payments, project P&L, project cash flow. New permission resources: `mr`, `logistics`, `invoices`, `payments` (defaults in migration 0018).

### Verification status (v1.2.0, 2026-10-17)

| Suite | Result |
|---|---|
| `db-tests` (+ material request approval / issue / over-issue, receiving headers without prices, shipments & freight by route, milestones % cap and activity trigger, invoice issue / lock / payments / over-payment / cancel, vendor payment cap, P&L and cash-flow figures, closure checklist / lock / reopen, cancelled project lock vs. approval withdrawal, digest once-a-day and language, permission defaults) | 66 / 66 pass |
| `web` (+ finance helpers, approval routes, v1.2 enums vs. DB, closure codes and settings labels vs. DB, i18n of all new keys) | 73 / 73 pass, typecheck clean, production build OK |
| `notifier` (+ digest queued by the DB once a day and delivered by e-mail) | 9 / 9 pass |
| `deploy` | 2 / 2 pass, `bash -n` OK |
| `e2e` (+ material request → approval → issue page, shipment planned → in transit → delivered, invoice → issue → payment → P&L / cash flow / receivables, closure checklist blocks closing) — run in the `mcr.microsoft.com/playwright:v1.56.1-noble` container against PostgreSQL 16 | pass, no browser errors |
