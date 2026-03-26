import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/mcp-server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  outDir: 'dist',
});
