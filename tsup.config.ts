import { defineConfig } from 'tsup';

const browser = { format: ['iife' as const], minify: true, target: 'es2020', outExtension: () => ({ js: '.js' }) };

export default defineConfig([
  { entry: { index: 'src/index.ts' }, format: ['cjs', 'esm'], dts: true, clean: true, target: 'es2020' },
  { entry: { 'zapiack.global': 'src/global.ts' }, globalName: 'ZapiackBundle', ...browser },
  { entry: { 'zapiack-sw': 'src/sw-entry.ts' }, ...browser },
]);
