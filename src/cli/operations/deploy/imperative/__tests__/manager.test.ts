import { ImperativeDeploymentManager } from '../manager';
import type { DeployPhase, DeployProgress, ImperativeDeployContext, ImperativeDeployer } from '../types';
import { describe, expect, it, vi } from 'vitest';

function createMockDeployer(
  overrides: Partial<ImperativeDeployer> & { name: string; phase: DeployPhase }
): ImperativeDeployer {
  return {
    label: overrides.label ?? overrides.name,
    shouldRun: overrides.shouldRun ?? (() => true),
    deploy: overrides.deploy ?? (() => Promise.resolve({ success: true })),
    teardown: overrides.teardown ?? (() => Promise.resolve({ success: true })),
    ...overrides,
  };
}

function createMockContext(overrides?: Partial<ImperativeDeployContext>): ImperativeDeployContext {
  return {
    projectSpec: {} as ImperativeDeployContext['projectSpec'],
    target: {} as ImperativeDeployContext['target'],
    configIO: {} as ImperativeDeployContext['configIO'],
    deployedState: {} as ImperativeDeployContext['deployedState'],
    ...overrides,
  };
}

describe('ImperativeDeploymentManager', () => {
  describe('register', () => {
    it('returns this for chaining', () => {
      const manager = new ImperativeDeploymentManager();
      const deployer = createMockDeployer({ name: 'a', phase: 'pre-cdk' });
      const result = manager.register(deployer);
      expect(result).toBe(manager);
    });
  });

  describe('runPhase', () => {
    it('runs deployers in registration order within a phase', async () => {
      const order: string[] = [];
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'first',
          phase: 'pre-cdk',
          deploy: () => {
            order.push('first');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'second',
          phase: 'pre-cdk',
          deploy: () => {
            order.push('second');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'third',
          phase: 'pre-cdk',
          deploy: () => {
            order.push('third');
            return Promise.resolve({ success: true });
          },
        })
      );

      const context = createMockContext();
      const result = await manager.runPhase('pre-cdk', context);

      expect(result.success).toBe(true);
      expect(order).toEqual(['first', 'second', 'third']);
      expect(result.results.size).toBe(3);
    });

    it('skips deployers where shouldRun returns false', async () => {
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'runs',
          phase: 'pre-cdk',
          deploy: () => Promise.resolve({ success: true, state: { ran: true } }),
        })
      );
      manager.register(
        createMockDeployer({
          name: 'skipped',
          phase: 'pre-cdk',
          shouldRun: () => false,
          deploy: () => Promise.resolve({ success: true, state: { ran: true } }),
        })
      );

      const context = createMockContext();
      const result = await manager.runPhase('pre-cdk', context);

      expect(result.success).toBe(true);
      expect(result.results.has('runs')).toBe(true);
      expect(result.results.has('skipped')).toBe(false);
    });

    it('stops on first failure (fail-fast)', async () => {
      const order: string[] = [];
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'ok',
          phase: 'post-cdk',
          deploy: () => {
            order.push('ok');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'fail',
          phase: 'post-cdk',
          deploy: () => {
            order.push('fail');
            return Promise.resolve({ success: false, error: 'something broke' });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'never',
          phase: 'post-cdk',
          deploy: () => {
            order.push('never');
            return Promise.resolve({ success: true });
          },
        })
      );

      const context = createMockContext();
      const result = await manager.runPhase('post-cdk', context);

      expect(result.success).toBe(false);
      expect(result.error).toBe('something broke');
      expect(order).toEqual(['ok', 'fail']);
      expect(result.results.has('never')).toBe(false);
    });

    it('handles thrown errors as failures', async () => {
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'thrower',
          phase: 'pre-cdk',
          deploy: () => Promise.reject(new Error('unexpected crash')),
        })
      );

      const context = createMockContext();
      const result = await manager.runPhase('pre-cdk', context);

      expect(result.success).toBe(false);
      expect(result.error).toBe('unexpected crash');
      expect(result.results.get('thrower')?.success).toBe(false);
    });

    it('only runs deployers matching the requested phase', async () => {
      const order: string[] = [];
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'pre',
          phase: 'pre-cdk',
          deploy: () => {
            order.push('pre');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'post',
          phase: 'post-cdk',
          deploy: () => {
            order.push('post');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'standalone',
          phase: 'standalone',
          deploy: () => {
            order.push('standalone');
            return Promise.resolve({ success: true });
          },
        })
      );

      const context = createMockContext();
      const result = await manager.runPhase('post-cdk', context);

      expect(result.success).toBe(true);
      expect(order).toEqual(['post']);
      expect(result.results.size).toBe(1);
      expect(result.results.has('post')).toBe(true);
    });

    it('calls progress callbacks correctly', async () => {
      const manager = new ImperativeDeploymentManager();
      const onProgress = vi.fn<DeployProgress>();

      manager.register(
        createMockDeployer({
          name: 'deployer-a',
          label: 'Deployer A',
          phase: 'pre-cdk',
          deploy: () => Promise.resolve({ success: true }),
        })
      );
      manager.register(
        createMockDeployer({
          name: 'deployer-b',
          label: 'Deployer B',
          phase: 'pre-cdk',
          deploy: () => Promise.resolve({ success: false, error: 'oops' }),
        })
      );

      const context = createMockContext({ onProgress });
      await manager.runPhase('pre-cdk', context);

      expect(onProgress).toHaveBeenCalledTimes(4);
      expect(onProgress).toHaveBeenNthCalledWith(1, 'Deployer A', 'start');
      expect(onProgress).toHaveBeenNthCalledWith(2, 'Deployer A', 'done');
      expect(onProgress).toHaveBeenNthCalledWith(3, 'Deployer B', 'start');
      expect(onProgress).toHaveBeenNthCalledWith(4, 'Deployer B', 'error');
    });

    it('reports error status in progress callback on failure', async () => {
      const manager = new ImperativeDeploymentManager();
      const onProgress = vi.fn<DeployProgress>();

      manager.register(
        createMockDeployer({
          name: 'fail',
          label: 'Failing',
          phase: 'standalone',
          deploy: () => Promise.resolve({ success: false, error: 'boom' }),
        })
      );

      const context = createMockContext({ onProgress });
      await manager.runPhase('standalone', context);

      expect(onProgress).toHaveBeenCalledWith('Failing', 'start');
      expect(onProgress).toHaveBeenCalledWith('Failing', 'error');
    });

    it('returns empty results when no deployers are registered', async () => {
      const manager = new ImperativeDeploymentManager();
      const context = createMockContext();
      const result = await manager.runPhase('pre-cdk', context);

      expect(result.success).toBe(true);
      expect(result.results.size).toBe(0);
      expect(result.notes).toEqual([]);
    });

    it('returns empty results when no deployers match the phase', async () => {
      const manager = new ImperativeDeploymentManager();

      manager.register(createMockDeployer({ name: 'post-only', phase: 'post-cdk' }));

      const context = createMockContext();
      const result = await manager.runPhase('pre-cdk', context);

      expect(result.success).toBe(true);
      expect(result.results.size).toBe(0);
    });

    it('collects notes from successful deployers', async () => {
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'noted',
          phase: 'pre-cdk',
          deploy: () => Promise.resolve({ success: true, notes: ['note-1', 'note-2'] }),
        })
      );
      manager.register(
        createMockDeployer({
          name: 'also-noted',
          phase: 'pre-cdk',
          deploy: () => Promise.resolve({ success: true, notes: ['note-3'] }),
        })
      );

      const context = createMockContext();
      const result = await manager.runPhase('pre-cdk', context);

      expect(result.success).toBe(true);
      expect(result.notes).toEqual(['note-1', 'note-2', 'note-3']);
    });

    it('includes notes from deployers up to and including the failed one', async () => {
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'ok',
          phase: 'pre-cdk',
          deploy: () => Promise.resolve({ success: true, notes: ['before-fail'] }),
        })
      );
      manager.register(
        createMockDeployer({
          name: 'fail',
          phase: 'pre-cdk',
          deploy: () => Promise.resolve({ success: false, error: 'failed', notes: ['fail-note'] }),
        })
      );

      const context = createMockContext();
      const result = await manager.runPhase('pre-cdk', context);

      expect(result.success).toBe(false);
      expect(result.notes).toEqual(['before-fail', 'fail-note']);
    });
  });

  describe('teardownAll', () => {
    it('runs deployers in reverse registration order', async () => {
      const order: string[] = [];
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'first',
          phase: 'pre-cdk',
          teardown: () => {
            order.push('first');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'second',
          phase: 'post-cdk',
          teardown: () => {
            order.push('second');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'third',
          phase: 'standalone',
          teardown: () => {
            order.push('third');
            return Promise.resolve({ success: true });
          },
        })
      );

      const context = createMockContext();
      const result = await manager.teardownAll(context);

      expect(result.success).toBe(true);
      expect(order).toEqual(['third', 'second', 'first']);
    });

    it('runs all deployers regardless of phase', async () => {
      const manager = new ImperativeDeploymentManager();
      const torn: string[] = [];

      manager.register(
        createMockDeployer({
          name: 'pre',
          phase: 'pre-cdk',
          teardown: () => {
            torn.push('pre');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'post',
          phase: 'post-cdk',
          teardown: () => {
            torn.push('post');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'standalone',
          phase: 'standalone',
          teardown: () => {
            torn.push('standalone');
            return Promise.resolve({ success: true });
          },
        })
      );

      const context = createMockContext();
      const result = await manager.teardownAll(context);

      expect(result.success).toBe(true);
      expect(torn).toEqual(['standalone', 'post', 'pre']);
    });

    it('continues on failure and collects all errors (best-effort)', async () => {
      const order: string[] = [];
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'first',
          phase: 'pre-cdk',
          teardown: () => {
            order.push('first');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'second',
          phase: 'post-cdk',
          teardown: () => {
            order.push('second');
            return Promise.resolve({ success: false, error: 'teardown failed' });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'third',
          phase: 'standalone',
          teardown: () => {
            order.push('third');
            return Promise.resolve({ success: true });
          },
        })
      );

      const context = createMockContext();
      const result = await manager.teardownAll(context);

      // Reverse order: third, second (fails), first still runs
      expect(result.success).toBe(false);
      expect(result.error).toBe('teardown failed');
      expect(order).toEqual(['third', 'second', 'first']);
    });

    it('collects multiple teardown errors', async () => {
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'first',
          phase: 'pre-cdk',
          teardown: () => Promise.resolve({ success: false, error: 'first broke' }),
        })
      );
      manager.register(
        createMockDeployer({
          name: 'second',
          phase: 'post-cdk',
          teardown: () => Promise.resolve({ success: false, error: 'second broke' }),
        })
      );

      const context = createMockContext();
      const result = await manager.teardownAll(context);

      expect(result.success).toBe(false);
      expect(result.error).toBe('second broke; first broke');
    });

    it('skips deployers where shouldRun returns false', async () => {
      const manager = new ImperativeDeploymentManager();
      const torn: string[] = [];

      manager.register(
        createMockDeployer({
          name: 'active',
          phase: 'pre-cdk',
          teardown: () => {
            torn.push('active');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'inactive',
          phase: 'post-cdk',
          shouldRun: () => false,
          teardown: () => {
            torn.push('inactive');
            return Promise.resolve({ success: true });
          },
        })
      );

      const context = createMockContext();
      const result = await manager.teardownAll(context);

      expect(result.success).toBe(true);
      expect(torn).toEqual(['active']);
    });

    it('calls progress callbacks correctly during teardown', async () => {
      const manager = new ImperativeDeploymentManager();
      const onProgress = vi.fn<DeployProgress>();

      manager.register(
        createMockDeployer({
          name: 'td',
          label: 'Teardown Step',
          phase: 'pre-cdk',
          teardown: () => Promise.resolve({ success: true }),
        })
      );

      const context = createMockContext({ onProgress });
      await manager.teardownAll(context);

      expect(onProgress).toHaveBeenCalledWith('Teardown Step', 'start');
      expect(onProgress).toHaveBeenCalledWith('Teardown Step', 'done');
    });

    it('handles thrown errors during teardown and continues', async () => {
      const order: string[] = [];
      const manager = new ImperativeDeploymentManager();

      manager.register(
        createMockDeployer({
          name: 'ok',
          phase: 'pre-cdk',
          teardown: () => {
            order.push('ok');
            return Promise.resolve({ success: true });
          },
        })
      );
      manager.register(
        createMockDeployer({
          name: 'thrower',
          phase: 'post-cdk',
          teardown: () => Promise.reject(new Error('teardown crash')),
        })
      );

      const context = createMockContext();
      const result = await manager.teardownAll(context);

      expect(result.success).toBe(false);
      expect(result.error).toBe('teardown crash');
      expect(order).toEqual(['ok']);
    });
  });

  describe('hasDeployersForPhase', () => {
    it('returns true when a deployer matches phase and shouldRun', () => {
      const manager = new ImperativeDeploymentManager();
      manager.register(createMockDeployer({ name: 'a', phase: 'pre-cdk' }));

      const context = createMockContext();
      expect(manager.hasDeployersForPhase('pre-cdk', context)).toBe(true);
    });

    it('returns false when no deployers match the phase', () => {
      const manager = new ImperativeDeploymentManager();
      manager.register(createMockDeployer({ name: 'a', phase: 'post-cdk' }));

      const context = createMockContext();
      expect(manager.hasDeployersForPhase('pre-cdk', context)).toBe(false);
    });

    it('returns false when deployer matches phase but shouldRun returns false', () => {
      const manager = new ImperativeDeploymentManager();
      manager.register(
        createMockDeployer({
          name: 'a',
          phase: 'pre-cdk',
          shouldRun: () => false,
        })
      );

      const context = createMockContext();
      expect(manager.hasDeployersForPhase('pre-cdk', context)).toBe(false);
    });

    it('returns false when no deployers are registered', () => {
      const manager = new ImperativeDeploymentManager();
      const context = createMockContext();
      expect(manager.hasDeployersForPhase('standalone', context)).toBe(false);
    });

    it('returns true when at least one deployer matches among many', () => {
      const manager = new ImperativeDeploymentManager();
      manager.register(createMockDeployer({ name: 'a', phase: 'pre-cdk', shouldRun: () => false }));
      manager.register(createMockDeployer({ name: 'b', phase: 'post-cdk' }));
      manager.register(createMockDeployer({ name: 'c', phase: 'pre-cdk', shouldRun: () => true }));

      const context = createMockContext();
      expect(manager.hasDeployersForPhase('pre-cdk', context)).toBe(true);
    });
  });
});
