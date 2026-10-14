# Apillis PM — Project Life-Cycle Management

Shared project management system for every Apillis department: Sales, PMO, Engineering (incl. Engineering Lead), Production, Procurement, Warehouse, Logistics, QA/QC, Accounting, Service and Management. It covers the life cycle of a machine-building project, from RFQ to warranty, for EU/US customers.

* **Planning by IDEF0 (ICOM).** Each project gets an A0 → A1…A8 activity tree. Arrows are typed as Input, Control, Output or Mechanism, Outputs are linked to the Inputs that consume them, and staircase decomposition diagrams are drawn.
* **One source of truth.** BOM, PR, PO and stock records inherit upstream data read-only. Approved documents are locked. A BOM can only change through an approved ECO, which creates a new revision.
* **Approval matrix configurable in Settings.** Steps are defined by amount range in base currency. Steps can run in parallel or in sequence, and segregation of duties is enforced.
* **Permission matrix configurable in Settings.** Row Level Security in PostgreSQL checks the matrix on every request, and Warehouse/QA receive goods without seeing prices.
* **EU/US compliance dossier.** The checklist covers CE / Machinery Directive / EN 60204-1 / ISO 13849 and NFPA 79 / UL 508A / SCCR. A full audit trail and lot/serial traceability are kept.
* **Excel export for every module** (32 reports), filtered by project, date and status. **Excel import** loads legacy data.
* Bilingual **Vietnamese / English** UI. Notifications are sent in-app, by **e-mail** and to **Google Chat**.

| Folder | Content |
|---|---|
| `supabase/migrations` | PostgreSQL schema, business rules (triggers), RLS, RPCs, report views, reference data |
| `supabase/seed.sql` | Demo data for the desktop test environment |
| `web/` | React 19 + TypeScript + Vite single-page app |
| `notifier/` | Node.js service: e-mail (SMTP) + Google Chat delivery from `notification_outbox` |
| `deploy/` | Server compose override, Caddyfile, install / deploy / migrate / backup / restore scripts |
| `db-tests/` | Database test suite (41 tests: RLS, approvals, locks, BOM/ECO, PR/PO caps, stock, IDEF0) |
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
npm test          # db-tests (41) + web typecheck/unit/contract (47) + notifier (8) + deploy (2)
```

The DB tests run on a plain PostgreSQL ≥ 15 (`PGURL`, default `postgresql://postgres:postgres@localhost:5432`) with a small Supabase stub. The end-to-end test needs no Docker: `bash e2e/stack.sh up && npm --prefix e2e test`.

## Production server

Ubuntu 24.04 + official Supabase self-host + `deploy/compose.apillis.yml` (Caddy HTTPS, pm-web, notifier).

```bash
bash deploy/scripts/install-server.sh v1.0.0   # once
deploy/scripts/deploy.sh v1.1.0                # backup → migrations → rebuild → restart
deploy/scripts/backup.sh                       # nightly via cron (3-2-1: server, NAS, cloud)
deploy/scripts/restore.sh <file.dump>          # restore / roll back a migration
```

See PLAN.md §8 and the Vietnamese guide for details.
