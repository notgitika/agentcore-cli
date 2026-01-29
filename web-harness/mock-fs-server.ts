/**
 * Mock Filesystem Server Plugin for Vite
 *
 * Provides a server-side file store that:
 * - Initializes with mock JSON data on dev server start
 * - Exposes REST API endpoints for reading/writing files
 * - Persists changes in memory during the dev session
 * - Resets to fresh mock data on server restart
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

// Types for mock filesystem
export interface MockFile {
  content: string;
  lastModified: number;
}

export interface MockFileStore {
  [path: string]: MockFile;
}

// Define mock file paths
const MOCK_WORKSPACE = '/mock/workspace/agentcore';
const MOCK_CLI_DIR = `${MOCK_WORKSPACE}/.cli`;

// Map of virtual paths to their mock JSON source files
const MOCK_FILE_MAPPING: Record<string, string> = {
  [`${MOCK_WORKSPACE}/agentcore.json`]: 'agentcore.json',
  [`${MOCK_WORKSPACE}/aws-targets.json`]: 'aws-targets.json',
  [`${MOCK_WORKSPACE}/mcp.json`]: 'mcp.json',
  [`${MOCK_WORKSPACE}/mcp-defs.json`]: 'mcp-defs.json',
  [`${MOCK_CLI_DIR}/deployed-state.json`]: 'deployed-state.json',
};

// Known mock directories
const MOCK_DIRECTORIES = new Set([
  '/mock',
  '/mock/workspace',
  MOCK_WORKSPACE,
  MOCK_CLI_DIR,
  `${MOCK_CLI_DIR}/logs`,
  `${MOCK_WORKSPACE}/cdk`,
]);

export function createMockFsPlugin(scenario: 'demo-workspace' | 'empty-workspace' = 'demo-workspace'): Plugin {
  // In-memory file store
  const fileStore: MockFileStore = {};
  const mocksDir = path.resolve(__dirname, `./mocks/${scenario}`);

  // Initialize file store from mock JSON files
  function initializeFileStore() {
    console.log(`[mock-fs] Initializing file store from scenario: ${scenario}`);

    for (const [virtualPath, fileName] of Object.entries(MOCK_FILE_MAPPING)) {
      const sourcePath = path.join(mocksDir, fileName);
      try {
        const content = fs.readFileSync(sourcePath, 'utf-8');
        fileStore[virtualPath] = {
          content,
          lastModified: Date.now(),
        };
        console.log(`[mock-fs] Loaded: ${virtualPath}`);
      } catch (err) {
        console.warn(`[mock-fs] Failed to load ${sourcePath}:`, err);
        // Initialize with empty object for missing files
        fileStore[virtualPath] = {
          content: '{}',
          lastModified: Date.now(),
        };
      }
    }
  }

  return {
    name: 'mock-fs-server',

    configureServer(server: ViteDevServer) {
      // Initialize file store on server start
      initializeFileStore();

      // Endpoint to get all files at once (for initial sync)
      // MUST be registered BEFORE the generic /__mock-fs handler
      server.middlewares.use((req, res, next) => {
        if (req.url === '/__mock-fs-sync' && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              files: fileStore,
              directories: Array.from(MOCK_DIRECTORIES),
            })
          );
          return;
        }
        next();
      });

      // Endpoint to reset to initial state
      // MUST be registered BEFORE the generic /__mock-fs handler
      server.middlewares.use((req, res, next) => {
        if (req.url === '/__mock-fs-reset' && req.method === 'POST') {
          initializeFileStore();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, message: 'File store reset to initial state' }));
          return;
        }
        next();
      });

      // Add middleware for mock filesystem API (generic file operations)
      server.middlewares.use((req, res, next) => {
        // Only handle our mock-fs API endpoints
        if (!req.url?.startsWith('/__mock-fs/')) {
          return next();
        }

        const urlPath = req.url.replace('/__mock-fs', '') || '/';

        // GET - Read file or list directory
        if (req.method === 'GET') {
          // Check if it's a directory
          if (MOCK_DIRECTORIES.has(urlPath)) {
            // List files in directory
            const files = Object.keys(fileStore)
              .filter(p => p.startsWith(urlPath + '/') && !p.slice(urlPath.length + 1).includes('/'))
              .map(p => p.split('/').pop());

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ type: 'directory', files }));
            return;
          }

          // Read file
          const file = fileStore[urlPath];
          if (file) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ type: 'file', content: file.content, lastModified: file.lastModified }));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'File not found', path: urlPath }));
          }
          return;
        }

        // POST - Write file
        if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => {
            body += chunk.toString();
          });
          req.on('end', () => {
            try {
              const { content } = JSON.parse(body);
              fileStore[urlPath] = {
                content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
                lastModified: Date.now(),
              };
              console.log(`[mock-fs] Written: ${urlPath} (${fileStore[urlPath].content.length} bytes)`);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, path: urlPath }));
            } catch (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Invalid request body' }));
            }
          });
          return;
        }

        // DELETE - Remove file
        if (req.method === 'DELETE') {
          if (fileStore[urlPath]) {
            delete fileStore[urlPath];
            console.log(`[mock-fs] Deleted: ${urlPath}`);
            res.end(JSON.stringify({ success: true }));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'File not found' }));
          }
          return;
        }

        // HEAD - Check if file exists
        if (req.method === 'HEAD') {
          if (fileStore[urlPath] || MOCK_DIRECTORIES.has(urlPath)) {
            res.statusCode = 200;
          } else {
            res.statusCode = 404;
          }
          res.end();
          return;
        }

        next();
      });
    },
  };
}

export default createMockFsPlugin;
