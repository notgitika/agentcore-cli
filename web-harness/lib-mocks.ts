// Mock @agentcore/lib - only the parts that depend on Node.js
// The schema package is NOT mocked - it's pure TypeScript/Zod
// Configuration is centralized in harness-env.ts
import { MOCK_AGENTCORE_DIR, MOCK_SCENARIO } from './harness-env';
import * as mockFs from './mock-fs-client';

// Define mock paths (must match mock-fs-server.ts and mock-fs-client.ts)
const MOCK_WORKSPACE = '/mock/workspace/agentcore';
const MOCK_CLI_DIR = `${MOCK_WORKSPACE}/.cli`;

// Virtual paths to schema files
const VIRTUAL_PATHS = {
  agentcore: `${MOCK_WORKSPACE}/agentcore.json`,
  awsTargets: `${MOCK_WORKSPACE}/aws-targets.json`,
  mcp: `${MOCK_WORKSPACE}/mcp.json`,
  mcpDefs: `${MOCK_WORKSPACE}/mcp-defs.json`,
  deployedState: `${MOCK_CLI_DIR}/deployed-state.json`,
};

// Constants
export const CONFIG_DIR = 'agentcore';
export const CLI_SYSTEM_DIR = '.cli';
export const CLI_LOGS_DIR = '.cli/logs';
export const CONFIG_FILES = {};
export const UV_INSTALL_HINT = 'Install uv';
export const DEFAULT_PYTHON_PLATFORM = 'linux';
export const APP_DIR = 'app';
export const MCP_APP_SUBDIR = 'mcp';

// Error class
export class NoProjectError extends Error {
  constructor(message?: string) {
    super(message || 'No project found');
    this.name = 'NoProjectError';
  }
}

// Utility functions that use Node.js
export const isWindows = false;
export const findConfigRoot = () => MOCK_WORKSPACE;
export const findProjectRoot = () => '/mock/workspace';
export const getWorkingDirectory = () => '/mock/workspace';
export const requireConfigRoot = () => MOCK_WORKSPACE;
export const runSubprocess = async () => ({ stdout: '', stderr: '', code: 0 });

// Environment file utilities
export const readEnvFile = async (_path: string) => ({});
export const setEnvVar = async (_path: string, _key: string, _value: string) => {};

// SecureCredentials class mock
export class SecureCredentials {
  private creds: Record<string, string> = {};

  constructor(_agentName?: string) {}

  async get(key: string): Promise<string | undefined> {
    return this.creds[key];
  }

  async set(key: string, value: string): Promise<void> {
    this.creds[key] = value;
  }

  async delete(key: string): Promise<void> {
    delete this.creds[key];
  }

  async list(): Promise<string[]> {
    return Object.keys(this.creds);
  }
}

// Mock subprocess capture - returns appropriate version info based on command
export const runSubprocessCapture = async (cmd: string, args?: string[]) => {
  const fullCmd = args ? `${cmd} ${args.join(' ')}` : cmd;
  // Node version check
  if (fullCmd.includes('node') && fullCmd.includes('--version')) {
    return { stdout: 'v20.0.0\n', stderr: '', code: 0 };
  }
  // UV version check
  if (fullCmd.includes('uv') && fullCmd.includes('--version')) {
    return { stdout: 'uv 0.9.2\n', stderr: '', code: 0 };
  }
  // NPM version check
  if (fullCmd.includes('npm') && fullCmd.includes('--version')) {
    return { stdout: '10.0.0\n', stderr: '', code: 0 };
  }
  // CDK version check
  if (fullCmd.includes('cdk') && fullCmd.includes('--version')) {
    return { stdout: '2.150.0\n', stderr: '', code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
};

export const runSubprocessCaptureSync = (cmd: string, args?: string[]) => {
  const fullCmd = args ? `${cmd} ${args.join(' ')}` : cmd;
  // Node version check
  if (fullCmd.includes('node') && fullCmd.includes('--version')) {
    return { stdout: 'v20.0.0\n', stderr: '', code: 0 };
  }
  // UV version check
  if (fullCmd.includes('uv') && fullCmd.includes('--version')) {
    return { stdout: 'uv 0.9.2\n', stderr: '', code: 0 };
  }
  // NPM version check
  if (fullCmd.includes('npm') && fullCmd.includes('--version')) {
    return { stdout: '10.0.0\n', stderr: '', code: 0 };
  }
  // CDK version check
  if (fullCmd.includes('cdk') && fullCmd.includes('--version')) {
    return { stdout: '2.150.0\n', stderr: '', code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
};
export const checkSubprocess = async () => true;
export const packRuntime = async () => '/mock/artifact.zip';
export const resolveCodeLocation = () => '/mock/code';
export const validateAgentExists = () => true;
export const getArtifactZipName = () => 'artifact.zip';
export const setSessionProjectRoot = () => {};
export const getSessionProjectRoot = () => '/mock/workspace';

// Mock PathResolver class - mirrors all methods from agentcore-lib
export class PathResolver {
  private baseDir = MOCK_WORKSPACE;

  getBaseDir() {
    return this.baseDir;
  }
  getProjectRoot() {
    return '/mock/workspace';
  }
  getAgentConfigPath() {
    return VIRTUAL_PATHS.agentcore;
  }
  getAWSTargetsConfigPath() {
    return VIRTUAL_PATHS.awsTargets;
  }
  getCliSystemDir() {
    return MOCK_CLI_DIR;
  }
  getLogsDir() {
    return `${MOCK_CLI_DIR}/logs`;
  }
  getStatePath() {
    return VIRTUAL_PATHS.deployedState;
  }
  getMcpConfigPath() {
    return VIRTUAL_PATHS.mcp;
  }
  getMcpDefsPath() {
    return VIRTUAL_PATHS.mcpDefs;
  }
  setBaseDir(baseDir: string) {
    this.baseDir = baseDir;
  }
}

// Helper to read and parse JSON from mock filesystem
async function readJsonFile<T>(virtualPath: string): Promise<T> {
  await mockFs.waitForInit();
  const content = mockFs.readFileSync(virtualPath);
  return JSON.parse(content) as T;
}

// Helper to write JSON to mock filesystem
async function writeJsonFile(virtualPath: string, data: unknown): Promise<void> {
  await mockFs.waitForInit();
  const content = JSON.stringify(data, null, 2);
  await mockFs.writeFile(virtualPath, content);
}

// Mock ConfigIO class (uses fs operations)
// Now reads/writes to the writable mock filesystem
export class ConfigIO {
  private pathResolver = new PathResolver();

  constructor(_opts?: any) {}

  configExists(configName: string): boolean {
    // Return true for configs that have mock data
    const existingConfigs = ['project', 'awsTargets', 'state', 'mcp', 'mcpDefs'];
    return existingConfigs.includes(configName);
  }

  getPathResolver(): PathResolver {
    return this.pathResolver;
  }

  getProjectRoot(): string {
    return this.pathResolver.getProjectRoot();
  }

  getConfigRoot(): string {
    return this.pathResolver.getBaseDir();
  }

  async readProjectSpec() {
    return readJsonFile(VIRTUAL_PATHS.agentcore);
  }

  async writeProjectSpec(data: unknown) {
    await writeJsonFile(VIRTUAL_PATHS.agentcore, data);
  }

  async readAWSDeploymentTargets() {
    return readJsonFile(VIRTUAL_PATHS.awsTargets);
  }

  async writeAWSDeploymentTargets(data: unknown) {
    await writeJsonFile(VIRTUAL_PATHS.awsTargets, data);
  }

  async readDeployedState() {
    return readJsonFile(VIRTUAL_PATHS.deployedState);
  }

  async writeDeployedState(data: unknown) {
    await writeJsonFile(VIRTUAL_PATHS.deployedState, data);
  }

  async readMcpSpec() {
    return readJsonFile(VIRTUAL_PATHS.mcp);
  }

  async writeMcpSpec(data: unknown) {
    await writeJsonFile(VIRTUAL_PATHS.mcp, data);
  }

  async readMcpDefs() {
    return readJsonFile(VIRTUAL_PATHS.mcpDefs);
  }

  async writeMcpDefs(data: unknown) {
    await writeJsonFile(VIRTUAL_PATHS.mcpDefs, data);
  }

  async initializeBaseDir() {}

  baseDirExists(): boolean {
    return true;
  }

  setBaseDir(_baseDir: string): void {}
}
