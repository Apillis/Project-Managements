import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, sql, as, asq, users, rejects, makeProject } from '../lib.js';

after(() => pool.end());

async function tree(u, projectId) {
  return asq(u, `select id, parent_id, node_code, seq, title, depth from activities where project_id = $1 order by node_code`, [projectId]);
}

test('lifecycle template builds an IDEF0 tree with ICOM arrows', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [{ apply_lifecycle_template: root }] = await asq(u.pmo, `select apply_lifecycle_template($1, null, 'en')`, [p.id]);
  const nodes = await tree(u.pmo, p.id);
  const codes = nodes.map((n) => n.node_code);
  assert.equal(nodes.find((n) => n.parent_id === null).id, root);
  for (const c of ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A31', 'A36', 'A64', 'A82']) {
    assert.ok(codes.includes(c), `missing ${c}`);
  }
  // ICOM: A3 input "Project plan" is fed by A2 output "Project plan"
  const [link] = await asq(u.pmo, `
    select src_a.node_code as src, tgt_a.node_code as tgt
      from activity_icoms tgt join activities tgt_a on tgt_a.id = tgt.activity_id
      join activity_icoms src on src.id = tgt.source_icom_id join activities src_a on src_a.id = src.activity_id
     where tgt_a.project_id = $1 and tgt.label = 'Project plan' and tgt_a.node_code = 'A3'`, [p.id]);
  assert.deepEqual(link, { src: 'A2', tgt: 'A3' });
  // four arrow types exist
  const types = await asq(u.pmo, `select distinct icom_type from activity_icoms i join activities a on a.id = i.activity_id
                                   where a.project_id = $1 order by 1`, [p.id]);
  assert.deepEqual(types.map((t) => t.icom_type), ['C', 'I', 'M', 'O']);
  // dates: leaves scheduled sequentially, parents roll up
  const [a3] = await asq(u.pmo, `select planned_start, planned_end from activities where project_id = $1 and node_code = 'A3'`, [p.id]);
  assert.ok(a3.planned_start && a3.planned_end && a3.planned_end > a3.planned_start);
  // cannot apply twice
  await rejects(asq(u.pmo, `select apply_lifecycle_template($1)`, [p.id]), /already has/);
  // vietnamese titles
  const p2 = await makeProject(u.pmo);
  await asq(u.pmo, `select apply_lifecycle_template($1, null, 'vi')`, [p2.id]);
  const [a1] = await asq(u.pmo, `select title from activities where project_id = $1 and node_code = 'A1'`, [p2.id]);
  assert.equal(a1.title, 'Bán hàng & hợp đồng');
});

test('IDEF0 rules: max 9 boxes per diagram, node codes follow the parent', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [root] = await asq(u.pmo, `insert into activities(project_id, title) values ($1, 'Build machine') returning *`, [p.id]);
  assert.equal(root.node_code, 'A0');
  const kids = [];
  for (let i = 1; i <= 9; i++) {
    const [k] = await asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, $3) returning *`, [p.id, root.id, 'Step ' + i]);
    kids.push(k);
  }
  assert.deepEqual(kids.map((k) => k.node_code), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9']);
  await rejects(asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'ten')`, [p.id, root.id]), /max 9/);
  const [g] = await asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'sub') returning *`, [p.id, kids[1].id]);
  assert.equal(g.node_code, 'A21');
  const [gg] = await asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'subsub') returning *`, [p.id, g.id]);
  assert.equal(gg.node_code, 'A211');
  // a second root is refused
  await rejects(asq(u.pmo, `insert into activities(project_id, title) values ($1, 'other root')`, [p.id]), /duplicate key/);
});

test('move_activity swaps positions and re-codes the whole subtree', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [root] = await asq(u.pmo, `insert into activities(project_id, title) values ($1, 'root') returning *`, [p.id]);
  const [a] = await asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'a') returning *`, [p.id, root.id]);
  const [b] = await asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'b') returning *`, [p.id, root.id]);
  const [a1] = await asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'a-1') returning *`, [p.id, a.id]);
  assert.equal(a1.node_code, 'A11');
  await asq(u.pmo, `select move_activity($1, $2, 2::smallint)`, [a.id, root.id]);
  const rows = await asq(u.pmo, `select title, node_code from activities where project_id = $1 order by node_code`, [p.id]);
  assert.deepEqual(rows, [
    { title: 'root', node_code: 'A0' }, { title: 'b', node_code: 'A1' },
    { title: 'a', node_code: 'A2' }, { title: 'a-1', node_code: 'A21' }]);
  // cycle prevention
  await rejects(asq(u.pmo, `update activities set parent_id = $1, seq = 1 where id = $2`, [a1.id, a.id]), /under itself/);
  // re-parent b under a (now A2) at position 2 → A22
  await asq(u.pmo, `select move_activity($1, $2, 2::smallint)`, [b.id, a.id]);
  const [bb] = await asq(u.pmo, `select node_code from activities where id = $1`, [b.id]);
  assert.equal(bb.node_code, 'A22');
});

test('ICOM: only an Output can feed an Input/Control of another activity', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [root] = await asq(u.pmo, `insert into activities(project_id, title) values ($1, 'root') returning *`, [p.id]);
  const [a] = await asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'design') returning *`, [p.id, root.id]);
  const [b] = await asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'build') returning *`, [p.id, root.id]);
  const [out] = await asq(u.pmo, `insert into activity_icoms(activity_id, icom_type, label) values ($1, 'O', 'Drawings') returning *`, [a.id]);
  const [inp] = await asq(u.pmo, `insert into activity_icoms(activity_id, icom_type, label) values ($1, 'I', 'Drawings') returning *`, [a.id]);
  await asq(u.pmo, `insert into activity_icoms(activity_id, icom_type, label, source_icom_id) values ($1, 'I', 'Drawings', $2)`, [b.id, out.id]);
  await rejects(asq(u.pmo, `insert into activity_icoms(activity_id, icom_type, label, source_icom_id) values ($1, 'C', 'x', $2)`, [b.id, inp.id]), /must be an Output/);
  await rejects(asq(u.pmo, `insert into activity_icoms(activity_id, icom_type, label, source_icom_id) values ($1, 'M', 'x', $2)`, [b.id, out.id]), /Only an Input or Control/);
  await rejects(asq(u.pmo, `insert into activity_icoms(activity_id, icom_type, label) values ($1, 'X', 'x')`, [b.id]), /check constraint/);
});

test('progress rolls up the tree; done = 100 %', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [root] = await asq(u.pmo, `insert into activities(project_id, title) values ($1, 'root') returning *`, [p.id]);
  const [a] = await asq(u.pmo, `insert into activities(project_id, parent_id, title, est_hours) values ($1, $2, 'a', 30) returning *`, [p.id, root.id]);
  await asq(u.pmo, `insert into activities(project_id, parent_id, title, est_hours) values ($1, $2, 'b', 10)`, [p.id, root.id]);
  await asq(u.engineering, `update activities set status = 'done' where id = $1`, [a.id]);
  const [r] = await asq(u.pmo, `select progress_pct, status from activities where id = $1`, [root.id]);
  assert.equal(Number(r.progress_pct), 75);
  assert.equal(r.status, 'in_progress');
  const [aa] = await asq(u.pmo, `select progress_pct, actual_start, actual_end from activities where id = $1`, [a.id]);
  assert.equal(Number(aa.progress_pct), 100);
  assert.ok(aa.actual_start && aa.actual_end);
  const [vp] = await asq(u.pmo, `select progress_pct from v_projects where id = $1`, [p.id]);
  assert.equal(Number(vp.progress_pct), 75);
});

test('accounting can read but not edit activities', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [root] = await asq(u.pmo, `insert into activities(project_id, title) values ($1, 'root') returning *`, [p.id]);
  const seen = await asq(u.accounting, `select id from activities where id = $1`, [root.id]);
  assert.equal(seen.length, 1);
  const upd = await asq(u.accounting, `update activities set title = 'x' where id = $1 returning id`, [root.id]);
  assert.equal(upd.length, 0);
});

test('timesheets: own hours, 24 h cap, submit, approve, segregation of duties', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [act] = await asq(u.pmo, `insert into activities(project_id, title) values ($1, 'root') returning *`, [p.id]);
  const [t1] = await asq(u.engineering, `insert into timesheets(work_date, project_id, activity_id, hours) values ('2026-11-03', $1, $2, 8) returning *`, [p.id, act.id]);
  await asq(u.engineering, `insert into timesheets(work_date, project_id, hours) values ('2026-11-03', $1, 10)`, [p.id]);
  await rejects(asq(u.engineering, `insert into timesheets(work_date, project_id, hours) values ('2026-11-03', $1, 7)`, [p.id]), /exceed 24/);
  await rejects(asq(u.engineering, `insert into timesheets(user_id, work_date, project_id, hours) values ($1, '2026-11-04', $2, 1)`, [u.qa, p.id]), /row-level security|own hours/);
  await rejects(asq(u.engineering, `insert into timesheets(work_date, project_id, hours, status) values ('2026-11-05', $1, 1, 'approved')`, [p.id]), /draft/);

  const [{ submit_timesheets: n }] = await asq(u.engineering, `select submit_timesheets('2026-11-01', '2026-11-30')`);
  assert.equal(n, 2);
  await rejects(asq(u.engineering, `update timesheets set hours = 1 where id = $1`, [t1.id]), /locked/);
  // engineering cannot approve, pmo can
  await rejects(asq(u.engineering, `select decide_timesheets(array[$1]::uuid[], 'approved')`, [t1.id]), /Not allowed/);
  await rejects(asq(u.pmo, `select decide_timesheets(array[$1]::uuid[], 'rejected')`, [t1.id]), /reason/);
  const [{ decide_timesheets: m }] = await asq(u.pmo, `select decide_timesheets(array[$1]::uuid[], 'approved')`, [t1.id]);
  assert.equal(m, 1);
  // a PM cannot approve his own hours
  const [own] = await asq(u.pmo, `insert into timesheets(work_date, project_id, hours) values ('2026-11-03', $1, 2) returning *`, [p.id]);
  await asq(u.pmo, `select submit_timesheets('2026-11-03', '2026-11-03')`);
  await rejects(asq(u.pmo, `select decide_timesheets(array[$1]::uuid[], 'approved')`, [own.id]), /own hours/);
  await asq(u.pmo2, `select decide_timesheets(array[$1]::uuid[], 'rejected', 'wrong project')`, [own.id]);
  // rejected → editable again and becomes draft
  const [ed] = await asq(u.pmo, `update timesheets set hours = 3 where id = $1 returning status`, [own.id]);
  assert.equal(ed.status, 'draft');
  // a user does not see colleagues' hours, approvers do
  const mine = await asq(u.qa, `select * from timesheets where project_id = $1`, [p.id]);
  assert.equal(mine.length, 0);
  const all = await asq(u.pmo, `select * from timesheets where project_id = $1`, [p.id]);
  assert.equal(all.length, 3);
});

test('closing a project stamps closed_at', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [c] = await asq(u.pmo, `update projects set status = 'closed' where id = $1 returning closed_at`, [p.id]);
  assert.ok(c.closed_at);
  const [r] = await asq(u.pmo, `update projects set status = 'active' where id = $1 returning closed_at`, [p.id]);
  assert.equal(r.closed_at, null);
});
