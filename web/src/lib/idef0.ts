// IDEF0 helpers: tree building and the staircase diagram layout (A-x diagram).
// Box i is placed below-right of box i-1. Inputs enter on the left, Controls
// on top, Outputs leave on the right, Mechanisms come from the bottom.

export interface Activity {
  id: string;
  parent_id: string | null;
  node_code: string;
  seq: number;
  title: string;
  status?: string;
  progress_pct?: number;
  [k: string]: unknown;
}

export interface Icom {
  id: string;
  activity_id: string;
  icom_type: 'I' | 'C' | 'O' | 'M';
  label: string;
  source_icom_id: string | null;
  sort: number;
}

export interface TreeNode<T extends Activity = Activity> {
  node: T;
  children: TreeNode<T>[];
}

export function buildTree<T extends Activity>(rows: T[]): TreeNode<T>[] {
  const map = new Map<string, TreeNode<T>>();
  rows.forEach((r) => map.set(r.id, { node: r, children: [] }));
  const roots: TreeNode<T>[] = [];
  for (const r of rows) {
    const n = map.get(r.id)!;
    if (r.parent_id && map.has(r.parent_id)) map.get(r.parent_id)!.children.push(n);
    else roots.push(n);
  }
  const sort = (list: TreeNode<T>[]) => {
    list.sort((a, b) => a.node.seq - b.node.seq);
    list.forEach((c) => sort(c.children));
  };
  sort(roots);
  return roots;
}

/** Path of ancestors (root first) of an activity id. */
export function ancestors<T extends Activity>(rows: T[], id: string): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: T[] = [];
  let cur = byId.get(id);
  while (cur) {
    out.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

export interface Box { id: string; x: number; y: number; w: number; h: number; code: string; title: string; status?: string; progress?: number }
export interface Arrow {
  id: string;
  type: 'I' | 'C' | 'O' | 'M';
  points: [number, number][];
  label: string;
  labelAt: [number, number];
  labelAnchor: 'start' | 'middle' | 'end';
  internal: boolean;
}
export interface Layout { width: number; height: number; boxes: Box[]; arrows: Arrow[] }

export const DIM = { W: 180, H: 92, GX: 90, GY: 48, ML: 170, MT: 90, MR: 170, MB: 90, LANE: 9 };

function ports(n: number, start: number, length: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.round(start + (length * (i + 1)) / (n + 1)));
}

export function layoutIdef0(children: Activity[], icoms: Icom[]): Layout {
  const acts = [...children].sort((a, b) => a.seq - b.seq);
  const { W, H, GX, GY, ML, MT, MR, MB, LANE } = DIM;
  const boxes: Box[] = acts.map((a, i) => ({
    id: a.id, x: ML + i * (W + GX), y: MT + i * (H + GY), w: W, h: H,
    code: a.node_code, title: a.title, status: a.status, progress: Number(a.progress_pct ?? 0),
  }));
  const boxOf = new Map(boxes.map((b) => [b.id, b]));
  const width = boxes.length ? boxes[boxes.length - 1].x + W + MR : ML + MR;
  const height = boxes.length ? boxes[boxes.length - 1].y + H + MB : MT + MB;
  const topMost = MT;
  const bottomMost = boxes.length ? boxes[boxes.length - 1].y + H : MT;

  const ids = new Set(acts.map((a) => a.id));
  const mine = icoms.filter((i) => ids.has(i.activity_id)).sort((a, b) => a.sort - b.sort);
  const byId = new Map(mine.map((i) => [i.id, i]));

  // port coordinates per arrow end
  const portPos = new Map<string, [number, number]>();
  for (const b of boxes) {
    for (const t of ['I', 'C', 'O', 'M'] as const) {
      const list = mine.filter((i) => i.activity_id === b.id && i.icom_type === t);
      const p = t === 'I' || t === 'O' ? ports(list.length, b.y, b.h) : ports(list.length, b.x, b.w);
      list.forEach((ic, k) => {
        const xy: [number, number] =
          t === 'I' ? [b.x, p[k]] : t === 'O' ? [b.x + b.w, p[k]] : t === 'C' ? [p[k], b.y] : [p[k], b.y + b.h];
        portPos.set(ic.id, xy);
      });
    }
  }

  const arrows: Arrow[] = [];
  const consumed = new Set<string>();
  const labelled = new Set<string>();
  let lane = 0;
  for (const tgt of mine) {
    if (!(tgt.icom_type === 'I' || tgt.icom_type === 'C') || !tgt.source_icom_id) continue;
    const src = byId.get(tgt.source_icom_id);
    if (!src) continue;   // source outside this diagram → drawn as external
    consumed.add(src.id);
    const [sx, sy] = portPos.get(src.id)!;
    const [tx, ty] = portPos.get(tgt.id)!;
    const tb = boxOf.get(tgt.activity_id)!;
    let pts: [number, number][];
    lane++;
    if (tgt.icom_type === 'I') {
      if (tx > sx + 24) {
        const mx = Math.round(sx + (tx - sx) / 2) + ((lane % 5) - 2) * 4;
        pts = [[sx, sy], [mx, sy], [mx, ty], [tx, ty]];
      } else {   // feedback: loop below the diagram
        const yLow = bottomMost + 20 + (lane % 6) * LANE;
        pts = [[sx, sy], [sx + 14, sy], [sx + 14, yLow], [tx - 14, yLow], [tx - 14, ty], [tx, ty]];
      }
    } else {
      if (tx > sx + 12 && ty > sy) {
        pts = [[sx, sy], [tx, sy], [tx, ty]];
      } else {   // feedback control: loop above
        const yTop = Math.min(topMost, tb.y) - 20 - (lane % 6) * LANE;
        pts = [[sx, sy], [sx + 14, sy], [sx + 14, yTop], [tx, yTop], [tx, ty]];
      }
    }
    // one label per source output (branches of the same arrow are not repeated)
    const label = labelled.has(src.id) ? '' : tgt.label;
    labelled.add(src.id);
    arrows.push({ id: tgt.id, type: tgt.icom_type, points: pts, label,
      labelAt: [sx + 6, sy - 5], labelAnchor: 'start', internal: true });
  }

  // external arrows
  for (const ic of mine) {
    const [x, y] = portPos.get(ic.id)!;
    if (ic.icom_type === 'I' && !(ic.source_icom_id && byId.has(ic.source_icom_id))) {
      arrows.push({ id: ic.id, type: 'I', points: [[18, y], [x, y]], label: ic.label, labelAt: [22, y - 5], labelAnchor: 'start', internal: false });
    } else if (ic.icom_type === 'C' && !(ic.source_icom_id && byId.has(ic.source_icom_id))) {
      arrows.push({ id: ic.id, type: 'C', points: [[x, 16], [x, y]], label: ic.label, labelAt: [x + 4, 26], labelAnchor: 'start', internal: false });
    } else if (ic.icom_type === 'O' && !consumed.has(ic.id)) {
      arrows.push({ id: ic.id, type: 'O', points: [[x, y], [width - 18, y]], label: ic.label, labelAt: [width - 22, y - 5], labelAnchor: 'end', internal: false });
    } else if (ic.icom_type === 'M') {
      arrows.push({ id: ic.id, type: 'M', points: [[x, height - 16], [x, y]], label: ic.label, labelAt: [x + 4, height - 22], labelAnchor: 'start', internal: false });
    }
  }
  return { width, height, boxes, arrows };
}

/** SVG path string for a polyline */
export function pathOf(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
}

/** Split a title into lines that fit a box. */
export function wrapText(text: string, maxChars = 22, maxLines = 3): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].slice(0, maxChars - 1) + '…';
    return kept;
  }
  return lines;
}
