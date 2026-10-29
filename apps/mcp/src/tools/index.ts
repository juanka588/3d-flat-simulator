import { commandTools } from './commandTools';
import { historyTools } from './history';
import { placementTools } from './placement';
import { matchTools } from './match';
import { productTools } from './products';
import { readTools } from './read';
import { assertValidRegistry, type ToolDef } from './registry';
import { referenceTools } from './reference';
import { referenceDescriptorTools } from './referenceDescriptor';
import { renderTools } from './render';
import { scoreTools } from './score';
import { viewTools } from './view';

/** Every tool, in the order they are listed: write tools (from `commandToolSchemas()`) and `place_item`, read, product and layout reads, view, render, history. */
export function allTools(limits?: { maxBatch: number }): ToolDef[] {
  const tools = [...commandTools(limits), ...placementTools().filter((t) => t.mutatesScene), ...readTools(), ...productTools(), ...matchTools(), ...placementTools().filter((t) => !t.mutatesScene), ...viewTools(), ...renderTools(), ...referenceTools(), ...referenceDescriptorTools(), ...scoreTools(), ...historyTools()];
  assertValidRegistry(tools);
  return tools;
}

export * from './registry';
export { withMcpExtras } from './extras';
