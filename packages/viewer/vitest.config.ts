import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'viewer',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
