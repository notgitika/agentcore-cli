import { ConfigIO } from '../../../lib/index.js';

export async function getMemoryEnvVars(): Promise<Record<string, string>> {
  const configIO = new ConfigIO();
  const envVars: Record<string, string> = {};

  try {
    const deployedState = await configIO.readDeployedState();

    // Iterate all targets (not just 'default')
    for (const target of Object.values(deployedState?.targets ?? {})) {
      const memories = target?.resources?.memories ?? {};

      for (const [name, memory] of Object.entries(memories)) {
        if (!memory.memoryId) continue;
        const sanitized = name.toUpperCase().replace(/-/g, '_');
        envVars[`MEMORY_${sanitized}_ID`] = memory.memoryId;
      }
    }
  } catch {
    // No deployed state — skip memory env vars
  }

  return envVars;
}
