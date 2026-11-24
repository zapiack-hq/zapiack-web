import { defineConfig } from 'tsup';

/** mediasoup-client ships fake connection parameters for its own tests, with a made-up ICE password. None of it is used at run time, so it stays out of the bundle. */
const withoutTestFixtures = {
  name: 'without-mediasoup-test-fixtures',
  setup(build: { onLoad: (o: { filter: RegExp }, cb: () => { contents: string; loader: 'js' }) => void }) {
    build.onLoad({ filter: /mediasoup-client[\\/]lib[\\/]test[\\/]fakeParameters\.js$/ }, () => ({ contents: 'export const generateRouterRtpCapabilities = () => ({}); export const generateNativeRtpCapabilities = () => ({}); export const generateNativeRtpCapabilitiesWithoutRtx = () => ({}); export const generateLocalDtlsParameters = () => ({}); export const generateTransportRemoteParameters = () => ({}); export const generateProducerRemoteParameters = () => ({}); export const generateConsumerRemoteParameters = () => ({}); export const generateDataProducerRemoteParameters = () => ({}); export const generateDataConsumerRemoteParameters = () => ({});', loader: 'js' }));
  },
};

const browser = { format: ['iife' as const], minify: true, target: 'es2020', outExtension: () => ({ js: '.js' }) };

export default defineConfig([
  { entry: { index: 'src/index.ts' }, format: ['cjs', 'esm'], dts: true, clean: true, target: 'es2020' },
  { entry: { 'zapiack.global': 'src/global.ts' }, globalName: 'ZapiackBundle', ...browser },
  // Voice & Video is its own bundle: it carries mediasoup-client, which push and messaging users never need to download.
  { entry: { 'zapiack-calls.global': 'src/calls-global.ts' }, globalName: 'ZapiackCallsBundle', esbuildPlugins: [withoutTestFixtures as never], ...browser },
  { entry: { calls: 'src/calls.ts' }, format: ['cjs', 'esm'], dts: true, target: 'es2020', external: ['mediasoup-client'] },
  { entry: { 'zapiack-sw': 'src/sw-entry.ts' }, ...browser },
]);
