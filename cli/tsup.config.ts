import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node24',
  clean: true,
  shims: true,
  splitting: false,
})
