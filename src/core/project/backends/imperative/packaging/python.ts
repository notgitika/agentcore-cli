import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { ProjectStateError } from "../../../../../errors";
import { ProcessFailedError, requireTool, type ProcessRunner } from "../../../../../io/exec";

export type PackageInput = {
  /** Absolute path of the runtime's code directory: <project root>/<codeLocation>. */
  codeDir: string;
  /** PYTHON_3_10 … PYTHON_3_14 (the spec's runtimeVersion). */
  runtimeVersion: string;
  /** Directory this packager owns and may wipe: <project root>/agentcore/.cli/build/<runtime>. */
  buildDir: string;
  run: ProcessRunner;
  /** Verifies `uv` is on PATH; injectable so tests do not need uv. */
  checkTool?: (tool: string, installHint: string) => Promise<void>;
  /** One line of progress at a time (uv output, "copying source", "zipping"). */
  report?: (line: string) => void;
  signal?: AbortSignal;
};
export type PackagedCode = { zipPath: string; sizeBytes: number; sha256: string };
export type CodeZipPackager = (input: PackageInput) => Promise<PackagedCode>;

/** The L3 packager's hint, word for word. */
export const UV_INSTALL_HINT =
  "Install uv from https://github.com/astral-sh/uv#installation and ensure it is on your PATH.";
/** Same order as the L3 packager: oldest glibc first so the widest wheel set wins. */
export const PLATFORM_CANDIDATES: readonly string[] = [
  "aarch64-manylinux2014",
  "aarch64-manylinux_2_28",
  "aarch64-manylinux_2_34",
];
export const EXCLUDED_ENTRIES: ReadonlySet<string> = new Set([
  ".git",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".DS_Store",
  "node_modules",
]);
export const MAX_ZIP_SIZE_BYTES = 250 * 1024 * 1024;

/** L3 skips the project's config directory when it sits at the root of the copied source. */
const CONFIG_DIR = "agentcore";
// A fixed mtime keeps the zip, and so its sha256 and S3 key, stable across builds.
const ZIP_MTIME = new Date("1980-01-02T00:00:00Z");
// uv's two ways of saying "no wheel for this platform" (L3 uv.js detectUnavailablePlatform).
const PLATFORM_HINT = /platforms:\s*([^\n]+)/i;
const MANYLINUX_TOKEN = /manylinux[^\s,]+/i;
const NO_WHEELS =
  /(no wheels with a matching (?:platform|Python ABI) tag|no compatible (?:wheels|tags) found|no usable wheels)/i;

/** Console scripts pip writes with the build host's interpreter path; L3 regenerates them. */
const CONSOLE_SCRIPTS: Record<string, { module: string; func: string }> = {
  "opentelemetry-instrument": {
    module: "opentelemetry.instrumentation.auto_instrumentation",
    func: "run",
  },
  "opentelemetry-bootstrap": { module: "opentelemetry.instrumentation.bootstrap", func: "run" },
};

/** Both scripts ship with the opentelemetry-instrumentation distribution. */
const OTEL_PACKAGE = ["opentelemetry", "instrumentation"];

function isUnavailablePlatform(output: string): boolean {
  const hint = PLATFORM_HINT.exec(output)?.[1];
  if (hint && MANYLINUX_TOKEN.test(hint)) return true;
  return NO_WHEELS.test(output);
}

function pythonVersionOf(runtimeVersion: string): string {
  const match = /^PYTHON_(\d+)_(\d+)$/.exec(runtimeVersion);
  if (!match) throw new ProjectStateError(`'${runtimeVersion}' is not a Python runtime version`);
  return `${match[1]}.${match[2]}`;
}

function consoleScript(module: string, func: string): string {
  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import re
import sys
from ${module} import ${func}
if __name__ == '__main__':
    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])
    sys.exit(${func}())
`;
}

const uvOutput = (report: (line: string) => void) => (chunk: string) => {
  for (const line of chunk.split(/\r?\n/)) if (line) report(line);
};

/**
 * What `uv pip install -r` reads. A project with a `uv.lock` installs the
 * pinned set exported from it, so two deploys of unchanged code build the same
 * zip even after upstream releases; without a lockfile the resolver runs fresh
 * against pyproject.toml, as the L3 packager always does.
 */
async function requirementsFile(
  input: PackageInput,
  report: (line: string) => void,
): Promise<string> {
  const pyproject = join(input.codeDir, "pyproject.toml");
  if (!existsSync(pyproject)) {
    throw new ProjectStateError(
      `${input.codeDir} has no pyproject.toml; CodeZip runtimes declare their dependencies there.`,
    );
  }
  if (!existsSync(join(input.codeDir, "uv.lock"))) return pyproject;
  // Outside staging/, so the export never ends up in the zip.
  const exported = join(input.buildDir, "requirements.txt");
  await mkdir(input.buildDir, { recursive: true });
  report("Exporting pinned dependencies from uv.lock");
  await input.run(
    ["uv", "export", "--no-hashes", "--no-dev", "--no-emit-project", "--output-file", exported],
    { cwd: input.codeDir, signal: input.signal, onOutput: uvOutput(report) },
  );
  return exported;
}

async function installDependencies(
  input: PackageInput,
  staging: string,
  report: (line: string) => void,
): Promise<string> {
  const requirements = await requirementsFile(input, report);
  const pythonVersion = pythonVersionOf(input.runtimeVersion);
  let lastError: ProcessFailedError | undefined;
  for (const platform of PLATFORM_CANDIDATES) {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    report(`Installing dependencies for ${platform} (python ${pythonVersion})`);
    try {
      await input.run(
        [
          "uv",
          "pip",
          "install",
          "-r",
          requirements,
          "--target",
          staging,
          "--python-version",
          pythonVersion,
          "--python-platform",
          platform,
          "--only-binary",
          ":all:",
        ],
        {
          cwd: input.codeDir,
          signal: input.signal,
          onOutput: uvOutput(report),
        },
      );
      return platform;
    } catch (error) {
      if (error instanceof ProcessFailedError && isUnavailablePlatform(error.message)) {
        lastError = error;
        report(`No compatible wheels for ${platform}; trying the next platform`);
        continue;
      }
      throw error;
    }
  }
  throw new ProjectStateError(
    `Could not install dependencies for any supported platform (${PLATFORM_CANDIDATES.join(", ")}).\n\n${lastError?.message ?? ""}`,
  );
}

/** L3 copySourceTree: excluded names at every depth, plus `agentcore/` at the root. */
async function copySource(source: string, destination: string, root: string): Promise<void> {
  if ((await stat(source)).isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      if (EXCLUDED_ENTRIES.has(entry)) continue;
      if (entry === CONFIG_DIR && resolve(source) === resolve(root)) continue;
      await copySource(join(source, entry), join(destination, entry), root);
    }
    return;
  }
  await copyFile(source, destination);
}

/**
 * Rewrites the known console scripts with a portable shebang. L3 only rewrites
 * scripts uv already wrote to bin/; this also writes them when the package
 * (opentelemetry-instrumentation) is installed without them, so the runtime's `opentelemetry-instrument` entry
 * point always resolves.
 */
async function regenerateConsoleScripts(staging: string): Promise<void> {
  const bin = join(staging, "bin");
  for (const [name, { module, func }] of Object.entries(CONSOLE_SCRIPTS)) {
    const path = join(bin, name);
    if (!existsSync(path) && !existsSync(join(staging, ...OTEL_PACKAGE))) continue;
    await mkdir(bin, { recursive: true });
    await writeFile(path, consoleScript(module, func), { mode: 0o755 });
  }
}

type CollectedFile = { path: string; bytes: Uint8Array; executable: boolean };

async function collectFiles(dir: string, base = dir): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (EXCLUDED_ENTRIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(full, base)));
    else if (entry.isFile()) {
      const mode = (await stat(full)).mode;
      out.push({
        path: relative(base, full).split(sep).join("/"),
        bytes: new Uint8Array(await readFile(full)),
        executable: (mode & 0o111) !== 0,
      });
    }
  }
  return out;
}

/**
 * Builds the CodeZip for a Python runtime the way the L3 construct does:
 * `uv pip install` into a clean staging directory (falling back across
 * manylinux platforms), overlay the source, fix console scripts, zip.
 */
export const packagePythonCodeZip: CodeZipPackager = async (input) => {
  const report = input.report ?? (() => {});
  await (input.checkTool ?? requireTool)("uv", UV_INSTALL_HINT);
  const staging = join(input.buildDir, "staging");
  await installDependencies(input, staging, report);
  report("Copying source");
  await copySource(input.codeDir, staging, input.codeDir);
  await regenerateConsoleScripts(staging);
  report("Zipping");
  const zippable: Zippable = {};
  for (const file of await collectFiles(staging)) {
    // os 3 = Unix, so the high 16 bits of attrs are the st_mode the runtime unpacks.
    const mode = file.executable ? 0o100755 : 0o100644;
    zippable[file.path] = [
      file.bytes,
      { level: 6, mtime: ZIP_MTIME, os: 3, attrs: (mode << 16) >>> 0 },
    ];
  }
  const zip = zipSync(zippable, { level: 6, mtime: ZIP_MTIME });
  if (zip.byteLength > MAX_ZIP_SIZE_BYTES) {
    throw new ProjectStateError(
      `The packaged code is ${(zip.byteLength / 1024 / 1024).toFixed(1)} MiB; CodeZip runtimes are ` +
        `limited to 250 MiB. Trim dependencies or switch the runtime to a Container build.`,
    );
  }
  const zipPath = join(input.buildDir, "code.zip");
  await writeFile(zipPath, zip);
  return {
    zipPath,
    sizeBytes: zip.byteLength,
    sha256: createHash("sha256").update(zip).digest("hex"),
  };
};
