import { describe, expect, it } from 'vitest';
import { ancestors, buildTree, DIM, layoutIdef0, pathOf, wrapText, type Activity, type Icom } from '../lib/idef0';

const acts: Activity[] = [
  { id: 'r', parent_id: null, node_code: 'A0', seq: 0, title: 'Deliver machine' },
  { id: 'b', parent_id: 'r', node_code: 'A2', seq: 2, title: 'Build' },
  { id: 'a', parent_id: 'r', node_code: 'A1', seq: 1, title: 'Design' },
  { id: 'c', parent_id: 'r', node_code: 'A3', seq: 3, title: 'Test' },
  { id: 'a1', parent_id: 'a', node_code: 'A11', seq: 1, title: 'Concept' },
];

const ic = (id: string, activity_id: string, icom_type: Icom['icom_type'], label: string, source_icom_id: string | null = null, sort = 1): Icom =>
  ({ id, activity_id, icom_type, label, source_icom_id, sort });

describe('tree helpers', () => {
  it('builds a sorted tree', () => {
    const t = buildTree(acts);
    expect(t).toHaveLength(1);
    expect(t[0].children.map((c) => c.node.node_code)).toEqual(['A1', 'A2', 'A3']);
    expect(t[0].children[0].children[0].node.id).toBe('a1');
  });
  it('returns ancestors root first', () => {
    expect(ancestors(acts, 'a1').map((a) => a.node_code)).toEqual(['A0', 'A1', 'A11']);
  });
});

describe('layoutIdef0', () => {
  const children = acts.filter((a) => a.parent_id === 'r');
  const icoms: Icom[] = [
    ic('i1', 'a', 'I', 'Customer spec'),
    ic('o1', 'a', 'O', 'Drawings'),
    ic('i2', 'b', 'I', 'Drawings', 'o1'),
    ic('c1', 'b', 'C', 'ISO 9001'),
    ic('m1', 'b', 'M', 'Technicians'),
    ic('o2', 'c', 'O', 'Defects'),
    ic('o3', 'c', 'O', 'Test report', null, 2),
    ic('i3', 'a', 'C', 'Defects', 'o2', 2),          // feedback control from A3 → A1
    ic('x', 'a1', 'I', 'not in this diagram'),
  ];
  const L = layoutIdef0(children, icoms);

  it('places boxes on a descending staircase ordered by seq', () => {
    expect(L.boxes.map((b) => b.code)).toEqual(['A1', 'A2', 'A3']);
    for (let i = 1; i < L.boxes.length; i++) {
      expect(L.boxes[i].x).toBe(L.boxes[i - 1].x + DIM.W + DIM.GX);
      expect(L.boxes[i].y).toBe(L.boxes[i - 1].y + DIM.H + DIM.GY);
    }
    expect(L.width).toBe(L.boxes[2].x + DIM.W + DIM.MR);
  });

  it('draws an internal link from the output of A1 to the input of A2', () => {
    const a = L.arrows.find((x) => x.id === 'i2')!;
    const [A, B] = L.boxes;
    expect(a.internal).toBe(true);
    expect(a.points[0][0]).toBe(A.x + A.w);                       // leaves right side of A1
    expect(a.points[a.points.length - 1][0]).toBe(B.x);           // enters left side of A2
    expect(a.points[0][1]).toBeGreaterThan(A.y);
    expect(a.points[a.points.length - 1][1]).toBeLessThan(B.y + B.h);
    // consumed output is not drawn again as an external output
    expect(L.arrows.filter((x) => x.id === 'o1')).toHaveLength(0);
  });

  it('routes a feedback control above the diagram', () => {
    const f = L.arrows.find((x) => x.id === 'i3')!;
    expect(f.internal).toBe(true);
    const minY = Math.min(...f.points.map((p) => p[1]));
    expect(minY).toBeLessThan(L.boxes[0].y);
    expect(f.points[f.points.length - 1][1]).toBe(L.boxes[0].y);   // ends on top edge of A1
  });

  it('draws external arrows on the correct sides', () => {
    const inp = L.arrows.find((x) => x.id === 'i1')!;
    expect(inp.points[0][0]).toBeLessThan(L.boxes[0].x);
    const ctl = L.arrows.find((x) => x.id === 'c1')!;
    expect(ctl.points[0][1]).toBeLessThan(L.boxes[1].y);
    const mech = L.arrows.find((x) => x.id === 'm1')!;
    expect(mech.points[0][1]).toBeGreaterThan(L.boxes[1].y + L.boxes[1].h);
    expect(L.arrows.some((x) => x.id === 'o2')).toBe(false);   // consumed by the feedback
    const out = L.arrows.find((x) => x.id === 'o3')!;
    expect(out.points[1][0]).toBeGreaterThan(L.boxes[2].x + L.boxes[2].w);
    expect(L.arrows.some((x) => x.id === 'x')).toBe(false);
  });

  it('handles an empty diagram', () => {
    expect(layoutIdef0([], []).boxes).toEqual([]);
  });
});

describe('text helpers', () => {
  it('wraps and truncates titles', () => {
    expect(wrapText('Design review & BOM release', 14)).toEqual(['Design review', '& BOM release']);
    const long = wrapText('a b c d e f g h i j k l m n o p q r s t u v w x y z', 6, 2);
    expect(long).toHaveLength(2);
    expect(long[1].endsWith('…')).toBe(true);
  });
  it('builds SVG paths', () => {
    expect(pathOf([[0, 0], [10, 0], [10, 5]])).toBe('M0,0 L10,0 L10,5');
  });
});
