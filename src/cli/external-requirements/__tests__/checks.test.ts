import { checkCreateDependencies } from '../checks';
import { describe, expect, it } from 'vitest';

describe('checkCreateDependencies', () => {
  describe('result structure', () => {
    it('returns proper structure with all fields', async () => {
      const result = await checkCreateDependencies();

      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('warnings');
      expect(Array.isArray(result.checks)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it('always checks npm and aws when no language specified', async () => {
      const result = await checkCreateDependencies();

      const binaries = result.checks.map(c => c.binary);
      expect(binaries).toContain('npm');
      expect(binaries).toContain('aws');
      expect(binaries).not.toContain('uv');
    });

    it('checks uv only for Python language', async () => {
      const result = await checkCreateDependencies({ language: 'Python' });

      const binaries = result.checks.map(c => c.binary);
      expect(binaries).toContain('uv');
      expect(binaries).toContain('npm');
      expect(binaries).toContain('aws');
    });

    it('does not check uv for TypeScript language', async () => {
      const result = await checkCreateDependencies({ language: 'TypeScript' });

      const binaries = result.checks.map(c => c.binary);
      expect(binaries).not.toContain('uv');
      expect(binaries).toContain('npm');
      expect(binaries).toContain('aws');
    });
  });

  describe('severity levels', () => {
    it('marks npm as error severity', async () => {
      const result = await checkCreateDependencies();

      const npmCheck = result.checks.find(c => c.binary === 'npm');
      expect(npmCheck?.severity).toBe('error');
    });

    it('marks aws as warn severity', async () => {
      const result = await checkCreateDependencies();

      const awsCheck = result.checks.find(c => c.binary === 'aws');
      expect(awsCheck?.severity).toBe('warn');
    });

    it('marks uv as error severity for Python', async () => {
      const result = await checkCreateDependencies({ language: 'Python' });

      const uvCheck = result.checks.find(c => c.binary === 'uv');
      expect(uvCheck?.severity).toBe('error');
    });
  });

  describe('install hints', () => {
    it('provides install hints for all checked tools', async () => {
      const result = await checkCreateDependencies({ language: 'Python' });

      for (const check of result.checks) {
        expect(check.installHint).toBeDefined();
        expect(check.installHint!.length).toBeGreaterThan(0);
      }
    });

    it('npm hint mentions nodejs.org', async () => {
      const result = await checkCreateDependencies();

      const npmCheck = result.checks.find(c => c.binary === 'npm');
      expect(npmCheck?.installHint).toContain('nodejs.org');
    });

    it('aws hint mentions aws.amazon.com', async () => {
      const result = await checkCreateDependencies();

      const awsCheck = result.checks.find(c => c.binary === 'aws');
      expect(awsCheck?.installHint).toContain('aws.amazon.com');
    });

    it('uv hint mentions astral-sh/uv', async () => {
      const result = await checkCreateDependencies({ language: 'Python' });

      const uvCheck = result.checks.find(c => c.binary === 'uv');
      expect(uvCheck?.installHint).toContain('astral-sh/uv');
    });
  });

  describe('passed logic', () => {
    it('passed is true when no error-severity tools are missing', async () => {
      // Assuming npm is installed in the test environment
      const result = await checkCreateDependencies();

      // If npm is available, passed should be true (aws missing is just a warning)
      if (result.checks.find(c => c.binary === 'npm')?.available) {
        expect(result.passed).toBe(true);
      }
    });

    it('errors array only contains error-severity failures', async () => {
      const result = await checkCreateDependencies();

      // If there are errors, they should all be about error-severity tools (npm, uv)
      for (const error of result.errors) {
        expect(error).toMatch(/'(npm|uv)'/);
      }
    });

    it('warnings array only contains warn-severity failures', async () => {
      const result = await checkCreateDependencies();

      // If aws is missing, it should be in warnings, not errors
      const awsCheck = result.checks.find(c => c.binary === 'aws');
      if (awsCheck && !awsCheck.available) {
        expect(result.warnings.some(w => w.includes('aws'))).toBe(true);
        expect(result.errors.some(e => e.includes('aws'))).toBe(false);
      }
    });
  });
});
