/**
 * Main entry point for the @aws/agentcore-cli package.
 * Exports public APIs from schema and lib modules.
 *
 * For CDK constructs, use @aws/agentcore-l3-cdk-constructs package.
 */

// Schema exports (types, constants, errors)
export * from './schema';

// Lib exports (utilities, packaging, config I/O)
export * from './lib';
