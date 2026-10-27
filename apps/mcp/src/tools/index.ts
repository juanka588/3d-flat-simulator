import { commandTools } from './commandTools';
import { assertValidRegistry, type ToolDef } from './registry';
import { stubTools } from './stubs';

/** Every tool, in the order they are listed: write tools (from `commandToolSchemas()`), then the rest. */
export function allTools(): ToolDef[] {
  const tools = [...commandTools(), ...stubTools()];
  assertValidRegistry(tools);
  return tools;
}

export * from './registry';
