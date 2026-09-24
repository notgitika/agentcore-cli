// Test helpers shared by the imperative kind tests. Not imported by production code.

export type SentCommand = { name: string; input: Record<string, unknown> };
export type FakeClient = { send(command: unknown): Promise<unknown>; sent: SentCommand[] };

/**
 * Routes `send(command)` by the command's class name (e.g. "GetMemoryCommand");
 * unknown commands throw. A handler may throw to simulate an SDK error.
 */
export function fakeClient(handlers: Record<string, (input: any) => unknown>): FakeClient {
  const sent: SentCommand[] = [];
  return {
    sent,
    async send(command: unknown) {
      const name = (command as object).constructor.name;
      const input = ((command as { input?: Record<string, unknown> }).input ?? {}) as Record<
        string,
        unknown
      >;
      sent.push({ name, input });
      const handler = handlers[name];
      if (!handler) throw new Error(`fake client has no handler for ${name}`);
      return handler(input);
    },
  };
}

/** An SDK-shaped error: `name` and `$metadata.httpStatusCode` set. */
export function sdkError(name: string, httpStatusCode: number, message = name): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { $metadata: { httpStatusCode } });
  return error;
}

export const notFound = (message?: string) => sdkError("ResourceNotFoundException", 404, message);
