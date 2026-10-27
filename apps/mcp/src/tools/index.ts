import { commandTools } from './commandTools';
import { historyTools } from './history';
import { readTools } from './read';
import { assertValidRegistry, type ToolDef } from './registry';
import { stubTools } from './stubs';
import { viewTools } from './view';

/** Every tool, in the order they are listed: write tools (from `commandToolSchemas()`), read, view, render, history. */
export function allTools(): ToolDef[] {
  const tools = [...commandTools(), ...readTools(), ...viewTools(), ...stubTools(), ...historyTools()];
  assertValidRegistry(tools);
  return tools;
}

export * from './registry';
export { withMcpExtras } from './extras';
