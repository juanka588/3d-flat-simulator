import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/**
 * Prompt templates (M4.12). Each returns a message sequence the client shows or sends. Every tool
 * they mention is written in backticks; a test checks that each one exists in the tool registry.
 */

const text = (t: string) => ({ role: 'user' as const, content: { type: 'text' as const, text: t } });
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export function applyStyleMessages(args: { style: string; roomId?: string | undefined; palette?: string | undefined }) {
  const style = clean(args.style);
  const scope = args.roomId ? `the room "${clean(args.roomId)}" only` : 'the whole flat';
  const palette = args.palette ? ` Use this palette: ${clean(args.palette)}.` : '';
  return [
    text(`Restyle ${scope} in the style: ${style}.${palette} Follow these steps in order and keep the user informed.`),
    text('1. Read. Call `get_scene_summary`, then `list_rooms` and `describe_room` for each room in scope. Note the current finishes, which walls are structural, and which faces are shared with other rooms. Read `docs://conventions` if you are unsure about left/right or finish precedence.'),
    text('2. Plan. Choose colours and materials for walls, floors and ceilings, plus a lighting mood (lamp colour temperature). Check `list_materials` for library textures. Tell the user the plan in a few lines before changing anything. Take a `checkpoint` named "before-style".'),
    text('3. Preview. Build ONE `batch` (label = your plan in one sentence): `material_define` for every new material first, then `room_set_wall_finish`, `room_set_floor`, `room_set_ceiling`, and `light_update` as needed. Prefer room-scoped finishes so neighbouring rooms keep their look. Call it first with `preview: true` and check the diff and warnings.'),
    text('4. Commit. If the preview matches the plan, send the same `batch` without `preview`. If a command is refused (structural walls, unknown ids), fix the plan; never work around a structural refusal.'),
    text('5. Render. Verify the result with `render_view` (a room or walk view; use `set_sun_time` for evening lighting).'),
    text('6. Summarise. Tell the user what changed (rooms, materials, lights) and anything you could not do.'),
    text('7. Offer undo. Say that `undo` reverts the whole batch (the history is shared with the user) and that `restore_checkpoint` with "before-style" returns to the starting point.'),
  ];
}

const money = (n: number) => `${Math.round(n * 100) / 100} EUR`;

export function furnishRoomMessages(args: { roomId: string; brief: string; budgetEur?: number | undefined }) {
  const room = clean(args.roomId);
  const budget = args.budgetEur;
  const budgetText = budget !== undefined ? `Budget: ${money(budget)} in total, TTC (tax included) prices of the items you place; existing locked furniture counts 0.` : 'No budget was given: ask the user for one before you buy anything, or keep the total modest and say what it is.';
  const cap = budget !== undefined ? ` with \`budgetEur\` ${budget}` : '';
  return [
    text(`The user wants to furnish the room "${room}". Brief: ${clean(args.brief)}. ${budgetText} Follow these steps in order and keep the user informed. Only real products can be placed: you never invent furniture, prices or sizes.`),
    text(`1. Read. Call \`describe_room\` for "${room}": size, ceiling, doors and windows (their swings and sills), daylight, and the items already there (locked ones are existing furniture: plan around them, never move or remove them). Call \`list_providers\` and use only enabled providers whose circuit is not open. Note the free wall lengths.`),
    text('2. Search. Use `search_products` per piece of furniture the brief needs (category, `maxPrice`, and maxWidth / maxDepth / maxHeight taken from the room size, so every result fits). Keep the queries few: searches are limited to 20 per minute. Only products these searches (or `get_product`) returned in this session can be placed.'),
    text('3. Pick. Call `get_product` for the few products you choose: check the TTC price, the dimensions, the variants (colours or sizes) and weightKg. Keep the running total below the budget; prefer fewer, well-chosen pieces over filling the room. Tell the user your picks and the total before placing anything.'),
    text('4. Position. Call `get_placement_options` for each pick with the relation you want (against_wall, in_corner, facing, next_to, under_window, centered_in). Use a valid candidate; never block a door swing or a window, and keep the walkways free (0.8 m, 0.9 m at the entry). Heavy wall mounts only on structural walls. Structural walls stay untouched. Take a `checkpoint` named "before-furnish".'),
    text('5. Preview. Make ONE call of `place_item` with items[] holding every pick (one undo step), `preview: true` and a `render` (an overview of the room), plus a `label` like "Furnish the room". Check the diff, the warnings and the picture. If a spot was refused, use the candidates it returned.'),
    text(`6. Validate. Call \`validate_layout\` for "${room}"${cap}: there must be no violations and overBudget must be false. Fix the picks or positions and preview again otherwise. Then call \`get_bill_of_materials\` for the room and check the total.`),
    text('7. Apply. If the preview is right, send the same `place_item` call without `preview`, with `ifRev` set to the baseRev of the preview. If it is refused as stale, read the room again and redo steps 4 to 6.'),
    text(`8. Render. Call \`render_view\` with view "room" for "${room}", then view "walk" for "${room}" as someone coming in through the door would see it: set facing to the compass point of the wall opposite the door (see the doors in describe_room). Look at the pictures: nothing floating, nothing in a doorway, the light as expected. Keep any caption the render returns (for example "IKEA models, personal use").`),
    text('9. Summarise. Give a price table with one row per item: item, sku (productId), dimensions (w x d x h m), price (TTC), link. Add the total, which must stay at or below the budget, and the note "indicative prices as of <date>" using the oldest snapshot date in the bill of materials. Mention anything you could not do, and that prices and stock can change.'),
    text('10. Offer undo. Say that `undo` reverts the whole furnishing batch in one step (the history is shared with the user) and that `restore_checkpoint` with "before-furnish" returns to the starting point.'),
  ];
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'apply_style',
    {
      title: 'Apply a style',
      description: 'Restyle rooms of the flat (colours, floors, lighting) in one reviewed batch: read, plan, preview, commit, render, summarise, offer undo.',
      argsSchema: z.object({
        style: z.string().max(200).describe('Style or mood, e.g. "warm Scandinavian".'),
        roomId: z.string().max(64).optional().describe('Limit to one room id.'),
        palette: z.string().max(200).optional().describe('Optional colours to use, e.g. "sage, off-white, oak".'),
      }),
    },
    (args) => ({ messages: applyStyleMessages(args) }),
  );
  server.registerPrompt(
    'furnish_room',
    {
      title: 'Furnish a room',
      description: 'Furnish a room with real products within a budget: read, search, pick, position, preview, validate, apply, render, price table, offer undo.',
      argsSchema: z.object({
        roomId: z.string().max(64).describe('Room id.'),
        brief: z.string().max(500).describe('What the room is for and the look the user wants.'),
        budgetEur: z
          .string()
          .regex(/^\d{1,7}(\.\d{1,2})?$/, 'a number of euros, e.g. 1500')
          .optional()
          .describe('Total budget in EUR, TTC prices (e.g. "1500"). Locked existing furniture counts 0.'),
      }),
    },
    (args) => ({ messages: furnishRoomMessages({ roomId: args.roomId, brief: args.brief, budgetEur: args.budgetEur === undefined ? undefined : Number(args.budgetEur) }) }),
  );
}
