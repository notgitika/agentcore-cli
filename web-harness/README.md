# AgentCore CLI - Browser Test Harness

A browser-based visual testing harness for the AgentCore CLI's Ink-based terminal UI. This allows you to render and
interact with the CLI interface in a web browser at multiple terminal sizes simultaneously.

## Quick Start

```bash
cd web-harness
npm install
npm run dev
# Opens http://localhost:5173
```

## What is This?

This harness renders the **real AgentCore CLI TUI components** in a browser environment by:

1. **Shimming Ink** - Replacing Ink's terminal rendering with browser DOM elements
2. **Mocking Node.js APIs** - Providing browser-compatible stubs for `fs`, `path`, `child_process`, etc.
3. **Mocking CLI operations** - Simulating file I/O, shell commands, and AWS operations

The result is a fully interactive UI that you can visually test without needing a real terminal or AWS infrastructure.

## Intended Use: Visual Testing with Playwright MCP

This harness is designed to be used with [Playwright MCP](https://github.com/anthropic/claude-code) for automated visual
testing via Claude Code.

### Setup Playwright MCP

```bash
claude mcp add playwright -- npx @playwright/mcp@latest
```

#### Headless Mode (no browser window)

To run the browser invisibly in the background, edit the MCP config file:

```bash
# Find and edit the config (location varies by installation)
~/.claude/plugins/.../playwright/.mcp.json
```

Add `--headless` to the args:

```json
{
  "playwright": {
    "command": "npx",
    "args": ["@playwright/mcp@latest", "--headless"]
  }
}
```

Then restart Claude Code or run `/mcp` to reconnect.

### Example Usage with Claude

Once the harness is running (`npm run dev`), you can ask Claude to:

- "Navigate to http://localhost:5173 and screenshot the home screen"
- "Click on the 'init' option and verify the wizard renders correctly"
- "Test keyboard navigation through the menu"
- "Check how the UI looks at different terminal sizes"

## Architecture

### What's Real (from source)

These are imported **directly from the CLI source code** - no mocking:

| Component                 | Path                                          |
| ------------------------- | --------------------------------------------- |
| `App` (main TUI)          | `packages/agentcore-cli/src/tui/App.tsx`      |
| All TUI screens           | `packages/agentcore-cli/src/tui/screens/*`    |
| All TUI components        | `packages/agentcore-cli/src/tui/components/*` |
| TUI hooks                 | `packages/agentcore-cli/src/tui/hooks/*`      |
| Schema types & validation | `packages/agentcore-schema/*` (via Zod)       |

### What's Mocked

These are replaced with browser-compatible shims:

| Module                    | Mock File              | Purpose                                |
| ------------------------- | ---------------------- | -------------------------------------- |
| `ink`                     | `ink-browser-shim.tsx` | Box, Text, useInput, useApp, useStdout |
| `ink-spinner`             | `ink-spinner-shim.tsx` | Animated spinner component             |
| `fs`, `path`, `url`, etc. | `node-mocks.ts`        | Node.js built-in modules               |
| `child_process`, `net`    | `node-mocks.ts`        | Process/network operations             |
| `@agentcore/lib`          | `lib-mocks.ts`         | ConfigIO, file utilities               |
| `../cli`                  | `cli-mock.ts`          | Commander program setup                |
| `../shell`                | `shell-mock.ts`        | Shell command execution                |
| AWS SDK clients           | `external-mocks.ts`    | CloudFormation, STS, Bedrock           |
| `commander`               | `external-mocks.ts`    | CLI framework                          |
| `handlebars`              | `external-mocks.ts`    | Template rendering                     |

### Mock Behavior

- **File operations**: Return mock JSON data based on active scenario
- **Shell commands**: Simulate immediate success with mock output
- **ConfigIO**: Returns mock workspace data from scenario files
- **AWS operations**: Not executed, return mock responses

## Mock Scenarios

Configuration is centralized in `harness-env.ts`. Mock workspace data lives in `mocks/` with different scenarios:

```
mocks/
├── demo-workspace/      # Full workspace with 2 agents, AWS targets, deployed state
│   ├── agentcore.json   # DemoWorkspace with ResearchAssistant & CodeReviewer agents
│   ├── aws-targets.json # development (us-west-2) and production (us-east-1)
│   ├── mcp.json         # main-gateway with ResearchAssistant
│   ├── mcp-defs.json    # web-search and code-analyzer tools
│   └── deployed-state.json
└── empty-workspace/     # Fresh init state, no agents
    ├── agentcore.json   # EmptyWorkspace with no agents
    ├── aws-targets.json # Empty array
    ├── mcp.json         # No gateways
    ├── mcp-defs.json    # No tools
    └── deployed-state.json
```

### Switching Scenarios

Edit `harness-env.ts` to change the active scenario:

```typescript
// harness-env.ts
export const MOCK_SCENARIO: MockScenario = 'demo-workspace'; // or 'empty-workspace'
```

Then reload the browser to apply changes.

### Adding New Scenarios

1. Create a new directory under `mocks/` (e.g., `mocks/error-state/`)
2. Add the 5 schema JSON files:
   - `agentcore.json` - Workspace spec with agents array
   - `aws-targets.json` - AWS deployment targets
   - `mcp.json` - MCP gateways configuration
   - `mcp-defs.json` - MCP tool definitions
   - `deployed-state.json` - Deployed resource state
3. Import the files in both `node-mocks.ts` and `lib-mocks.ts`
4. Add the scenario to the `MockScenario` type in `harness-env.ts`
5. Add the scenario data to `MOCK_FILES` in `node-mocks.ts` and `SCENARIO_DATA` in `lib-mocks.ts`

## File Structure

```
web-harness/
├── package.json              # Dependencies (vite, react, zod)
├── vite.config.ts            # Vite config with module aliasing
├── index.html                # HTML entry point
├── tsconfig.json             # TypeScript configuration
├── harness-env.ts            # Harness configuration (scenario, paths, flags)
├── browser-entry.tsx         # Main entry - VirtualTerminal wrapper
├── ink-browser-shim.tsx      # Ink component/hook replacements
├── ink-spinner-shim.tsx      # Spinner component
├── node-mocks.ts             # fs, path, child_process, net, etc.
├── lib-mocks.ts              # @agentcore/lib mocks (ConfigIO)
├── cli-mock.ts               # Commander program mock
├── shell-mock.ts             # Shell execution mock
├── external-mocks.ts         # AWS SDK, commander, handlebars
├── cli-constants-mock.ts     # CLI constants (uses Node.js 'module')
├── tui-process-mock.ts       # TUI process utilities
├── template-root-mock.ts     # Template path resolution
├── schema-text-mock.ts       # Schema text file mock
└── mocks/                    # Mock workspace data by scenario
    ├── demo-workspace/       # Full workspace with agents
    └── empty-workspace/      # Fresh init state
```

## Virtual Terminals

The harness displays three terminal sizes simultaneously:

| Name     | Size   | Use Case                  |
| -------- | ------ | ------------------------- |
| Standard | 80x24  | Default terminal size     |
| Narrow   | 50x20  | Split pane / small window |
| Large    | 120x40 | Full HD terminal          |

Click a terminal to focus keyboard input to it.

## Keyboard Navigation

All standard Ink keyboard controls work:

- **Arrow keys**: Navigate menus
- **Enter**: Select/confirm
- **Escape**: Go back/cancel
- **Tab**: Next field
- **Type**: Text input in forms

## Limitations

Since this runs in a browser with mocked backends:

1. **No real file I/O** - Files aren't actually created/read
2. **No real shell commands** - Commands return mock output
3. **No AWS operations** - Deployments are simulated
4. **No persistent state** - Refreshing resets everything

This is by design - the harness is for **visual/interaction testing**, not functional testing of backend operations.

## Development

### Adding New Mocks

If you encounter a "Module externalized for browser compatibility" error:

1. Identify the Node.js module in the error (e.g., `node:dns`)
2. Add it to the `mocks` object in `vite.config.ts`
3. Add stub exports to `node-mocks.ts`

### Debugging Module Resolution

The Vite plugin logs interceptions to the console. Check the terminal running `npm run dev` for:

```
[browser-mocks] INTERCEPTING cli import -> /path/to/cli-mock.ts
[browser-mocks] INTERCEPTING constants import -> /path/to/cli-constants-mock.ts
```
