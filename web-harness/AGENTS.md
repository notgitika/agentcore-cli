# Web Harness Testing

This directory contains a web-based harness for testing the CLI TUI components in a browser environment.

## Usage

1. Start the harness: `npm run dev`
2. Navigate to the URL shown in the terminal (usually http://localhost:5173 or similar)
3. Use playwright browser tools to interact with the TUI

## CRITICAL: Console Error Protocol

**BEFORE doing ANYTHING else after starting or restarting the harness, you MUST:**

1. Open the browser or use playwright tools to check console errors
2. If ANY errors exist, STOP and FIX them before proceeding
3. Do NOT claim the harness is working until you have verified zero console errors

### Checking for Errors

Use playwright MCP tools to check console:

```
mcp__playwright__browser_console_messages with level: "error"
```

Or manually open http://localhost:5173 in a browser and check DevTools Console.

### Common Errors and Fixes

1. **"Invalid or unexpected token"** - Usually a missing mock in vite.config.ts
2. **Module not found / 404** - Add the module to the mocks in vite.config.ts
3. **React rendering errors** - Check component imports and props

### After Making Code Changes

After ANY code changes to TUI components:

1. Rebuild packages: `npm run build:packages` (from repo root)
2. Restart harness: kill vite, run `npm run dev`
3. CHECK CONSOLE ERRORS before proceeding
4. Fix any errors that appear

**This protocol is NON-NEGOTIABLE. Do not skip checking console errors.**
