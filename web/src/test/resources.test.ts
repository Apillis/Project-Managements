import { describe, expect, it } from 'vitest';
import { E, RESOURCES, newRecord, toPayload, validate } from '../lib/resources';
import { EXPORTS, findExport } from '../lib/exports';

describe('resource definitions', () => {
  it('every select field has options and every ref field a ref', () => {
    for (const r of Object.values(RESOURCES)) {
      for (const f of [...r.fields, ...(r.lines?.fields ?? [])]) {
        if (f.type === 'select') expect(f.options?.length, `${r.key}.${f.name}`).toBeGreaterThan(0);
        if (f.type === 'ref') expect(f.ref, `${r.key}.${f.name}`).toBeTruthy();
      }
    }
  });

  it('every export key referenced by a resource exists', () => {
    for (const r of Object.values(RESOURCES)) if (r.exportKey) expect(findExport(r.exportKey), r.key).toBeTruthy();
  });

  it('export keys are unique and statuses are known enum values', () => {
    const keys = EXPORTS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    const all = new Set(Object.values(E).flat() as string[]);
    for (const e of EXPORTS) for (const s of e.statuses ?? []) expect(all.has(s), `${e.key}:${s}`).toBe(true);
  });

  it('open (post-submission) fields are real header fields', () => {
    for (const r of Object.values(RESOURCES)) for (const f of r.openFields ?? []) expect(r.fields.map((x) => x.name), `${r.key}.${f}`).toContain(f);
  });

  it('next-status buttons only use statuses of the resource', () => {
    for (const r of Object.values(RESOURCES)) {
      for (const [from, tos] of Object.entries(r.nextStatuses ?? {})) {
        expect(r.statusEnum, r.key).toContain(from);
        for (const t of tos) expect(r.statusEnum, `${r.key} → ${t}`).toContain(t);
      }
    }
  });
});

describe('form helpers', () => {
  const fields = RESOURCES.purchase_orders.lines!.fields;
  it('creates defaults', () => {
    const r = newRecord(RESOURCES.projects.fields, { projectId: 'x' });
    expect(r.status).toBe('planning');
    expect(r.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const b = newRecord(RESOURCES.boms.fields, { projectId: 'p1' });
    expect(b.project_id).toBe('p1');
  });
  it('validates required, numbers and ranges', () => {
    expect(validate(fields, { qty: '', unit_price: 'x', discount_pct: 120 })).toEqual({ qty: 'v.required', unit_price: 'v.number', discount_pct: 'v.max' });
    expect(validate(RESOURCES.partners.fields, { code: 'A', name: 'B', email: 'bad' })).toEqual({ email: 'v.email' });
  });
  it('builds payloads: numbers converted, empty → null, read-only and create-only respected', () => {
    const p = toPayload(fields, { qty: '2', unit_price: '10.5', description: ' ', extra: 1 }, true);
    expect(p).toEqual({ qty: 2, unit_price: 10.5, description: null });
    const bom = toPayload(RESOURCES.boms.fields, { project_id: 'p', name: 'X', revision: 'B', notes: 'n' }, false);
    expect(bom).toEqual({ notes: 'n' });
  });
});
