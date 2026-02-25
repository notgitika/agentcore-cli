import { parseDiffResult, parseStackDiff } from '../DiffSummaryView.js';
import { describe, expect, it } from 'vitest';

// ─── Fixtures ───────────────────────────────────────────────────────────

/** Minimal CDK diff output for a single stack with one resource added. */
const SINGLE_ADD_DIFF = `Stack MyStack

Resources
[+] AWS::IAM::Role MyRole MyRoleLogicalId`;

/** CDK diff output with ANSI escape codes (bold, color, underline). */
const ANSI_DIFF = [
  'Stack \x1b[1mMyStack\x1b[22m',
  '',
  '\x1b[4m\x1b[1mResources\x1b[22m\x1b[24m',
  '\x1b[32m[+]\x1b[39m \x1b[36mAWS::Lambda::Function\x1b[39m MyFunc \x1b[90mMyFuncLogicalId\x1b[39m',
].join('\n');

/** CDK diff with multiple sections and change types. */
const MULTI_SECTION_DIFF = `Stack ProdStack

Resources
[+] AWS::IAM::Role NewRole NewRoleLogicalId
[~] AWS::Lambda::Function ExistingFunc ExistingFuncLogicalId
 └─ [~] Runtime
 ├─ [~] Timeout
[-] AWS::S3::Bucket OldBucket OldBucketLogicalId

Outputs
[+] Output StackOutput StackOutputLogicalId`;

/** CDK diff with no resource changes. */
const EMPTY_DIFF = `Stack EmptyStack
There were no differences`;

/** Structured CDK I4002 data with formattedDiff and permissionChanges. */
const STRUCTURED_DATA = {
  formattedDiff: {
    diff: SINGLE_ADD_DIFF,
    security: 'IAM Statement Changes\nSome security info',
  },
  permissionChanges: 'broadening',
};

const STRUCTURED_DATA_NONE = {
  formattedDiff: {
    diff: SINGLE_ADD_DIFF,
  },
  permissionChanges: 'none',
};

// ─── parseStackDiff ─────────────────────────────────────────────────────

describe('parseStackDiff', () => {
  it('parses a simple single-resource addition', () => {
    const result = parseStackDiff(undefined, SINGLE_ADD_DIFF);

    expect(result.stackName).toBe('MyStack');
    expect(result.totalChanges).toBe(1);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.name).toBe('Resources');
    expect(result.sections[0]!.added).toBe(1);
    expect(result.sections[0]!.modified).toBe(0);
    expect(result.sections[0]!.removed).toBe(0);
    expect(result.sections[0]!.changes[0]).toEqual({
      kind: 'add',
      resourceType: 'AWS::IAM::Role',
      logicalId: 'MyRole',
      details: [],
    });
  });

  it('strips ANSI escape codes from diff text', () => {
    const result = parseStackDiff(undefined, ANSI_DIFF);

    expect(result.stackName).toBe('MyStack');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.changes[0]!.resourceType).toBe('AWS::Lambda::Function');
    expect(result.sections[0]!.changes[0]!.logicalId).toBe('MyFunc');
  });

  it('parses multiple sections with add, modify, and remove', () => {
    const result = parseStackDiff(undefined, MULTI_SECTION_DIFF);

    expect(result.stackName).toBe('ProdStack');
    expect(result.totalChanges).toBe(4);
    expect(result.sections).toHaveLength(2);

    const resources = result.sections[0]!;
    expect(resources.name).toBe('Resources');
    expect(resources.added).toBe(1);
    expect(resources.modified).toBe(1);
    expect(resources.removed).toBe(1);
    expect(resources.changes).toHaveLength(3);

    // Verify change kinds
    expect(resources.changes[0]!.kind).toBe('add');
    expect(resources.changes[1]!.kind).toBe('modify');
    expect(resources.changes[2]!.kind).toBe('remove');

    const outputs = result.sections[1]!;
    expect(outputs.name).toBe('Outputs');
    expect(outputs.added).toBe(1);
    expect(outputs.changes).toHaveLength(1);
  });

  it('parses property-level detail lines for modifications', () => {
    const result = parseStackDiff(undefined, MULTI_SECTION_DIFF);

    const modifiedResource = result.sections[0]!.changes[1]!;
    expect(modifiedResource.kind).toBe('modify');
    expect(modifiedResource.details).toEqual(['Runtime', 'Timeout']);
  });

  it('returns zero totalChanges for a diff with no resource changes', () => {
    const result = parseStackDiff(undefined, EMPTY_DIFF);

    expect(result.stackName).toBe('EmptyStack');
    expect(result.totalChanges).toBe(0);
    expect(result.sections).toHaveLength(0);
  });

  it('uses structured data formattedDiff when available', () => {
    const result = parseStackDiff(STRUCTURED_DATA, 'fallback message');

    // Should use formattedDiff.diff, not the fallback message
    expect(result.stackName).toBe('MyStack');
    expect(result.totalChanges).toBe(1);
  });

  it('falls back to message text when structured data is undefined', () => {
    const result = parseStackDiff(undefined, SINGLE_ADD_DIFF);

    expect(result.stackName).toBe('MyStack');
    expect(result.totalChanges).toBe(1);
  });

  it('detects security changes from permissionChanges=broadening', () => {
    const result = parseStackDiff(STRUCTURED_DATA, '');

    expect(result.hasSecurityChanges).toBe(true);
    expect(result.securitySummary).toBe('IAM policy broadening detected');
  });

  it('detects security changes from security text', () => {
    const data = {
      formattedDiff: {
        diff: SINGLE_ADD_DIFF,
        security: 'Some security changes',
      },
      permissionChanges: 'none',
    };
    const result = parseStackDiff(data, '');

    expect(result.hasSecurityChanges).toBe(true);
    expect(result.securitySummary).toBe('IAM statement changes detected');
  });

  it('reports no security changes when permissionChanges=none and no security text', () => {
    const result = parseStackDiff(STRUCTURED_DATA_NONE, '');

    expect(result.hasSecurityChanges).toBe(false);
    expect(result.securitySummary).toBeUndefined();
  });

  it('defaults stack name to Unknown Stack when no Stack line found', () => {
    const result = parseStackDiff(undefined, 'Resources\n[+] AWS::S3::Bucket MyBucket MyBucketId');

    expect(result.stackName).toBe('Unknown Stack');
    expect(result.totalChanges).toBe(1);
  });

  it('handles all CDK section types', () => {
    const diff = `Stack TestStack

Parameters
[+] Parameter BootstrapVersion BootstrapVersionParam

Conditions
[+] Condition HasBucket HasBucketCondition

Mappings
[+] Mapping RegionMap RegionMapId

Resources
[+] AWS::S3::Bucket MyBucket MyBucketId`;

    const result = parseStackDiff(undefined, diff);

    expect(result.sections).toHaveLength(4);
    expect(result.sections.map(s => s.name)).toEqual(['Parameters', 'Conditions', 'Mappings', 'Resources']);
    expect(result.totalChanges).toBe(4);
  });
});

// ─── parseDiffResult ────────────────────────────────────────────────────

describe('parseDiffResult', () => {
  it('extracts numStacksWithChanges from structured data', () => {
    const result = parseDiffResult({ numStacksWithChanges: 3 });

    expect(result.numStacksWithChanges).toBe(3);
  });

  it('defaults to 0 when numStacksWithChanges is missing', () => {
    const result = parseDiffResult({});

    expect(result.numStacksWithChanges).toBe(0);
  });

  it('defaults to 0 when data is undefined', () => {
    const result = parseDiffResult(undefined);

    expect(result.numStacksWithChanges).toBe(0);
  });

  it('handles zero stacks with changes', () => {
    const result = parseDiffResult({ numStacksWithChanges: 0 });

    expect(result.numStacksWithChanges).toBe(0);
  });
});
