import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/**
 * Prompt templates (M4.12, lane D fills the bodies). `apply_style` and `furnish_room` are listed now
 * so the prompt-list snapshot exists; furnishing is a placeholder until M5 adds items.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'apply_style',
    { title: 'Apply a style', description: 'Restyle rooms of the flat (colours, floors, lighting) in one reviewed batch.', argsSchema: z.object({ style: z.string().describe('Style or mood, e.g. "warm Scandinavian".'), roomId: z.string().optional().describe('Limit to one room id.') }) },
    ({ style, roomId }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `TODO(M4.12): apply the style "${style}"${roomId ? ` to room ${roomId}` : ' to the flat'} using batch, then render_view to verify.` } }],
    }),
  );
  server.registerPrompt(
    'furnish_room',
    { title: 'Furnish a room', description: 'Placeholder until furniture items arrive in M5.', argsSchema: z.object({ roomId: z.string().describe('Room id.') }) },
    ({ roomId }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Furnishing is not available yet (planned for M5). Describe room ${roomId} with describe_room instead.` } }],
    }),
  );
}
