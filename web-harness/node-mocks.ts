// Comprehensive mock for Node.js modules in browser
// ============= Mock Filesystem Integration =============
// Uses the mock-fs-client for writable file operations that persist during dev session
import { HARNESS_CONFIG, MOCK_SCENARIO, type MockScenario } from './harness-env';
import * as mockFs from './mock-fs-client';

// Re-export types and scenario getter for convenience
export type { MockScenario };
export function getMockScenario(): MockScenario {
  return MOCK_SCENARIO;
}

// Define mock paths
const MOCK_WORKSPACE = '/mock/workspace/agentcore';
const MOCK_CLI_DIR = `${MOCK_WORKSPACE}/.cli`;

// Map of file names to their virtual paths
const FILE_NAME_TO_PATH: Record<string, string> = {
  'agentcore.json': `${MOCK_WORKSPACE}/agentcore.json`,
  'aws-targets.json': `${MOCK_WORKSPACE}/aws-targets.json`,
  'mcp.json': `${MOCK_WORKSPACE}/mcp.json`,
  'mcp-defs.json': `${MOCK_WORKSPACE}/mcp-defs.json`,
  'deployed-state.json': `${MOCK_CLI_DIR}/deployed-state.json`,
};

// Known mock directories
const MOCK_DIRS = ['agentcore', '.cli', '.cli/logs', 'cdk'];

// ============= fs module =============

// Helper to resolve file path to virtual path
function resolveToVirtualPath(filePath: string): string | null {
  const normalizedPath = String(filePath);
  const fileName = normalizedPath.split('/').pop() || '';

  // Check if this is a known mock file by name
  if (FILE_NAME_TO_PATH[fileName]) {
    return FILE_NAME_TO_PATH[fileName];
  }

  // Check if the path is already a virtual path
  if (normalizedPath.startsWith('/mock/')) {
    return normalizedPath;
  }

  return null;
}

// Helper to return mock content based on file path
function getMockFileContent(filePath: string): string {
  const virtualPath = resolveToVirtualPath(filePath);

  if (virtualPath) {
    return mockFs.readFileSync(virtualPath);
  }

  // Special case for package.json
  if (filePath.endsWith('package.json')) {
    return JSON.stringify({ name: 'mock-package', version: '1.0.0', dependencies: {} });
  }

  // Default for unknown JSON files
  if (filePath.endsWith('.json')) {
    return '{}';
  }

  return '';
}

export const existsSync = (path: string): boolean => {
  const virtualPath = resolveToVirtualPath(path);

  // Check virtual file system
  if (virtualPath && mockFs.existsSync(virtualPath)) {
    return true;
  }

  // Check if it's a package.json (needed for CDK project validation)
  const fileName = String(path).split('/').pop() || '';
  if (fileName === 'package.json') return true;

  // Check if it's a known mock directory
  const normalizedPath = String(path);
  for (const dir of MOCK_DIRS) {
    if (normalizedPath.endsWith(dir) || normalizedPath.endsWith(`/${dir}`)) {
      return true;
    }
  }

  return false;
};

export const readdirSync = (path: string): string[] => {
  const virtualPath = resolveToVirtualPath(path);
  if (virtualPath) {
    return mockFs.readdirSync(virtualPath);
  }
  return [];
};

export const statSync = (path: string) => {
  const isDir = mockFs.isDirectory(path);
  return {
    isDirectory: () => isDir,
    isFile: () => !isDir && mockFs.existsSync(path),
  };
};

export const readFileSync = (filePath: string): string => getMockFileContent(String(filePath));

export const writeFileSync = (filePath: string, content: string | object): void => {
  const virtualPath = resolveToVirtualPath(filePath);
  if (virtualPath) {
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    mockFs.writeFileSync(virtualPath, contentStr);
  }
};

export const mkdirSync = () => {};
export const unlinkSync = () => {};
export const copyFileSync = () => {};
export const rmSync = () => {};
export const appendFileSync = () => {};
export const createReadStream = () => ({ pipe: () => {}, on: () => {} });
export const createWriteStream = () => ({ write: () => {}, end: () => {}, on: () => {} });

export const promises = {
  readFile: async (filePath: string): Promise<string> => {
    const virtualPath = resolveToVirtualPath(filePath);
    if (virtualPath) {
      return mockFs.readFile(virtualPath);
    }
    return getMockFileContent(String(filePath));
  },
  writeFile: async (filePath: string, content: string | object): Promise<void> => {
    const virtualPath = resolveToVirtualPath(filePath);
    if (virtualPath) {
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      await mockFs.writeFile(virtualPath, contentStr);
    }
  },
  mkdir: async () => {},
  readdir: async (path: string) => readdirSync(path),
  stat: async (path: string) => statSync(path),
  unlink: async () => {},
  rm: async () => {},
  copyFile: async () => {},
  access: async () => {},
  rename: async () => {},
};

// Also export async functions at top level for fs/promises imports
export const readFile = promises.readFile;
export const writeFile = promises.writeFile;
export const mkdir = promises.mkdir;
export const readdir = promises.readdir;
export const stat = promises.stat;
export const access = promises.access;
export const copyFile = promises.copyFile;
export const rm = promises.rm;
export const rename = promises.rename;

// ============= path module =============
export const join = (...parts: string[]) => parts.filter(Boolean).join('/');
export const resolve = (...parts: string[]) => '/' + parts.filter(Boolean).join('/');
export const dirname = (p: string) => p.split('/').slice(0, -1).join('/') || '/';
export const basename = (p: string, ext?: string) => {
  const base = p.split('/').pop() || '';
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
};
export const extname = (p: string) => {
  const base = p.split('/').pop() || '';
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx) : '';
};
export const relative = (_from: string, to: string) => to;
export const isAbsolute = (p: string) => p.startsWith('/');
export const normalize = (p: string) => p;
export const sep = '/';
export const delimiter = ':';
export const parse = (p: string) => ({
  root: '/',
  dir: dirname(p),
  base: basename(p),
  ext: extname(p),
  name: basename(p, extname(p)),
});

// ============= url module =============
export const fileURLToPath = (url: string | URL) => {
  const urlStr = typeof url === 'string' ? url : url.href;
  return urlStr.replace('file://', '');
};
export const pathToFileURL = (p: string) => new URL(`file://${p}`);

// ============= child_process module =============
export const spawn = () => ({
  stdout: { on: () => {}, pipe: () => {} },
  stderr: { on: () => {}, pipe: () => {} },
  stdin: { write: () => {}, end: () => {} },
  on: (_event: string, cb: (code: number) => void) => {
    if (_event === 'close') setTimeout(() => cb(0), 10);
  },
  kill: () => {},
});
export const execSync = () => '';
export const exec = (_cmd: string, _opts: unknown, cb?: (err: null, stdout: string, stderr: string) => void) => {
  const callback = typeof _opts === 'function' ? _opts : cb;
  if (callback) setTimeout(() => callback(null, '', ''), 10);
};
export const spawnSync = () => ({ stdout: '', stderr: '', status: 0 });
export const fork = spawn;
export const execFile = exec;
export const execFileSync = execSync;

// ============= os module =============
export const platform = () => 'browser';
export const homedir = () => '/home/user';
export const tmpdir = () => '/tmp';
export const hostname = () => 'localhost';
export const type = () => 'Browser';
export const release = () => '1.0.0';
export const cpus = () => [{ model: 'Browser', speed: 0 }];
export const totalmem = () => 0;
export const freemem = () => 0;
export const EOL = '\n';
export const arch = () => 'x64';
export const userInfo = () => ({ username: 'user', homedir: '/home/user' });

// ============= crypto module =============
export const randomBytes = (size: number) => new Uint8Array(size);
export const randomUUID = () => crypto.randomUUID();
export const createHash = () => ({
  update: function () {
    return this;
  },
  digest: () => 'mockhash',
});
export const createHmac = createHash;

// ============= events module =============
export class EventEmitter {
  private listeners: Record<string, Function[]> = {};
  on(event: string, listener: Function) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    (this.listeners[event] || []).forEach(fn => fn(...args));
    return true;
  }
  removeListener(event: string, listener: Function) {
    this.listeners[event] = (this.listeners[event] || []).filter(fn => fn !== listener);
    return this;
  }
  off = this.removeListener;
  once(event: string, listener: Function) {
    const wrapped = (...args: unknown[]) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }
  addListener = this.on;
  removeAllListeners(event?: string) {
    if (event) delete this.listeners[event];
    else this.listeners = {};
    return this;
  }
  listenerCount(event: string) {
    return (this.listeners[event] || []).length;
  }
}

// ============= stream module =============
export class Readable extends EventEmitter {
  pipe() {
    return this;
  }
  read() {
    return null;
  }
}
export class Writable extends EventEmitter {
  write() {
    return true;
  }
  end() {}
}
export class Transform extends EventEmitter {
  pipe() {
    return this;
  }
  write() {
    return true;
  }
  end() {}
}
export class PassThrough extends Transform {}
export class Duplex extends EventEmitter {
  pipe() {
    return this;
  }
  write() {
    return true;
  }
  end() {}
  read() {
    return null;
  }
}

// stream/promises exports
export const pipeline = async (..._args: unknown[]) => {
  // Mock pipeline - just resolve immediately
  return Promise.resolve();
};
export const finished = async (_stream: unknown) => {
  return Promise.resolve();
};

// ============= util module =============
export const promisify = (fn: Function) => fn;
export const inspect = (obj: unknown) => JSON.stringify(obj);
export const format = (fmt: string, ...args: unknown[]) => {
  let i = 0;
  return fmt.replace(/%[sdjO]/g, () => String(args[i++]));
};
export const deprecate = (fn: Function) => fn;
export const inherits = () => {};
export const types = {
  isPromise: (v: unknown) => v instanceof Promise,
};

// ============= net module =============
export const createServer = () => ({
  listen: () => {},
  close: () => {},
  on: () => {},
  address: () => ({ port: 0 }),
});
export const createConnection = () => ({
  on: () => {},
  write: () => {},
  end: () => {},
  destroy: () => {},
});
export const connect = createConnection;
export const Socket = class {
  on() {
    return this;
  }
  write() {
    return true;
  }
  end() {}
  destroy() {}
};
export const Server = class {
  listen() {
    return this;
  }
  close() {}
  on() {
    return this;
  }
  address() {
    return { port: 0 };
  }
};

// ============= http/https module =============
export const request = () => ({
  on: () => {},
  write: () => {},
  end: () => {},
});
export const get = request;
export const Agent = class {};
export const globalAgent = {};

// ============= tty module =============
export const isatty = () => false;
export const ReadStream = class extends Readable {};
export const WriteStream = class extends Writable {};

// ============= readline module =============
export const createInterface = () => ({
  on: () => {},
  question: (_q: string, cb: (a: string) => void) => cb(''),
  close: () => {},
  prompt: () => {},
});

// ============= buffer module =============
export const Buffer = {
  from: (data: unknown) => new Uint8Array(typeof data === 'string' ? data.split('').map(c => c.charCodeAt(0)) : []),
  alloc: (size: number) => new Uint8Array(size),
  allocUnsafe: (size: number) => new Uint8Array(size),
  isBuffer: () => false,
  concat: (list: Uint8Array[]) => {
    const totalLength = list.reduce((acc, arr) => acc + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of list) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  },
};

// ============= assert module =============
export const ok = () => {};
export const strictEqual = () => {};
export const deepStrictEqual = () => {};
export const notStrictEqual = () => {};
export const throws = () => {};
export const doesNotThrow = () => {};
export const rejects = async () => {};
export const doesNotReject = async () => {};

// ============= zlib module =============
export const gzip = (_data: unknown, cb: (err: null, result: Uint8Array) => void) => cb(null, new Uint8Array());
export const gunzip = gzip;
export const deflate = gzip;
export const inflate = gzip;
export const createGzip = () => new Transform();
export const createGunzip = () => new Transform();

// Default export for path (commonly used as `import path from 'path'`)
export default {
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  isAbsolute,
  normalize,
  sep,
  delimiter,
  parse,
};
