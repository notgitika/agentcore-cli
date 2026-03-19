import { closeAllSessions, createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // Graceful shutdown handler
  const shutdown = async (): Promise<void> => {
    await closeAllSessions();
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  // Connect server to stdio transport
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error('MCP harness failed to start:', error);
  process.exit(1);
});
