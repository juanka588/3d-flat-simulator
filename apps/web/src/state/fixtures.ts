import charme from '@flat/scene/fixtures/charme-3205.flat.json';
import sample from '@flat/scene/fixtures/sample.flat.json';

export interface Fixture {
  id: string;
  label: string;
  text: string;
}

export const FIXTURES: readonly Fixture[] = [
  { id: 'charme-3205', label: 'Charme 3205 (real flat)', text: JSON.stringify(charme) },
  { id: 'sample', label: 'Sample (synthetic)', text: JSON.stringify(sample) },
];

export const DEFAULT_FIXTURE = FIXTURES[0]!;
