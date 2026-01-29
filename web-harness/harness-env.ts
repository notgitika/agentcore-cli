/**
 * Harness Environment Configuration
 *
 * Central configuration for the browser test harness.
 * Change these settings to test different scenarios.
 */

// ============= Mock Scenario =============
// Available scenarios (defined in mocks/ directory):
// - 'demo-workspace': Full workspace with 2 agents, AWS targets, deployed state
// - 'empty-workspace': Fresh init state, no agents

export type MockScenario = 'demo-workspace' | 'empty-workspace';

/**
 * The active mock scenario.
 * Change this to test different workspace states.
 */
export const MOCK_SCENARIO: MockScenario = 'demo-workspace';

// ============= Mock Paths =============
// These define where the mock workspace "lives" in the virtual filesystem
// NOTE: These must match the paths in mock-fs-server.ts and mock-fs-client.ts

export const MOCK_WORKSPACE_ROOT = '/mock/workspace';
export const MOCK_AGENTCORE_DIR = `${MOCK_WORKSPACE_ROOT}/agentcore`;
export const MOCK_CLI_DIR = `${MOCK_AGENTCORE_DIR}/.cli`;

// ============= Feature Flags =============
// Enable/disable features for testing

export const HARNESS_CONFIG = {
  /** Log mock operations to console */
  logMockOperations: false,

  /** Simulate network latency for async operations (ms) */
  simulatedLatency: 0,

  /** Show debug borders around Ink components */
  debugBorders: false,
} as const;
