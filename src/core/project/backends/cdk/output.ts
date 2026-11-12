import { AsyncLocalStorage } from "node:async_hooks";
import { StringDecoder } from "node:string_decoder";
import { createLineSplitter, type LineSplitter } from "../../../../io";

type Destination = "stdout" | "stderr";
type Capture = {
  stdout: LineSplitter;
  stderr: LineSplitter;
  decoders: Record<Destination, StringDecoder>;
  closed: boolean;
};

const context = new AsyncLocalStorage<Capture>();
let active = 0;
let restore: (() => void) | undefined;

/** CDK's asset publisher writes subprocess output directly to process streams. */
export async function withCdkOutput<T>(
  onLine: (line: string, destination: Destination) => void,
  operation: () => Promise<T>,
): Promise<T> {
  const sink = (destination: Destination) =>
    createLineSplitter((line) => {
      // Progress rendering and logging must not be captured recursively. Async
      // work started by the sink also runs outside the publisher's context.
      context.exit(() => onLine(line, destination));
    });
  const capture: Capture = {
    stdout: sink("stdout"),
    stderr: sink("stderr"),
    decoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
    closed: false,
  };
  if (active++ === 0) {
    const undo = (["stdout", "stderr"] as const).map((destination) => {
      const stream = process[destination];
      const original = stream.write;
      const intercept: typeof stream.write = function (chunk, encodingOrCallback?, callback?) {
        const current = context.getStore();
        if (!current || current.closed) {
          return Reflect.apply(original, stream, [chunk, encodingOrCallback, callback]);
        }
        const text =
          typeof chunk === "string"
            ? chunk
            : current.decoders[destination].write(Buffer.from(chunk));
        current[destination].push(text);
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
        if (typeof done === "function") process.nextTick(done);
        return true;
      };
      stream.write = intercept;
      return () => {
        if (stream.write === intercept) stream.write = original;
      };
    });
    restore = () => undo.forEach((restoreStream) => restoreStream());
  }
  try {
    return await context.run(capture, operation);
  } finally {
    try {
      for (const destination of ["stdout", "stderr"] as const) {
        capture[destination].push(capture.decoders[destination].end());
        capture[destination].flush();
      }
    } finally {
      capture.closed = true;
      if (--active === 0) {
        restore?.();
        restore = undefined;
      }
    }
  }
}
