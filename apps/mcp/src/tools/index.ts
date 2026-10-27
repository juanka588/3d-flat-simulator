import { commandTools } from './commandTools';
import { historyTools } from './history';
import { readTools } from './read';
import { assertValidRegistry, type ToolDef } from './registry';
import { renderTools } from './render';
import { viewTools } from './view';

/** Every tool, in the order they are listed: write tools (from `commandToolSchemas()`), read, view, render, history. */
export function allTools(limits?: { maxBatch: number }): ToolDef[] {
  const tools = [...commandTools(limits), ...readTools(), ...viewTools(), ...renderTools(), ...historyTools()];
  assertValidRegistry(tools);
  return tools;
}

export * from './registry';
export { withMcpExtras } from './extras';
