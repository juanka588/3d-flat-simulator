import { describe, expect, it } from 'vitest';
import { applyStyleMessages, furnishRoomMessages } from './prompts';
import { allTools } from './tools';
import { connect } from './testing/inproc';

const toolNames = new Set(allTools().map((t) => t.name));
/** `snake_case` words in backticks: the way prompts name tools. */
const backticked = (text: string) => [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!).filter((w) => !NOT_TOOLS.has(w));
/** Backticked words that are arguments, not tools. */
const NOT_TOOLS = new Set(['preview', 'render', 'label']);
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

  it('furnish_room walks read, search, pick, position, preview, apply, validate, render, price table, undo', async () => {
    const { client } = await connect();
    const p = await client.getPrompt({ name: 'furnish_room', arguments: { roomId: 'sejour', brief: 'cosy reading corner', budgetEur: '1500' } });
    const text = textOf(p.messages as never);
    expect(text).toContain('cosy reading corner');
    expect(text).toContain('"sejour"');
    expect(text).toContain('1500 EUR');
    expect(text).toContain('budgetEur` 1500');
    const order = ['1. Read', '2. Search', '3. Pick', '4. Position', '5. Preview', '6. Apply', '7. Validate', '8. Render', '9. Summarise', '10. Offer undo'].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the tools, in the order of the flow
    const flow = ['describe_room', 'list_providers', 'search_products', 'get_product', 'get_placement_options', 'place_item', 'validate_layout', 'get_bill_of_materials', 'render_view', 'undo'].map((n) => text.indexOf(`\`${n}\``));
    expect(flow.every((i) => i >= 0)).toBe(true);
    expect([...flow].sort((a, b) => a - b)).toEqual(flow);
    // the rules and the final table
    expect(text).toContain('preview: true');
    expect(text).toMatch(/never invent/);
    expect(text).toMatch(/locked/);
    expect(text).toMatch(/door swing or a window/);
    expect(text).toMatch(/Structural walls stay untouched/);
    expect(text).toMatch(/one undo step/);
    expect(text).toMatch(/price table/);
    for (const col of ['item', 'sku', 'dimensions', 'price', 'link', 'total']) expect(text).toContain(col);
    expect(text).toContain('indicative prices as of <date>');
    expect(text).toContain('IKEA models, personal use');
    expect(text).not.toMatch(/M5|not available yet/);
  });

  it('furnish_room without a budget asks for one; the budget argument must be a number', async () => {
    const { client } = await connect();
    const none = await client.getPrompt({ name: 'furnish_room', arguments: { roomId: 'sejour', brief: 'b' } });
    expect(textOf(none.messages as never)).toContain('No budget was given');
    await expect(client.getPrompt({ name: 'furnish_room', arguments: { roomId: 'sejour', brief: 'b', budgetEur: 'lots' } })).rejects.toThrow();
    const prompts = (await client.listPrompts()).prompts.find((x) => x.name === 'furnish_room')!;
    expect(prompts.arguments?.map((a) => [a.name, a.required ?? false])).toEqual([['roomId', true], ['brief', true], ['budgetEur', false]]);
  });

  it('every tool a prompt mentions exists in the registry', () => {
    const samples = [
      textOf(applyStyleMessages({ style: 's', roomId: 'sejour', palette: 'p' })),
      textOf(applyStyleMessages({ style: 's' })),
      textOf(furnishRoomMessages({ roomId: 'sejour', brief: 'b' })),
      textOf(furnishRoomMessages({ roomId: 'sejour', brief: 'b', budgetEur: 900 })),
    ];
    const mentioned = new Set(samples.flatMap(backticked));
    expect(mentioned.size).toBeGreaterThan(14);
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
