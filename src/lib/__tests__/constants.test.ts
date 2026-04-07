import { getArtifactZipName, getDockerfilePath } from '../constants.js';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('getArtifactZipName', () => {
  it('appends .zip to the name', () => {
    expect(getArtifactZipName('my-agent')).toBe('my-agent.zip');
  });

  it('works with simple names', () => {
    expect(getArtifactZipName('tool')).toBe('tool.zip');
  });

  it('works with empty string', () => {
    expect(getArtifactZipName('')).toBe('.zip');
  });

  it('does not strip existing extension', () => {
    expect(getArtifactZipName('agent.tar')).toBe('agent.tar.zip');
  });
});

describe('getDockerfilePath', () => {
  it('returns default Dockerfile when no custom name given', () => {
    expect(getDockerfilePath('/app/code')).toBe(join('/app/code', 'Dockerfile'));
  });

  it('returns custom dockerfile name joined to code location', () => {
    expect(getDockerfilePath('/app/code', 'Dockerfile.gpu')).toBe(join('/app/code', 'Dockerfile.gpu'));
  });

  it('rejects forward slash in dockerfile name', () => {
    expect(() => getDockerfilePath('/app/code', '../Dockerfile')).toThrow(/Invalid dockerfile name/);
  });

  it('rejects backslash in dockerfile name', () => {
    expect(() => getDockerfilePath('/app/code', 'Dockerfile\\..\\secret')).toThrow(/Invalid dockerfile name/);
  });

  it('rejects dot-dot traversal in dockerfile name', () => {
    expect(() => getDockerfilePath('/app/code', '..')).toThrow(/Invalid dockerfile name/);
  });

  it('rejects path/to/Dockerfile', () => {
    expect(() => getDockerfilePath('/app/code', 'path/to/Dockerfile')).toThrow(/Invalid dockerfile name/);
  });
});
