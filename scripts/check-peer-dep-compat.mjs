#!/usr/bin/env node

/**
 * Cross-package peer dependency compatibility check.
 *
 * Verifies that the peer dependency ranges declared by this package
 * overlap with those declared by its partner package (@aws/agentcore-cdk).
 * Uses semver.intersects() to detect version drift that would cause
 * unresolvable install errors for customers using both packages.
 *
 * Exit 0 = compatible, Exit 1 = incompatible or error.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const semver = require('semver');

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Configuration ---
const PARTNER_GITHUB_REPO = 'aws/agentcore-l3-cdk-constructs'; // owner/repo
const PARTNER_NPM_PACKAGE = '@aws/agentcore-cdk'; // npm package name
const SHARED_PEER_DEPS = ['aws-cdk-lib', 'constructs'];
const MAX_MIN_VERSION_DRIFT_MAJOR = 0; // fail if minimum versions differ by more than this many majors
// --- End Configuration ---

async function fetchPartnerPeerDeps() {
  // Try GitHub API first (works for public repos and with GITHUB_TOKEN)
  const githubToken = process.env.GITHUB_TOKEN;
  const githubUrl = `https://api.github.com/repos/${PARTNER_GITHUB_REPO}/contents/package.json`;

  try {
    const headers = {
      Accept: 'application/vnd.github.v3.raw',
      'User-Agent': 'peer-dep-compat-check',
    };
    if (githubToken) {
      headers.Authorization = `token ${githubToken}`;
    }

    const res = await fetch(githubUrl, { headers });
    if (res.ok) {
      const pkg = await res.json();
      console.log(`Fetched partner peerDependencies from GitHub (${PARTNER_GITHUB_REPO})`);
      return pkg.peerDependencies || {};
    }
  } catch {
    // fall through to npm
  }

  // Fallback: npm registry
  const npmUrl = `https://registry.npmjs.org/${PARTNER_NPM_PACKAGE}/latest`;
  try {
    const res = await fetch(npmUrl, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const pkg = await res.json();
      console.log(`Fetched partner peerDependencies from npm (${PARTNER_NPM_PACKAGE})`);
      return pkg.peerDependencies || {};
    }
  } catch {
    // fall through
  }

  throw new Error(`Failed to fetch partner peerDependencies from both GitHub and npm`);
}

function readLocalPeerDeps() {
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.peerDependencies || {};
}

function checkCompatibility(localDeps, partnerDeps) {
  let hasFailure = false;

  for (const dep of SHARED_PEER_DEPS) {
    const localRange = localDeps[dep];
    const partnerRange = partnerDeps[dep];

    if (!localRange) {
      console.log(`  SKIP: ${dep} — not in local peerDependencies`);
      continue;
    }
    if (!partnerRange) {
      console.log(`  SKIP: ${dep} — not in partner peerDependencies`);
      continue;
    }

    console.log(`\n  Checking ${dep}:`);
    console.log(`    Local:   ${localRange}`);
    console.log(`    Partner: ${partnerRange}`);

    // Check range overlap
    if (!semver.intersects(localRange, partnerRange)) {
      console.log(`    FAIL: Ranges do not overlap!`);
      hasFailure = true;
      continue;
    }
    console.log(`    OK: Ranges overlap`);

    // Check minimum version drift
    const localMin = semver.minVersion(localRange);
    const partnerMin = semver.minVersion(partnerRange);
    if (localMin && partnerMin) {
      const majorDiff = Math.abs(localMin.major - partnerMin.major);
      const minorDiff = Math.abs(localMin.minor - partnerMin.minor);

      if (majorDiff > MAX_MIN_VERSION_DRIFT_MAJOR) {
        console.log(
          `    FAIL: Minimum versions differ by ${majorDiff} major version(s) (${localMin} vs ${partnerMin})`
        );
        hasFailure = true;
      } else if (minorDiff > 20) {
        console.log(
          `    WARN: Minimum versions differ by ${minorDiff} minor version(s) (${localMin} vs ${partnerMin})`
        );
      } else {
        console.log(`    OK: Minimum versions are close (${localMin} vs ${partnerMin})`);
      }
    }
  }

  return !hasFailure;
}

async function main() {
  console.log('Peer Dependency Compatibility Check');
  console.log('====================================\n');

  const localDeps = readLocalPeerDeps();
  console.log('Local peerDependencies:', JSON.stringify(localDeps, null, 2));

  let partnerDeps;
  try {
    partnerDeps = await fetchPartnerPeerDeps();
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    console.error('Cannot verify compatibility — treating as failure for safety.');
    process.exit(1);
  }
  console.log('Partner peerDependencies:', JSON.stringify(partnerDeps, null, 2));

  const compatible = checkCompatibility(localDeps, partnerDeps);

  if (compatible) {
    console.log('\n✅ All shared peer dependencies are compatible.');
    process.exit(0);
  } else {
    console.log('\n❌ Peer dependency incompatibility detected!');
    console.log('Customers installing both packages will encounter version conflicts.');
    console.log('Please align the peer dependency ranges before releasing.');
    process.exit(1);
  }
}

main();
