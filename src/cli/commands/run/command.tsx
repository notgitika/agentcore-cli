import { ConfigIO, ValidationError, findConfigRoot, serializeResult } from '../../../lib';
import type { RecommendationType } from '../../aws/agentcore-recommendation';
import { COMMAND_DESCRIPTIONS } from '../../constants';
import { getErrorMessage } from '../../errors';
import { handleRunEval } from '../../operations/eval';
import type { RunEvalOptions } from '../../operations/eval';
import { createJobEngine, runDatasetPhase1, waitForTerminal } from '../../operations/jobs';
import type {
  BatchEvaluationJobRecord,
  RecommendationJobRecord,
  StartBatchEvaluationJobOptions,
} from '../../operations/jobs';
import { runKbIngestionByName } from '../../operations/ingest';
import { runCliCommand } from '../../telemetry/cli-command-run';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

const RECOMMENDATION_TYPE_MAP: Record<string, RecommendationType> = {
  'system-prompt': 'SYSTEM_PROMPT_RECOMMENDATION',
  'tool-description': 'TOOL_DESCRIPTION_RECOMMENDATION',
};

function formatRunOutput(result: Awaited<ReturnType<typeof handleRunEval>>): void {
  if (!result.success) return;

  const { run } = result;
  const date = new Date(run.timestamp).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const lookbackStr = run.source === 'dataset' ? '' : ` | Lookback: ${run.lookbackDays}d`;
  const datasetStr =
    run.source === 'dataset' && run.dataset ? ` | Dataset: ${run.dataset.id}@${run.dataset.version}` : '';
  console.log(`\nAgent: ${run.agent} | ${date} | Sessions: ${run.sessionCount}${lookbackStr}${datasetStr}`);

  if (run.referenceInputs) {
    const parts: string[] = [];
    if (run.referenceInputs.assertions?.length) {
      parts.push(`${run.referenceInputs.assertions.length} assertion(s)`);
    }
    if (run.referenceInputs.expectedResponse) {
      parts.push('expected response');
    }
    if (run.referenceInputs.expectedTrajectory?.length) {
      parts.push(`${run.referenceInputs.expectedTrajectory.length} trajectory step(s)`);
    }
    if (parts.length > 0) {
      console.log(`Reference inputs: ${parts.join(', ')}`);
    }
  }
  console.log('');

  for (const r of run.results) {
    const score = r.aggregateScore.toFixed(2);
    const errors = r.sessionScores.filter((s: { errorMessage?: string }) => s.errorMessage).length;
    const errorSuffix = errors > 0 ? ` (${errors} errors)` : '';
    console.log(`  ${r.evaluator}: ${score}${errorSuffix}`);
  }

  if (result.filePath) {
    console.log(`\nResults saved to: ${result.filePath}`);
  }
}

export const registerRun = (program: Command) => {
  const runCmd = program.command('run').description(COMMAND_DESCRIPTIONS.run);

  runCmd
    .command('eval')
    .description(
      'Run on-demand evaluation of runtime traces. Use --runtime-arn to evaluate runtimes outside the project.'
    )
    .option('-r, --runtime <name>', 'Runtime name from project config')
    .option('--runtime-arn <arn>', 'Runtime ARN — run outside a project directory')
    .option('-e, --evaluator <names...>', 'Evaluator name(s) — project evaluators or Builtin.* IDs')
    .option('--evaluator-arn <arns...>', 'Evaluator ARN(s) — use with --runtime-arn for standalone mode')
    .option('--region <region>', 'AWS region (required with --runtime-arn, auto-detected otherwise)')
    .option('-s, --session-id <id>', 'Evaluate a specific session only')
    .option('-t, --trace-id <id>', 'Evaluate a specific trace only')
    .option(
      '--endpoint <name>',
      'Runtime endpoint name (e.g. PROMPT_V1). Defaults to AGENTCORE_RUNTIME_ENDPOINT env var, then DEFAULT'
    )
    .option('--days <days>', 'Lookback window in days', '7')
    .option('-A, --assertion <text...>', 'Ground truth assertion the agent response must satisfy (repeatable)')
    .option('--expected-trajectory <names>', 'Ground truth: expected tool call names in order (comma-separated)')
    .option('--expected-response <text>', 'Ground truth: expected agent response text to compare against')
    .option('--output <path>', 'Custom output file path for results')
    .option('--dataset <name>', 'Dataset name — invoke agent with dataset scenarios instead of historical traces')
    .option('--dataset-version <version>', 'Dataset version to use (omit for local file, or N/DRAFT)')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        runtime?: string;
        runtimeArn?: string;
        evaluator?: string[];
        evaluatorArn?: string[];
        region?: string;
        sessionId?: string;
        traceId?: string;
        endpoint?: string;
        assertion?: string[];
        expectedTrajectory?: string;
        expectedResponse?: string;
        days: string;
        output?: string;
        dataset?: string;
        datasetVersion?: string;
        json?: boolean;
      }) => {
        const isArnMode = !!(cliOptions.runtimeArn && cliOptions.evaluatorArn);
        if (!isArnMode) {
          requireProject();
        }

        if (!cliOptions.evaluator && !cliOptions.evaluatorArn) {
          const error = 'At least one --evaluator or --evaluator-arn is required';
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        const options: RunEvalOptions = {
          agent: cliOptions.runtime,
          agentArn: cliOptions.runtimeArn,
          evaluator: cliOptions.evaluator ?? [],
          evaluatorArn: cliOptions.evaluatorArn,
          region: cliOptions.region,
          sessionId: cliOptions.sessionId,
          traceId: cliOptions.traceId,
          endpoint: cliOptions.endpoint,
          assertions: cliOptions.assertion,
          expectedTrajectory: cliOptions.expectedTrajectory
            ? cliOptions.expectedTrajectory.split(',').map(s => s.trim())
            : undefined,
          expectedResponse: cliOptions.expectedResponse,
          days: parseInt(cliOptions.days, 10),
          output: cliOptions.output,
          dataset: cliOptions.dataset,
          datasetVersion: cliOptions.datasetVersion,
          json: cliOptions.json,
        };

        try {
          const result = await handleRunEval(options);

          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult(result)));
          } else if (result.success) {
            formatRunOutput(result);
          } else {
            formatRunOutput(result);
            render(<Text color="red">{result.error.message}</Text>);
          }

          process.exit(result.success ? 0 : 1);
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
          }
          process.exit(1);
        }
      }
    );

  runCmd
    .command('batch-evaluation')
    .description('[preview] Run evaluators in batch across all agent sessions in CloudWatch')
    .requiredOption('-r, --runtime <name>', 'Runtime name from project config')
    .requiredOption('-e, --evaluator <ids...>', 'Evaluator name(s) — Builtin.* IDs')
    .option('-n, --name <name>', 'Name for the batch evaluation (auto-generated if omitted)')
    .option('-d, --lookback-days <days>', 'Lookback window in days (filters sessions by time range)')
    .option('-s, --session-ids <ids...>', 'Specific session IDs to evaluate')
    .option(
      '-g, --ground-truth <path>',
      'JSON file with session metadata and ground truth (assertions, expected trajectory, turns)'
    )
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option(
      '--endpoint <name>',
      'Runtime endpoint name (e.g. PROMPT_V1). Defaults to AGENTCORE_RUNTIME_ENDPOINT env var, then DEFAULT'
    )
    .option('--dataset <name>', 'Dataset name — invoke agent with dataset scenarios before batch evaluation')
    .option('--dataset-version <version>', 'Dataset version to use (omit for local file, or N/DRAFT)')
    .option('--kms-key <arn>', 'KMS key ARN for encrypting batch evaluation results')
    .option('--wait', 'Block until the batch evaluation reaches a terminal state')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        runtime: string;
        evaluator: string[];
        name?: string;
        lookbackDays?: string;
        sessionIds?: string[];
        groundTruth?: string;
        region?: string;
        endpoint?: string;
        dataset?: string;
        datasetVersion?: string;
        kmsKey?: string;
        wait?: boolean;
        json?: boolean;
      }) => {
        requireProject();

        const log = (message: string) => {
          if (!cliOptions.json) console.log(message);
        };

        await runCliCommand('run.job', !!cliOptions.json, async () => {
          const engine = createJobEngine(new ConfigIO());

          // Ground truth file (explicit sessionMetadata)
          let sessionMetadata: StartBatchEvaluationJobOptions['sessionMetadata'];
          if (cliOptions.groundTruth) {
            const { readFileSync } = await import('node:fs');
            const gtData = JSON.parse(readFileSync(cliOptions.groundTruth, 'utf-8')) as Record<string, unknown>;
            const parsed = Array.isArray(gtData) ? gtData : gtData.sessionMetadata;
            if (!Array.isArray(parsed)) {
              throw new Error(
                'Ground truth file must be a JSON array of session metadata entries, or an object with a "sessionMetadata" key'
              );
            }
            sessionMetadata = parsed as StartBatchEvaluationJobOptions['sessionMetadata'];
          }

          const lookbackDays = cliOptions.lookbackDays ? parseInt(cliOptions.lookbackDays, 10) : undefined;
          let sessionIds = cliOptions.sessionIds;
          const datasetInfo = cliOptions.dataset
            ? { id: cliOptions.dataset, version: cliOptions.datasetVersion ?? 'LOCAL' }
            : undefined;

          // Dataset mode (Phase-1): invoke scenarios + wait for ingestion, then start (caller-side, blocking).
          if (cliOptions.dataset) {
            const phase1 = await runDatasetPhase1({
              agent: cliOptions.runtime,
              datasetName: cliOptions.dataset,
              datasetVersion: cliOptions.datasetVersion,
              endpoint: cliOptions.endpoint,
              onProgress: (_phase, message) => log(message),
            });
            if (!phase1.success) {
              throw phase1.error;
            }
            sessionIds = [...(sessionIds ?? []), ...phase1.sessionIds];
            sessionMetadata = [...(sessionMetadata ?? []), ...phase1.sessionMetadata];
          }

          const startResult = await engine.start('batch-evaluation', {
            agent: cliOptions.runtime,
            evaluators: cliOptions.evaluator,
            name: cliOptions.name,
            region: cliOptions.region,
            endpoint: cliOptions.endpoint,
            sessionIds,
            lookbackDays: lookbackDays && !isNaN(lookbackDays) ? lookbackDays : undefined,
            sessionMetadata,
            source: cliOptions.dataset ? 'dataset' : 'traces',
            dataset: datasetInfo,
            kmsKeyArn: cliOptions.kmsKey,
            onProgress: cliOptions.json ? undefined : (_status, message) => console.log(message),
          });
          if (!startResult.success) {
            throw startResult.error;
          }
          let record: BatchEvaluationJobRecord = startResult.record;

          if (cliOptions.wait) {
            const final = await waitForTerminal(engine, 'batch-evaluation', record.id, {
              onTick: status => log(`Status: ${status}`),
            });
            if (final) record = final;
          }

          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult({ success: true, ...record })));
          } else {
            console.log(`\n✓ Batch evaluation started: ${record.id} (${record.status})`);
            printBatchEvalResult(record);
            if (!cliOptions.wait) {
              console.log(`\nNext: agentcore batch-evaluations ${record.id}`);
            }
            console.log('');
          }
          return { job_type: 'batch-evaluation', has_wait: !!cliOptions.wait };
        });
      }
    );

  runCmd
    .command('recommendation')
    .description('[preview] Optimize a system prompt or tool descriptions using agent traces as signal')
    .option('-t, --type <type>', 'What to optimize: system-prompt or tool-description (default: system-prompt)')
    .option('-r, --runtime <name>', 'Runtime name from project config')
    .option('-e, --evaluator <name>', 'Evaluator name — required for system-prompt (exactly one)')
    .option('--prompt-file <path>', 'Load the current system prompt from a file')
    .option('--inline <content>', 'Provide the current system prompt or tool descriptions inline')
    .option('--bundle-name <name>', 'Read current content from a deployed config bundle')
    .option('--bundle-version <version>', 'Config bundle version (used with --bundle-name)')
    .option(
      '--system-prompt-json-path <path>',
      'Field name under "configuration" in the bundle (e.g. "systemPrompt"). The CLI resolves it to the full path automatically. Do not use bracket notation — use dot notation only.'
    )
    .option(
      '--tool-desc-json-path <pair...>',
      'Tool name:field pairs for tool descriptions in a config bundle (e.g. --tool-desc-json-path "search:searchDesc"). The CLI resolves each to the full path automatically.'
    )
    .option(
      '--tools <pair...>',
      'Tool name:description pairs (repeatable, e.g. --tools "search:Searches the web" --tools "calc:Does math")'
    )
    .option('--spans-file <path>', 'JSON file with OTEL session spans (use instead of CloudWatch traces)')
    .option('--lookback <days>', 'How far back to search for traces in CloudWatch (days)', '7')
    .option('-s, --session-id <ids...>', 'Limit trace collection to specific session IDs')
    .option('-n, --run <name>', 'Run name prefix for the recommendation')
    .option('--region <region>', 'AWS region')
    .option('--kms-key <arn>', 'KMS key ARN for encrypting recommendation results')
    .option('--wait', 'Block until the recommendation reaches a terminal state')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        type?: string;
        runtime?: string;
        evaluator?: string;
        promptFile?: string;
        inline?: string;
        bundleName?: string;
        bundleVersion?: string;
        systemPromptJsonPath?: string;
        toolDescJsonPath?: string[];
        tools?: string[];
        spansFile?: string;
        lookback: string;
        sessionId?: string[];
        run?: string;
        region?: string;
        kmsKey?: string;
        wait?: boolean;
        json?: boolean;
      }) => {
        requireProject();

        const typeKey = cliOptions.type ?? 'system-prompt';
        const recType = RECOMMENDATION_TYPE_MAP[typeKey];
        if (!recType) {
          const error = `Invalid --type "${typeKey}". Must be one of: ${Object.keys(RECOMMENDATION_TYPE_MAP).join(', ')}`;
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        const agent = cliOptions.runtime;
        const evaluator = cliOptions.evaluator;

        if (!agent) {
          const error = '--runtime is required';
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        // Evaluator is required for system-prompt recs, optional for tool-description
        if (recType === 'SYSTEM_PROMPT_RECOMMENDATION' && !evaluator) {
          const error = '--evaluator is required for system-prompt recommendations';
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        const inputSource = cliOptions.promptFile
          ? ('file' as const)
          : cliOptions.inline
            ? ('inline' as const)
            : cliOptions.bundleName
              ? ('config-bundle' as const)
              : ('inline' as const);

        const traceSource = cliOptions.spansFile
          ? ('spans-file' as const)
          : cliOptions.sessionId
            ? ('sessions' as const)
            : ('cloudwatch' as const);

        // Parse --tool-desc-json-path pairs ("toolName:$.json.path") into structured format
        const toolDescJsonPaths = cliOptions.toolDescJsonPath
          ?.map(pair => {
            const colonIdx = pair.indexOf(':');
            if (colonIdx <= 0) return undefined;
            return {
              toolName: pair.slice(0, colonIdx),
              toolDescriptionJsonPath: pair.slice(colonIdx + 1),
            };
          })
          .filter((p): p is { toolName: string; toolDescriptionJsonPath: string } => p !== undefined);

        await runCliCommand('run.job', !!cliOptions.json, async () => {
          const engine = createJobEngine(new ConfigIO());
          const startResult = await engine.start('recommendation', {
            type: recType,
            agent,
            evaluators: evaluator ? [evaluator] : [],
            promptFile: cliOptions.promptFile,
            inlineContent: cliOptions.inline,
            bundleName: cliOptions.bundleName,
            bundleVersion: cliOptions.bundleVersion,
            systemPromptJsonPath: cliOptions.systemPromptJsonPath,
            toolDescJsonPaths: toolDescJsonPaths?.length ? toolDescJsonPaths : undefined,
            tools: cliOptions.tools,
            lookbackDays: parseInt(cliOptions.lookback, 10),
            sessionIds: cliOptions.sessionId,
            spansFile: cliOptions.spansFile,
            recommendationName: cliOptions.run,
            region: cliOptions.region,
            kmsKeyArn: cliOptions.kmsKey,
            inputSource,
            traceSource,
            onProgress: cliOptions.json ? undefined : (_status, message) => console.log(message),
          });

          if (!startResult.success) {
            throw startResult.error;
          }
          let record: RecommendationJobRecord = startResult.record;

          if (cliOptions.wait) {
            const final = await waitForTerminal(engine, 'recommendation', record.id, {
              onTick: status => {
                if (!cliOptions.json) console.log(`Status: ${status}`);
              },
            });
            if (final) record = final;
          }

          if (cliOptions.json) {
            console.log(JSON.stringify(serializeResult({ success: true, ...record })));
          } else {
            console.log(`\n✓ Recommendation started: ${record.id} (${record.status})`);
            printRecommendationResult(record);
            if (!cliOptions.wait) {
              console.log(
                `\nNext: agentcore recommendations ${record.id}` +
                  (inputSource === 'config-bundle'
                    ? ' — the new config bundle will be applied to agentcore.json automatically.'
                    : '')
              );
            }
            console.log('');
          }
          return { job_type: 'recommendation', has_wait: !!cliOptions.wait };
        });
      }
    );

  // ──────────────────────────────────────────────────────────────────────
  // run ingest — manually trigger ingestion for a deployed knowledge base.
  //
  // Drift correction #4 from Plan C: 2-deep nesting (`run ingest`), not
  // `run ingest knowledge-base`. KBs are the only ingestible resource for
  // now; future ingestible types could add a --type flag.
  // ──────────────────────────────────────────────────────────────────────
  runCmd
    .command('ingest')
    .description('Start a fresh ingestion job for every data source on a deployed knowledge base.')
    .option('--name <name>', 'Knowledge base name (must exist in agentcore.json)')
    .option('--target <target>', 'Deployment target name (defaults to "default")', 'default')
    .option('--data-source <uri>', 'Ingest only the data source with this URI (default: all sources)')
    .option('--json', 'Output as JSON [non-interactive]')
    .action(async (cliOptions: { name?: string; target?: string; dataSource?: string; json?: boolean }) => {
      if (!findConfigRoot()) {
        console.error('No agentcore project found. Run `agentcore create` first.');
        process.exit(1);
      }
      await runCliCommand('run.ingest', !!cliOptions.json, async () => {
        if (!cliOptions.name) {
          throw new ValidationError('A --name is required for `agentcore run ingest`.');
        }
        const targetName = cliOptions.target ?? 'default';

        const configIO = new ConfigIO();
        const [project, awsTargets, deployedState] = await Promise.all([
          configIO.readProjectSpec(),
          configIO.readAWSDeploymentTargets(),
          configIO.readDeployedState().catch(() => ({ targets: {} })),
        ]);

        const kbExists = (project.knowledgeBases ?? []).some(kb => kb.name === cliOptions.name);
        if (!kbExists) {
          throw new ValidationError(`Knowledge base '${cliOptions.name}' is not in agentcore.json.`);
        }
        const target = awsTargets.find(t => t.name === targetName);
        if (!target) {
          throw new ValidationError(`Deployment target '${targetName}' is not in aws-targets.json.`);
        }

        // Wire Ctrl+C → AbortController so the user can bail out of long
        // retry sleeps cleanly. Progress lines go to stderr so --json stdout
        // remains a single parseable object.
        const abortController = new AbortController();
        const onSigint = () => abortController.abort();
        process.once('SIGINT', onSigint);
        let result;
        try {
          result = await runKbIngestionByName({
            knowledgeBaseName: cliOptions.name,
            deployedState,
            targetName,
            region: target.region,
            dataSourceUri: cliOptions.dataSource,
            signal: abortController.signal,
            onProgress: cliOptions.json ? undefined : msg => process.stderr.write(`${msg}\n`),
          });
        } finally {
          process.off('SIGINT', onSigint);
        }

        if (!result.success) {
          throw result.error;
        }

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, startedJobs: result.startedJobs }));
        } else {
          console.log(`Started ingestion for '${cliOptions.name}' (${result.startedJobs.length} data source(s)):`);
          for (const job of result.startedJobs) {
            console.log(`  ${job.uri}  →  ${job.ingestionJobId}`);
          }
          console.log(`\nRun 'agentcore status' to track progress.`);
        }

        return { data_source_count: result.startedJobs.length };
      });
    });
};

/** Print a recommendation's optimized artifact (system prompt / tool descriptions) when available. */
function printRecommendationResult(record: RecommendationJobRecord): void {
  const sys = record.result?.systemPromptRecommendationResult;
  const tool = record.result?.toolDescriptionRecommendationResult;
  if (sys?.recommendedSystemPrompt) {
    if (sys.explanation) {
      console.log('\n--- Explanation ---');
      console.log(sys.explanation);
    }
    console.log('\n+++ Recommended System Prompt +++');
    console.log(sys.recommendedSystemPrompt);
  } else if (tool?.tools?.length) {
    for (const t of tool.tools) {
      console.log(`\nTool: ${t.toolName}`);
      if (t.explanation) {
        console.log(`Explanation: ${t.explanation}`);
      }
      console.log(`Recommended: ${t.recommendedToolDescription}`);
    }
  } else if (record.status === 'FAILED') {
    console.log(`\nError: ${record.failureDetail ?? record.statusReasons?.join('; ') ?? 'unknown'}`);
  }
  if (record.syncedVersionId) {
    console.log(`\nNew config bundle version ${record.syncedVersionId} applied to agentcore.json.`);
  }
}

/** Print a batch evaluation's scores (server summaries preferred, CloudWatch per-session as fallback). */
function printBatchEvalResult(record: BatchEvaluationJobRecord): void {
  const evalResults = record.evaluationResults;
  if (evalResults) {
    const parts: string[] = [];
    if (evalResults.totalNumberOfSessions != null) parts.push(`${evalResults.totalNumberOfSessions} sessions`);
    if (evalResults.numberOfSessionsCompleted != null) parts.push(`${evalResults.numberOfSessionsCompleted} completed`);
    if (evalResults.numberOfSessionsFailed) parts.push(`${evalResults.numberOfSessionsFailed} failed`);
    if (parts.length > 0) console.log(`Sessions: ${parts.join(', ')}`);
  }

  const summaries = evalResults?.evaluatorSummaries;
  if (summaries && summaries.length > 0) {
    console.log('\nResults:');
    for (const s of summaries) {
      const avg = s.statistics?.averageScore;
      const avgStr = avg != null ? avg.toFixed(2) : 'N/A';
      const failSuffix = s.totalFailed ? ` (${s.totalFailed} failed)` : '';
      const evalCount = s.totalEvaluated != null ? ` [${s.totalEvaluated} evaluated]` : '';
      console.log(`  ${s.evaluatorId}: ${avgStr} avg${failSuffix}${evalCount}`);
    }
  } else if (record.results?.length) {
    console.log('\nResults:');
    const byEvaluator = new Map<string, NonNullable<BatchEvaluationJobRecord['results']>>();
    for (const r of record.results) {
      const group = byEvaluator.get(r.evaluatorId) ?? [];
      group.push(r);
      byEvaluator.set(r.evaluatorId, group);
    }
    for (const [evalId, evalGroup] of byEvaluator) {
      const scores = evalGroup.filter(r => !r.error && r.score != null).map(r => r.score!);
      const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      const errors = evalGroup.filter(r => r.error).length;
      console.log(`  ${evalId}: ${avg.toFixed(2)} avg${errors > 0 ? ` (${errors} errors)` : ''}`);
    }
  }
}
