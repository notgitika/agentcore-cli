# Beta Testing Distribution Guide

This guide explains how to package and distribute the AgentCore CLI and L3 CDK Constructs for beta testing using npm tarballs.

## Building the Packages

### 1. Build the L3 CDK Constructs Package

```bash
cd agentcore-l3-cdk-constructs
npm install
npm run build
npm pack
```

This creates: `aws-agentcore-l3-cdk-constructs-0.1.0.tgz`

### 2. Build the CLI Package

```bash
cd agentcore-cli
npm install
npm run build
npm pack
```

This creates: `aws-agentcore-cli-0.1.0.tgz`

## Distribution to Beta Testers

### Option A: Install Globally (Recommended for Beta Testing)

**Step 1: Install L3 Constructs Globally**
```bash
npm install -g aws-agentcore-l3-cdk-constructs-0.1.0.tgz
```

**Step 2: Install CLI Globally**
```bash
npm install -g aws-agentcore-cli-0.1.0.tgz
```

**Step 3: Verify Installation**
```bash
agentcore-cli --version
npm list -g @aws/agentcore-l3-cdk-constructs
```

**Step 4: Create and Deploy Projects**
```bash
agentcore-cli create
cd MyProject
agentcore-cli deploy
```

The CLI will automatically find the globally installed L3 constructs package.

### Option B: Local Installation with npm link

**Step 1: Extract and Link L3 Constructs**
```bash
tar -xzf aws-agentcore-l3-cdk-constructs-0.1.0.tgz
cd package
npm install
npm link
cd ..
```

**Step 2: Install CLI Globally**
```bash
npm install -g aws-agentcore-cli-0.1.0.tgz
```

**Step 3: Create Projects**
```bash
agentcore-cli create
cd MyProject/agentcore/cdk
npm link @aws/agentcore-l3-cdk-constructs
cd ../..
agentcore-cli deploy
```

## How It Works

The CLI has been designed to handle multiple installation scenarios:

1. **Check if package exists**: First checks if `@aws/agentcore-l3-cdk-constructs` is already available
2. **Try npm link**: Attempts to link (works for local development)
3. **Check global installation**: Looks for globally installed package (beta testing)
4. **Install from registry**: Falls back to npm registry (production)

### Generated CDK Project Behavior

When you run `agentcore-cli create`, the generated CDK project includes:

- **package.json**: Lists `@aws/agentcore-l3-cdk-constructs` as a dependency
- **postinstall script**: Attempts to link the package automatically
- **Deploy command**: Ensures package is available before building

## Troubleshooting

### Error: Cannot find module '@aws/agentcore-l3-cdk-constructs'

**Solution 1: Install L3 package globally**
```bash
npm install -g aws-agentcore-l3-cdk-constructs-0.1.0.tgz
```

**Solution 2: Link manually in CDK project**
```bash
cd <project>/agentcore/cdk
npm link @aws/agentcore-l3-cdk-constructs
```

**Solution 3: Install locally in CDK project**
```bash
cd <project>/agentcore/cdk
npm install ../../../aws-agentcore-l3-cdk-constructs-0.1.0.tgz
```

### Verify Package Availability

**Check global installation:**
```bash
npm list -g @aws/agentcore-l3-cdk-constructs --depth=0
```

**Check in CDK project:**
```bash
cd <project>/agentcore/cdk
npm list @aws/agentcore-l3-cdk-constructs --depth=0
```

## Beta Testing Checklist

Before distributing to beta testers:

- [ ] Build both packages with `npm pack`
- [ ] Test installation on a clean machine
- [ ] Verify `agentcore-cli create` works
- [ ] Verify `agentcore-cli deploy` works
- [ ] Test on Windows, macOS, and Linux
- [ ] Document any platform-specific issues

## Distribution Package Contents

Include these files in your beta distribution:

```
beta-release/
├── aws-agentcore-l3-cdk-constructs-0.1.0.tgz
├── aws-agentcore-cli-0.1.0.tgz
├── INSTALL.md (installation instructions)
└── RELEASE_NOTES.md (what's new, known issues)
```

## Sample INSTALL.md for Beta Testers

```markdown
# AgentCore CLI Beta Installation

## Prerequisites
- Node.js >= 20
- npm >= 10
- Python >= 3.10 (for agent development)
- uv (Python package manager)

## Installation Steps

1. Install the L3 CDK Constructs package:
   ```bash
   npm install -g aws-agentcore-l3-cdk-constructs-0.1.0.tgz
   ```

2. Install the AgentCore CLI:
   ```bash
   npm install -g aws-agentcore-cli-0.1.0.tgz
   ```

3. Verify installation:
   ```bash
   agentcore-cli --version
   ```

4. Create your first project:
   ```bash
   agentcore-cli create
   ```

## Getting Help

If you encounter issues:
- Check the troubleshooting section in BETA_TESTING_GUIDE.md
- Report issues to [your issue tracker]
- Contact [your support channel]
```

## Automated Testing Script

Create a test script to verify the distribution:

```bash
#!/bin/bash
# test-beta-distribution.sh

set -e

echo "Testing beta distribution..."

# Clean environment
npm uninstall -g @aws/agentcore-cli @aws/agentcore-l3-cdk-constructs 2>/dev/null || true

# Install packages
echo "Installing L3 constructs..."
npm install -g aws-agentcore-l3-cdk-constructs-0.1.0.tgz

echo "Installing CLI..."
npm install -g aws-agentcore-cli-0.1.0.tgz

# Verify installation
echo "Verifying installation..."
agentcore-cli --version
npm list -g @aws/agentcore-l3-cdk-constructs --depth=0

# Test create command
echo "Testing create command..."
mkdir -p /tmp/agentcore-test
cd /tmp/agentcore-test
agentcore-cli create --name TestAgent --framework strands --model-provider Bedrock

# Test build
echo "Testing CDK build..."
cd TestAgent/agentcore/cdk
npm run build

echo "✅ Beta distribution test passed!"
```

## Notes for Production Release

When ready for production npm registry release:

1. Remove the `ensureL3Link()` logic (package will be on npm)
2. Update package.json to reference the published version
3. Remove postinstall npm link script
4. Update documentation to use `npm install -g agentcore-cli`
