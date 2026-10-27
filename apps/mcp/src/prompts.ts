import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/**
 * Prompt templates (M4.12). Each returns a message sequence the client shows or sends. Every tool
 * they mention is written in backticks; a test checks that each one exists in the tool registry.
 * `furnish_room` is a placeholder until furniture arrives in M5.
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

export function furnishRoomMessages(args: { roomId: string; brief: string }) {
  const room = clean(args.roomId);
  return [
    text(`The user wants to furnish the room "${room}". Brief: ${clean(args.brief)}`),
    text('Be upfront: placing furniture (items) arrives in a later milestone (M5) and is not available yet. Do not pretend to place anything, and do not try to simulate furniture with walls or lights.'),
    text(`Meanwhile you can prepare the room. Call \`describe_room\` for "${room}" to see its size, openings, daylight and current finishes, then propose floor, wall and ceiling finishes (\`room_set_floor\`, \`room_set_wall_finish\`, \`room_set_ceiling\`) and lighting (\`light_add\`, \`light_update\`) that suit the brief. Show a \`preview: true\` of the batch first, apply it only if the user agrees, and verify with \`render_view\`.`),
    text('Finish by summarising what is ready and what will be possible once furniture lands; offer `undo` if they want the changes reverted.'),
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
      description: 'Furniture arrives in M5; meanwhile prepare the room with finishes and lighting.',
      argsSchema: z.object({ roomId: z.string().max(64).describe('Room id.'), brief: z.string().max(500).describe('What the room is for and the look the user wants.') }),
    },
    (args) => ({ messages: furnishRoomMessages(args) }),
  );
}
