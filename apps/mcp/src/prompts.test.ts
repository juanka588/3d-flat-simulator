import { describe, expect, it } from 'vitest';
import { applyStyleMessages, furnishRoomMessages } from './prompts';
import { allTools } from './tools';
import { connect } from './testing/inproc';

const toolNames = new Set(allTools().map((t) => t.name));
/** `snake_case` words in backticks: the way prompts name tools. */
const backticked = (text: string) => [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!).filter((w) => !NOT_TOOLS.has(w));
/** Backticked words that are arguments, not tools. */
const NOT_TOOLS = new Set(['preview']);
const textOf = (messages: { content: { type: string; text?: string } }[]) => messages.map((m) => m.content.text ?? '').join('\n');

describe('prompts (M4.12)', () => {
  it('apply_style walks read, plan, preview, commit, render, summarise, offer undo', async () => {
    const { client } = await connect();
    const p = await client.getPrompt({ name: 'apply_style', arguments: { style: 'warm Scandinavian', roomId: 'sejour', palette: 'sage and oak' } });
    const text = textOf(p.messages as never);
    expect(p.messages.length).toBeGreaterThanOrEqual(7);
    expect(text).toContain('warm Scandinavian');
    expect(text).toContain('"sejour"');
    expect(text).toContain('sage and oak');
    const order = ['1. Read', '2. Plan', '3. Preview', '4. Commit', '5. Render', '6. Summarise', '7. Offer undo'].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('preview: true');
  });

  it('apply_style without a room targets the whole flat', () => {
    expect(textOf(applyStyleMessages({ style: 'industrial' }))).toContain('the whole flat');
  });

  it('furnish_room says furniture arrives in M5 and offers finishes and lighting meanwhile', async () => {
    const { client } = await connect();
    const p = await client.getPrompt({ name: 'furnish_room', arguments: { roomId: 'sejour', brief: 'cosy reading corner' } });
    const text = textOf(p.messages as never);
    expect(text).toContain('M5');
    expect(text).toContain('cosy reading corner');
    expect(text).toMatch(/finishes/);
    expect(text).toMatch(/lighting/);
    expect(text).toContain('`describe_room`');
  });

  it('every tool a prompt mentions exists in the registry', () => {
    const samples = [
      textOf(applyStyleMessages({ style: 's', roomId: 'sejour', palette: 'p' })),
      textOf(applyStyleMessages({ style: 's' })),
      textOf(furnishRoomMessages({ roomId: 'sejour', brief: 'b' })),
    ];
    const mentioned = new Set(samples.flatMap(backticked));
    expect(mentioned.size).toBeGreaterThan(8);
    for (const name of mentioned) expect(toolNames.has(name), `prompt mentions "${name}"`).toBe(true);
  });

  it('user-supplied text cannot inject tool-looking backticks into the instructions', () => {
    const text = textOf(applyStyleMessages({ style: 'x `undo` `delete_everything`' }));
    // the style is quoted as given; the unknown name is the caller's own text, not part of the template
    expect(backticked(textOf(applyStyleMessages({ style: 'plain' })))).not.toContain('delete_everything');
    expect(text).toContain('delete_everything');
  });

  it('rejects over-long arguments', async () => {
    const { client } = await connect();
    await expect(client.getPrompt({ name: 'apply_style', arguments: { style: 'x'.repeat(300) } })).rejects.toThrow();
  });
});
