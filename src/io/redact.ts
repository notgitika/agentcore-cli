/** Redact configured values longest-first so overlapping values cannot reveal suffixes. */
export function redactValues(values: readonly string[]): (text: string) => string {
  // Process output is delivered one line at a time; structured diagnostics can
  // also escape a value rather than print it literally.
  const variants = values.flatMap((value) =>
    [value, ...value.split(/\r?\n/)].flatMap((part) => [part, JSON.stringify(part).slice(1, -1)]),
  );
  const ordered = [...new Set(variants)].filter(Boolean).sort((a, b) => b.length - a.length);
  return (text) => {
    for (const value of ordered) text = text.replaceAll(value, "[REDACTED]");
    return text;
  };
}

export function redactError(
  error: unknown,
  redact: (text: string) => string,
  seen = new Set<unknown>(),
): void {
  if (!(error instanceof Error) || seen.has(error)) return;
  seen.add(error);
  error.message = redact(error.message);
  if (error.stack) error.stack = redact(error.stack);
  if (error.cause) redactError(error.cause, redact, seen);
}
