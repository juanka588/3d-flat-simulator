import { describe, expect, it } from 'vitest';
import { connect, json } from './testing/inproc';

/** Plan coherence over MCP: validate_layout lists the findings with their fixes; apply_plan_fix applies them as one undo step. */
describe('plan check tools', () => {
  it('validate_layout lists plan findings with the commands of their fix, terse', async () => {
    const { client } = await connect();
    const r = json(await client.callTool({ name: 'validate_layout', arguments: {} }));
    expect(Array.isArray(r.plan)).toBe(true);
    const joint = r.plan.find((f: { code: string }) => f.code === 'wall-joint-no-overlap');
    expect(joint).toMatchObject({ advisory: true, fix: { safe: true } });
    expect(joint.fix.commands[0]).toMatchObject({ type: 'wall.setEnds' });
    expect(joint.id).toMatch(/^wall-joint-no-overlap:/);
    // One room: only the findings that name it.
    const sdb = json(await client.callTool({ name: 'validate_layout', arguments: { roomId: 'sdb' } }));
    for (const f of sdb.plan ?? []) expect(f.entities).toContain('sdb');
  });

  it('apply_plan_fix applies the safe fixes in one change that undo takes back; the findings are gone', async () => {
    const { client } = await connect();
    const before = json(await client.callTool({ name: 'validate_layout', arguments: {} })).plan.filter((f: { fix?: { safe: boolean } }) => f.fix?.safe);
    expect(before.length).toBeGreaterThan(0);
    const preview = json(await client.callTool({ name: 'apply_plan_fix', arguments: { ids: ['safe'], preview: true } }));
    expect(preview).toMatchObject({ ok: true, committed: false });
    const done = json(await client.callTool({ name: 'apply_plan_fix', arguments: { ids: ['safe'] } }));
    expect(done).toMatchObject({ ok: true, committed: true });
    expect(done.applied.length).toBe(before.length);
    const after = json(await client.callTool({ name: 'validate_layout', arguments: {} }));
    expect((after.plan ?? []).filter((f: { fix?: { safe: boolean } }) => f.fix?.safe)).toEqual([]);
    expect(json(await client.callTool({ name: 'undo', arguments: {} })).ok).toBe(true);
    const undone = json(await client.callTool({ name: 'validate_layout', arguments: {} }));
    expect(undone.plan.filter((f: { fix?: { safe: boolean } }) => f.fix?.safe).length).toBe(before.length);
  });

  it('apply_plan_fix says what is wrong for an unknown id and does not list the raw geometry commands as tools', async () => {
    const { client } = await connect();
    const r = json(await client.callTool({ name: 'apply_plan_fix', arguments: { ids: ['wall-gap:nope.end:nada'] } }));
    expect(r).toMatchObject({ ok: false, code: 'precondition_failed' });
    expect(r.message).toContain('no such finding');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('apply_plan_fix');
    expect(names).not.toContain('wall_set_ends');
    expect(names).not.toContain('room_set_polygon');
  });
});
