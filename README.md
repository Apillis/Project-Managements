# Apillis PM — Project Life-Cycle Management

Shared project management system for every Apillis department: Sales, PMO, Engineering (incl. Engineering Lead), Production, Procurement, Warehouse, Logistics, QA/QC, Accounting, Service and Management. It covers the life cycle of a machine-building project, from RFQ to warranty, for EU/US customers.

* **Planning by IDEF0 (ICOM).** Each project gets an A0 → A1…A8 activity tree. Arrows are typed as Input, Control, Output or Mechanism, Outputs are linked to the Inputs that consume them, and staircase decomposition diagrams are drawn.
* **One source of truth.** BOM, PR, PO and stock records inherit upstream data read-only. Approved documents are locked. A BOM can only change through an approved ECO, which creates a new revision.
* **Approval matrix configurable in Settings.** Steps are defined by amount range in base currency. Steps can run in parallel or in sequence, and segregation of duties is enforced.
* **Permission matrix configurable in Settings.** Row Level Security in PostgreSQL checks the matrix on every request, and Warehouse/QA receive goods without seeing prices.
* **EU/US compliance dossier.** The checklist covers CE / Machinery Directive / EN 60204-1 / ISO 13849 and NFPA 79 / UL 508A / SCCR. A full audit trail and lot/serial traceability are kept.
* **Multi-level BOM** with customer part number / revision, ERP (Ecount) code, part & procurement type, drawing links, unit-of-measure master and **net requirement** (stock and MOQ aware). Customer **Structure BOM** and **Ecount item list** files import directly, with column mapping kept in Settings.
* **Costing** (price book, fee rules, labour templates, A→L price build-up like the quote sheet, approval, push to quotation) and **RFQ** (send to vendors, quote comparison, award → price book → PO).
* **Material requests** (v1.2): projects request material, the PM approves, the warehouse issues against the request (never more than requested, from the project bucket or general stock).
* **Logistics** (v1.2): shipments (inbound / outbound / internal) with route, carrier, vehicle, driver, packing list and freight cost charged to the project; freight cost by route / project.
* **Project finance** (v1.2): billing milestones (e.g. 30 % advance, 60 % after FAT) that become *ready to invoice* when their IDEF0 activity is done, customer invoices (e-invoice no. from MISA), payments in / out (capped by invoice / PO), **project P&L**, monthly **cash flow** (actual + forecast) and **receivables aging**.
* **Project closure** (v1.2): a checklist refuses to close a project while work is open; once closed every project record is read-only until Management reopens it.
* **Daily reminder digest** (v1.2): overdue tasks, approvals waiting, late POs, NCRs past due, overdue invoices, milestones to invoice, material to issue, low stock, late shipments — in the recipient's language.
* **Excel export for every module** (46 reports), filtered by project, date and status. **Excel import** loads legacy data.
* Bilingual **Vietnamese / English** UI. Notifications are sent in-app, by **e-mail** and to **Google Chat**. Password reset by e-mail.

| Folder | Content |
|---|---|
| `supabase/migrations` | PostgreSQL schema, business rules (triggers), RLS, RPCs, report views, reference data |
| `supabase/seed.sql` | Demo data for the desktop test environment |
| `web/` | React 19 + TypeScript + Vite single-page app |
| `notifier/` | Node.js service: e-mail (SMTP) + Google Chat delivery from `notification_outbox`, daily reminder digest |
| `deploy/` | Server compose override, Caddyfile, install / deploy / migrate / backup / restore scripts |
| `db-tests/` | Database test suite (66 tests: RLS, approvals, locks, BOM/ECO, multi-level BOM, costing, RFQ, PR/PO caps, stock, IDEF0, material requests, logistics, invoices / payments / P&L / cash flow, project closure lock, digest) |
| `e2e/` | End-to-end smoke test (real GoTrue + PostgREST + browser) |
| `docs/` | Installation guide (Vietnamese), screenshots |
| `PLAN.md` | Architecture, schema, API, task breakdown, deployment strategy |

## Quick start (desktop test)

Requirements: Docker Desktop, Node.js 22, Git.

```bash
npx supabase start                 # PostgreSQL + Auth + API + Storage + Studio, applies migrations + seed
cp web/.env.example web/.env       # paste the "anon key" printed by supabase start
npm --prefix web install
npm --prefix web run dev           # http://localhost:5173
```

The first account you sign up (with an @apillis.com e-mail) becomes the administrator. The step-by-step guide in Vietnamese is in [docs/HUONG-DAN-CAI-DAT.md](docs/HUONG-DAN-CAI-DAT.md).

## Tests

```bash
npm run setup     # install dependencies of all packages
npm test          # db-tests (66) + web typecheck/unit/contract (73) + notifier (9) + deploy (2)
```

The DB tests run on a plain PostgreSQL ≥ 15 (`PGURL`, default `postgresql://postgres:postgres@localhost:5432`) with a small Supabase stub. The end-to-end test needs no Docker: `bash e2e/stack.sh up && npm --prefix e2e test`.

## Production server

Ubuntu 24.04 + official Supabase self-host + `deploy/compose.apillis.yml` (Caddy HTTPS, pm-web, notifier).

```bash
bash deploy/scripts/install-server.sh v1.2.0   # once
deploy/scripts/deploy.sh v1.2.0                # backup → migrations → rebuild → restart
deploy/scripts/backup.sh                       # nightly via cron (3-2-1: server, NAS, cloud)
deploy/scripts/restore.sh <file.dump>          # restore / roll back a migration
```

See PLAN.md §8 and the Vietnamese guide for details.
