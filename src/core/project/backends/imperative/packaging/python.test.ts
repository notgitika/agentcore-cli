import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { ProcessFailedError, type ProcessRunner } from "../../../../../io/exec";
import { packagePythonCodeZip, PLATFORM_CANDIDATES } from "./python";

let root: string;
let codeDir: string;
let buildDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codezip-"));
  codeDir = join(root, "app", "agent");
  buildDir = join(root, "agentcore", ".cli", "build", "agent");
  await mkdir(join(codeDir, ".venv", "lib"), { recursive: true });
  await mkdir(join(codeDir, "__pycache__"), { recursive: true });
  await writeFile(
    join(codeDir, "pyproject.toml"),
    '[project]\nname="agent"\ndependencies=["strands-agents"]\n',
  );
  await writeFile(join(codeDir, "main.py"), "print('hi')\n");
  await writeFile(join(codeDir, ".venv", "lib", "junk.py"), "");
  await writeFile(join(codeDir, "__pycache__", "main.cpython-314.pyc"), "");
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** A uv stand-in: writes a fake site-packages tree into --target and records the platform. */
function fakeUv(options: { failOn?: string[]; withOtel?: boolean; output?: string } = {}) {
  const platforms: string[] = [];
  const exports: string[] = [];
  const run: ProcessRunner = async (command, { cwd, onOutput }) => {
    expect(cwd).toBe(codeDir);
    if (command[1] === "export") {
      const out = command[command.indexOf("--output-file") + 1]!;
      exports.push(out);
      await writeFile(out, "# exported\nstrands-agents==1.0.0\n");
      return;
    }
    expect(command.slice(0, 3)).toEqual(["uv", "pip", "install"]);
    const target = command[command.indexOf("--target") + 1]!;
    const platform = command[command.indexOf("--python-platform") + 1]!;
    platforms.push(platform);
    onOutput?.(`Resolved 3 packages for ${platform}\n`);
    if (options.failOn?.includes(platform)) {
      throw new ProcessFailedError(
        command,
        cwd,
        1,
        options.output ?? "error: no wheels with a matching platform tag",
      );
    }
    await mkdir(join(target, "strands"), { recursive: true });
    await writeFile(join(target, "strands", "__init__.py"), "");
    if (options.withOtel) {
      await mkdir(join(target, "opentelemetry", "instrumentation", "auto_instrumentation"), {
        recursive: true,
      });
      await writeFile(
        join(target, "opentelemetry", "instrumentation", "auto_instrumentation", "__init__.py"),
        "",
      );
    }
  };
  return { run, platforms, exports };
}

const entriesOf = async (zipPath: string) =>
  Object.keys(unzipSync(new Uint8Array(await readFile(zipPath)))).sort();

describe("packagePythonCodeZip", () => {
  test("installs for the first platform, copies the source, excludes junk, and zips", async () => {
    const uv = fakeUv();
    const lines: string[] = [];
    const result = await packagePythonCodeZip({
      codeDir,
      runtimeVersion: "PYTHON_3_14",
      buildDir,
      run: uv.run,
      checkTool: async () => {},
      report: (line) => lines.push(line),
    });
    expect(uv.platforms).toEqual(["aarch64-manylinux2014"]);
    expect(result.zipPath).toBe(join(buildDir, "code.zip"));
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    const entries = await entriesOf(result.zipPath);
    expect(entries).toContain("main.py");
    expect(entries).toContain("pyproject.toml");
    expect(entries).toContain("strands/__init__.py");
    expect(entries.some((e) => e.startsWith(".venv"))).toBe(false);
    expect(entries.some((e) => e.includes("__pycache__"))).toBe(false);
    expect(lines.some((l) => l.includes("Resolved 3 packages"))).toBe(true);
  });

  test("passes the python version derived from the runtime version", async () => {
    let seen: string[] = [];
    const run: ProcessRunner = async (command) => {
      seen = command;
      await fakeUv().run(command, { cwd: codeDir });
    };
    await packagePythonCodeZip({
      codeDir,
      runtimeVersion: "PYTHON_3_12",
      buildDir,
      run,
      checkTool: async () => {},
    });
    expect(seen[seen.indexOf("--python-version") + 1]).toBe("3.12");
    expect(seen).toContain("--only-binary");
    expect(seen[seen.indexOf("-r") + 1]).toBe(join(codeDir, "pyproject.toml"));
  });

  test("falls back to the next platform when wheels are unavailable", async () => {
    const uv = fakeUv({ failOn: ["aarch64-manylinux2014"] });
    await packagePythonCodeZip({
      codeDir,
      runtimeVersion: "PYTHON_3_14",
      buildDir,
      run: uv.run,
      checkTool: async () => {},
    });
    expect(uv.platforms).toEqual(["aarch64-manylinux2014", "aarch64-manylinux_2_28"]);
  });

  test("fails with uv's output when every platform fails", async () => {
    const uv = fakeUv({ failOn: [...PLATFORM_CANDIDATES] });
    await expect(
      packagePythonCodeZip({
        codeDir,
        runtimeVersion: "PYTHON_3_14",
        buildDir,
        run: uv.run,
        checkTool: async () => {},
      }),
    ).rejects.toThrow(/no wheels with a matching platform/);
    expect(uv.platforms).toEqual([...PLATFORM_CANDIDATES]);
  });

  test("rethrows a uv failure that is not a platform problem", async () => {
    const uv = fakeUv({
      failOn: ["aarch64-manylinux2014"],
      output: "error: Failed to parse pyproject.toml",
    });
    await expect(
      packagePythonCodeZip({
        codeDir,
        runtimeVersion: "PYTHON_3_14",
        buildDir,
        run: uv.run,
        checkTool: async () => {},
      }),
    ).rejects.toThrow(/Failed to parse pyproject.toml/);
    expect(uv.platforms).toEqual(["aarch64-manylinux2014"]);
  });

  test("regenerates the opentelemetry console scripts when the package is installed", async () => {
    const uv = fakeUv({ withOtel: true });
    const result = await packagePythonCodeZip({
      codeDir,
      runtimeVersion: "PYTHON_3_14",
      buildDir,
      run: uv.run,
      checkTool: async () => {},
    });
    const zip = unzipSync(new Uint8Array(await readFile(result.zipPath)));
    const instrument = new TextDecoder().decode(zip["bin/opentelemetry-instrument"]!);
    expect(instrument.startsWith("#!/usr/bin/env python3\n")).toBe(true);
    expect(instrument).toContain(
      "from opentelemetry.instrumentation.auto_instrumentation import run",
    );
    expect(new TextDecoder().decode(zip["bin/opentelemetry-bootstrap"]!)).toContain(
      "from opentelemetry.instrumentation.bootstrap import run",
    );
  });

  test("produces the same sha256 for the same inputs", async () => {
    const a = await packagePythonCodeZip({
      codeDir,
      runtimeVersion: "PYTHON_3_14",
      buildDir,
      run: fakeUv().run,
      checkTool: async () => {},
    });
    await new Promise((r) => setTimeout(r, 1100)); // a second later, mtimes differ on disk
    const b = await packagePythonCodeZip({
      codeDir,
      runtimeVersion: "PYTHON_3_14",
      buildDir,
      run: fakeUv().run,
      checkTool: async () => {},
    });
    expect(b.sha256).toBe(a.sha256);
  });

  test("requires uv before running anything", async () => {
    const uv = fakeUv();
    await expect(
      packagePythonCodeZip({
        codeDir,
        runtimeVersion: "PYTHON_3_14",
        buildDir,
        run: uv.run,
        checkTool: async () => {
          throw new Error("'uv' was not found on your PATH");
        },
      }),
    ).rejects.toThrow(/uv/);
    expect(uv.platforms).toEqual([]);
    expect(existsSync(join(buildDir, "code.zip"))).toBe(false);
  });

  test("installs the pinned set exported from uv.lock when the project has one", async () => {
    await writeFile(join(codeDir, "uv.lock"), "version = 1\n");
    const uv = fakeUv();
    let installed: string[] = [];
    const run: ProcessRunner = async (command, options) => {
      if (command[1] === "pip") installed = command;
      await uv.run(command, options);
    };
    const result = await packagePythonCodeZip({
      codeDir,
      runtimeVersion: "PYTHON_3_14",
      buildDir,
      run,
      checkTool: async () => {},
    });
    const exported = join(buildDir, "requirements.txt");
    expect(uv.exports).toEqual([exported]);
    expect(installed[installed.indexOf("-r") + 1]).toBe(exported);
    const entries = await entriesOf(result.zipPath);
    expect(entries).toContain("uv.lock");
    expect(entries).not.toContain("requirements.txt");
  });

  test("resolves from pyproject.toml when there is no uv.lock", async () => {
    const uv = fakeUv();
    await packagePythonCodeZip({
      codeDir,
      runtimeVersion: "PYTHON_3_14",
      buildDir,
      run: uv.run,
      checkTool: async () => {},
    });
    expect(uv.exports).toEqual([]);
  });

  test("refuses a code directory without pyproject.toml", async () => {
    await rm(join(codeDir, "pyproject.toml"));
    await expect(
      packagePythonCodeZip({
        codeDir,
        runtimeVersion: "PYTHON_3_14",
        buildDir,
        run: fakeUv().run,
        checkTool: async () => {},
      }),
    ).rejects.toThrow(/pyproject.toml/);
  });
});
