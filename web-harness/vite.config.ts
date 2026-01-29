import { MOCK_SCENARIO } from './harness-env';
import { createMockFsPlugin } from './mock-fs-server';
import react from '@vitejs/plugin-react';
import path from 'path';
import { Plugin, defineConfig } from 'vite';

// Custom plugin to handle module resolution for Node.js and workspace packages
function browserMocksPlugin(): Plugin {
  const mocks: Record<string, string> = {
    // Node.js modules
    'node:fs': path.resolve(__dirname, './node-mocks.ts'),
    'node:fs/promises': path.resolve(__dirname, './node-mocks.ts'),
    fs: path.resolve(__dirname, './node-mocks.ts'),
    'fs/promises': path.resolve(__dirname, './node-mocks.ts'),
    'node:path': path.resolve(__dirname, './node-mocks.ts'),
    path: path.resolve(__dirname, './node-mocks.ts'),
    'node:url': path.resolve(__dirname, './node-mocks.ts'),
    url: path.resolve(__dirname, './node-mocks.ts'),
    'node:child_process': path.resolve(__dirname, './node-mocks.ts'),
    child_process: path.resolve(__dirname, './node-mocks.ts'),
    'node:os': path.resolve(__dirname, './node-mocks.ts'),
    os: path.resolve(__dirname, './node-mocks.ts'),
    'node:crypto': path.resolve(__dirname, './node-mocks.ts'),
    crypto: path.resolve(__dirname, './node-mocks.ts'),
    'node:events': path.resolve(__dirname, './node-mocks.ts'),
    events: path.resolve(__dirname, './node-mocks.ts'),
    'node:stream': path.resolve(__dirname, './node-mocks.ts'),
    stream: path.resolve(__dirname, './node-mocks.ts'),
    'stream/promises': path.resolve(__dirname, './node-mocks.ts'),
    'node:stream/promises': path.resolve(__dirname, './node-mocks.ts'),
    'node:util': path.resolve(__dirname, './node-mocks.ts'),
    util: path.resolve(__dirname, './node-mocks.ts'),
    'node:net': path.resolve(__dirname, './node-mocks.ts'),
    net: path.resolve(__dirname, './node-mocks.ts'),
    'node:http': path.resolve(__dirname, './node-mocks.ts'),
    http: path.resolve(__dirname, './node-mocks.ts'),
    'node:https': path.resolve(__dirname, './node-mocks.ts'),
    https: path.resolve(__dirname, './node-mocks.ts'),
    'node:tty': path.resolve(__dirname, './node-mocks.ts'),
    tty: path.resolve(__dirname, './node-mocks.ts'),
    'node:readline': path.resolve(__dirname, './node-mocks.ts'),
    readline: path.resolve(__dirname, './node-mocks.ts'),
    'node:buffer': path.resolve(__dirname, './node-mocks.ts'),
    buffer: path.resolve(__dirname, './node-mocks.ts'),
    'node:assert': path.resolve(__dirname, './node-mocks.ts'),
    assert: path.resolve(__dirname, './node-mocks.ts'),
    'node:zlib': path.resolve(__dirname, './node-mocks.ts'),
    zlib: path.resolve(__dirname, './node-mocks.ts'),

    // Ink shims
    ink: path.resolve(__dirname, './ink-browser-shim.tsx'),
    'ink-spinner': path.resolve(__dirname, './ink-spinner-shim.tsx'),
    // Ink's Node.js dependencies - not needed when using our shim
    'yoga-layout': path.resolve(__dirname, './external-mocks.ts'),
    '@resvg/resvg-js': path.resolve(__dirname, './external-mocks.ts'),
    'yoga-wasm-web': path.resolve(__dirname, './external-mocks.ts'),
    // Terminal detection packages - not needed in browser
    'supports-color': path.resolve(__dirname, './external-mocks.ts'),
    'supports-hyperlinks': path.resolve(__dirname, './external-mocks.ts'),

    // Force zod to resolve from web-harness node_modules
    zod: path.resolve(__dirname, './node_modules/zod/index.js'),

    // External package mocks
    '@commander-js/extra-typings': path.resolve(__dirname, './external-mocks.ts'),
    commander: path.resolve(__dirname, './external-mocks.ts'),
    handlebars: path.resolve(__dirname, './external-mocks.ts'),
    dotenv: path.resolve(__dirname, './external-mocks.ts'),

    // AWS SDK mocks
    '@aws-sdk/client-cloudformation': path.resolve(__dirname, './external-mocks.ts'),
    '@aws-sdk/client-sts': path.resolve(__dirname, './external-mocks.ts'),
    '@aws-sdk/client-bedrock-runtime': path.resolve(__dirname, './external-mocks.ts'),
    '@aws-sdk/client-bedrock-agentcore': path.resolve(__dirname, './external-mocks.ts'),
    '@aws-sdk/client-bedrock-agentcore-control': path.resolve(__dirname, './external-mocks.ts'),
    '@aws-sdk/credential-providers': path.resolve(__dirname, './external-mocks.ts'),
    '@smithy/shared-ini-file-loader': path.resolve(__dirname, './external-mocks.ts'),
    '@aws-cdk/toolkit-lib': path.resolve(__dirname, './external-mocks.ts'),
  };

  const cliMock = path.resolve(__dirname, './cli-mock.ts');
  const shellMock = path.resolve(__dirname, './shell-mock.ts');
  const cliConstantsMock = path.resolve(__dirname, './cli-constants-mock.ts');
  const tuiProcessMock = path.resolve(__dirname, './tui-process-mock.ts');
  const templateRootMock = path.resolve(__dirname, './template-root-mock.ts');
  const nlEditMock = path.resolve(__dirname, './nl-edit-mock.ts');

  // Path to the main CLI constants (NOT the TUI constants)
  const mainConstantsPath = path.resolve(__dirname, '../src/cli/constants.ts');

  return {
    name: 'browser-mocks',
    enforce: 'pre',
    resolveId(source, importer) {
      // Handle exact matches
      if (mocks[source]) {
        return mocks[source];
      }

      // Mock the CLI module (has many Node.js dependencies including 'module' builtin)
      if (source === '../cli' || source === './cli' || source.endsWith('/cli')) {
        if (importer?.includes('src/cli')) {
          return cliMock;
        }
      }

      // Mock the shell module
      if (source === '../shell' || source === './shell' || source.endsWith('/shell')) {
        if (importer?.includes('src/cli')) {
          return shellMock;
        }
      }

      // Mock the lib module (uses Node.js APIs)
      if (
        source === '../../lib' ||
        source === '../../../lib' ||
        source === '../../../../lib' ||
        source.match(/^\.\.\/.*\/lib$/)
      ) {
        if (importer?.includes('src/cli')) {
          return path.resolve(__dirname, './lib-mocks.ts');
        }
      }

      // Mock the CLI's internal schema module (uses fs/promises)
      // Only mock imports that resolve to src/cli/schema (not src/schema)
      // From screens/schema/*.tsx, '../../../schema' resolves to cli/schema
      // From hooks/*.ts, '../../schema' resolves to cli/schema
      if (source === '../../../schema') {
        if (importer?.includes('src/cli/tui/screens')) {
          return path.resolve(__dirname, './cli-schema-mock.ts');
        }
      }
      if (source === '../../schema') {
        if (importer?.includes('src/cli/tui/hooks')) {
          return path.resolve(__dirname, './cli-schema-mock.ts');
        }
      }

      // Mock the TUI process utility (uses child_process)
      if (source === './process' || source === '../process' || source.endsWith('/process')) {
        if (importer?.includes('src/cli/tui')) {
          return tuiProcessMock;
        }
      }

      // Mock templateRoot (uses node:url)
      if (source === './templateRoot' || source.endsWith('/templateRoot')) {
        if (importer?.includes('src/cli')) {
          return templateRootMock;
        }
      }

      // Mock schema-assets (imports raw text files which need special handling)
      if (source === './schema-assets' || source.endsWith('/schema-assets')) {
        if (importer?.includes('src/cli')) {
          return path.resolve(__dirname, './schema-assets-mock.ts');
        }
      }

      // Mock the nl-edit operations module (uses Bun-specific import ... with { type: 'text' })
      if (
        source.includes('operations/nl-edit') ||
        source === '../../../operations/nl-edit' ||
        source === '../../operations/nl-edit' ||
        source === '../operations/nl-edit' ||
        source === './nl-edit'
      ) {
        if (importer?.includes('src/cli')) {
          console.log(`[browser-mocks] INTERCEPTING nl-edit import -> ${nlEditMock}`);
          return nlEditMock;
        }
      }

      // Mock the MAIN CLI constants.ts (uses Node.js 'module' builtin)
      // Intercept imports that resolve to src/cli/constants.ts (not tui/constants.ts)
      if (source.endsWith('/constants') || source.endsWith('/constants.ts')) {
        // Check if this resolves to the MAIN cli constants (not tui constants)
        // ../../../constants from tui/screens/update -> cli/constants (main - needs mock)
        // ../../constants from tui/screens -> tui/constants (tui - don't mock)
        // ../constants from tui/components -> tui/constants (tui - don't mock)
        const isFromTui = importer?.includes('/tui/');
        const goesToMainConstants =
          source === '../../../constants' || // from tui/screens/*/
          source === '../../../../constants'; // from tui/screens/*/*/

        if (isFromTui && goesToMainConstants) {
          console.log(`[browser-mocks] INTERCEPTING main constants import from TUI -> ${cliConstantsMock}`);
          return cliConstantsMock;
        }

        // Also mock non-TUI imports to main constants
        const isCliSrc = importer?.includes('src/cli');
        const isNotTui = !isFromTui;
        if (isCliSrc && isNotTui) {
          console.log(`[browser-mocks] INTERCEPTING constants import -> ${cliConstantsMock}`);
          return cliConstantsMock;
        }
      }

      return null;
    },
  };
}

export default defineConfig({
  plugins: [createMockFsPlugin(MOCK_SCENARIO), browserMocksPlugin(), react()],
  server: {
    fs: {
      // Allow serving files from parent directory (src/)
      allow: ['..'],
    },
  },
  define: {
    'process.env': JSON.stringify({}),
    'process.cwd': '() => "/mock/workspace"',
    'process.chdir': '() => {}',
    'process.platform': JSON.stringify('browser'),
    // Signal handling no-ops for browser
    'process.on': '(() => {})',
    'process.off': '(() => {})',
    'process.once': '(() => {})',
    'process.removeListener': '(() => {})',
  },
  assetsInclude: ['**/*.txt'],
  optimizeDeps: {
    include: ['zod'],
    // Exclude packages that should be aliased to shims - don't let Vite try to pre-bundle them
    exclude: ['ink', 'ink-spinner', 'yoga-layout', '@resvg/resvg-js', 'supports-color', 'supports-hyperlinks'],
    esbuildOptions: {
      platform: 'browser',
    },
  },
  resolve: {
    // Ensure we use the browser-compatible version
    conditions: ['browser', 'module', 'import', 'default'],
    // Force single copy of zod
    dedupe: ['zod'],
  },
  // Handle CommonJS modules from the schema package
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
});
