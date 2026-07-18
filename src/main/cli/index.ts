/**
 * CLI entry point for headless Electron invocation.
 * Called from src/main/index.ts when `--cli` is present in argv.
 * Wires real service dependencies to pure command functions in commands.ts.
 *
 * REQUIRES on-device verification: native audio capture and permissions
 * depend on macOS APIs that are unavailable in CI.
 */

import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { appRepositories } from '../services/repositories';
import { settingsStore } from '../services/settings';
import { checkPermissions } from '../services/permissions';
import { NativeAudioCaptureService } from '../audio/native-audio-capture';
import { loadNativeAudioCaptureModule } from '../audio/native-module-loader';
import { resolveImportSTTProvider } from '../services/import-stt-provider-resolver';
import { AudioSttJobRunner } from '../services/audio-stt-job-runner';
import { tryGenerateLlmMinutesContent } from '../services/minutes-llm';
import { evaluateCompliance } from '../services/compliance';
import { logger } from '../logger';
import {
  parseCliArgs,
  cmdRecordStart,
  cmdRecordStop,
  cmdTranscribe,
  cmdMinutes,
  CLI_HELP,
} from './commands';
import type { RecordDeps, TranscribeDeps, MinutesDeps } from './commands';
import type {
  MeetingMinute,
  ReviewTask,
  Transcript,
} from '@shared/types';

// ---------------------------------------------------------------------------
// Module-level state (mirrors ipc/index.ts call state for CLI sessions)
// ---------------------------------------------------------------------------
let cliActiveCallId: string | null = null;
let cliNativeCapture: NativeAudioCaptureService | null = null;

// ---------------------------------------------------------------------------
// Helpers that mirror generateMeetingMinuteForCall in ipc/index.ts
// ---------------------------------------------------------------------------

async function generateMeetingMinuteForCli(input: {
  callId: string;
  productId: MeetingMinute['productId'];
  source: MeetingMinute['source'];
  transcripts: Transcript[];
}): Promise<MeetingMinute> {
  const finalTexts = input.transcripts
    .filter((t) => t.isFinal)
    .map((t) => t.text.trim())
    .filter((t) => t.length > 0);

  const summarySource = finalTexts[0] ?? '商談 transcript はまだありません。';
  const pending = finalTexts.filter((text) =>
    ['高い', '難しい', '検討', '確認', '次回'].some((keyword) => text.includes(keyword)),
  );

  const call = (await appRepositories.calls.listCalls()).find((c) => c.id === input.callId);
  const rules = await appRepositories.complianceRules.listRules(
    'insurance',
    call ? { tenantId: call.tenantId, organizationId: call.organizationId } : undefined,
    call?.productId,
  );

  const llmContent = await tryGenerateLlmMinutesContent(input.productId, input.transcripts);

  const numbers = extractNumbersCli(finalTexts.join('\n'));
  const complianceFindings = evaluateCompliance({
    meetingId: input.callId,
    transcripts: input.transcripts,
    rules,
  });

  const meetingMinute: MeetingMinute = {
    id: randomUUID(),
    callId: input.callId,
    transcriptRevisionId: null,
    source: input.source,
    productId: input.productId,
    summary: llmContent?.summary ?? `直近の発話: ${summarySource}`,
    agreed: llmContent?.agreed ?? [],
    pending: llmContent?.pending ?? pending.slice(0, 5),
    decisions: llmContent?.decisions ?? [],
    numbers,
    complianceFindings,
    generatedAt: new Date().toISOString(),
  };

  // Persist review tasks
  const reviewTasks = complianceFindings.map(
    (finding): ReviewTask => ({
      id: randomUUID(),
      callId: input.callId,
      transcriptRevisionId: null,
      meetingMinuteId: meetingMinute.id,
      findingId: finding.id,
      severity: finding.severity,
      status: 'open',
      title: `コンプライアンス確認: ${finding.severity}`,
      quotedText: finding.quotedText,
      reason: finding.reason,
      recommendedAction: finding.recommendedAction,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  await appRepositories.reviews.createReviewTasks(reviewTasks);

  return meetingMinute;
}

function extractNumbersCli(text: string): MeetingMinute['numbers'] {
  const matches = text.match(/\d[\d,]*(?:円|万円|%|％|ヶ月|か月|月|日)?/g) ?? [];
  return [...new Set(matches)].slice(0, 10).map((value, index) => ({
    label: `number_${index + 1}`,
    value,
  }));
}

// ---------------------------------------------------------------------------
// Build dependency implementations from real services
// ---------------------------------------------------------------------------

function buildRecordDeps(): RecordDeps {
  return {
    checkPermissions,
    async startNativeCapture() {
      // REQUIRES on-device verification: loadNativeAudioCaptureModule uses macOS dylib
      const nativeModule = loadNativeAudioCaptureModule();
      if (!nativeModule) {
        throw new Error('Native audio capture module not available');
      }
      cliNativeCapture = new NativeAudioCaptureService({
        module: nativeModule,
        sendAudioChunk: async () => {
          /* CLI record mode: audio is captured and stored natively; no STT streaming */
        },
        onError: (error) => {
          logger.warn({ error }, 'cli native capture error');
        },
      });
      await cliNativeCapture.start();
    },
    async stopNativeCapture() {
      await cliNativeCapture?.stop();
      cliNativeCapture = null;
    },
    async createCall({ productId, consent }) {
      const scope = await appRepositories.organizations.getDefaultScope();
      const call = await appRepositories.calls.createCall({
        ...scope,
        source: 'zoom_desktop',
        industry: 'btob_sales',
        productId,
        recordingConsent: consent,
        startedAt: new Date(),
      });
      cliActiveCallId = call.id;
      return { id: call.id };
    },
    async endCall(callId) {
      await appRepositories.calls.endCall(callId);
      cliActiveCallId = null;
    },
    getActiveCallId: () => cliActiveCallId,
  };
}

function buildTranscribeDeps(): TranscribeDeps {
  return {
    async importAudioFile({ callId, filePath }) {
      return appRepositories.audioAssets.importAudioFile({ callId, filePath });
    },
    async createCall({ productId, consent }) {
      const scope = await appRepositories.organizations.getDefaultScope();
      const call = await appRepositories.calls.createCall({
        ...scope,
        source: 'uploaded_audio',
        industry: 'btob_sales',
        productId,
        recordingConsent: consent,
        startedAt: new Date(),
      });
      return { id: call.id };
    },
    async endCall(callId) {
      await appRepositories.calls.endCall(callId);
    },
    async createSttJob(audioAssetId, callId, _productId) {
      const settings = await settingsStore.get();
      const importMode = settings.sttImportProviderMode ?? 'local_first';
      const resolved = resolveImportSTTProvider({ mode: importMode });
      return appRepositories.sttJobs.createJob({
        callId,
        audioAssetId,
        provider: resolved.kind,
      });
    },
    async runSttJob(jobId) {
      const settings = await settingsStore.get();
      const importMode = settings.sttImportProviderMode ?? 'local_first';
      const runner = new AudioSttJobRunner({
        repositories: appRepositories,
        importProviderMode: importMode,
      });
      return runner.run(jobId);
    },
    async listTranscripts(callId) {
      return appRepositories.transcripts.listTranscripts(callId);
    },
  };
}

function buildMinutesDeps(): MinutesDeps {
  return {
    async listCalls() {
      return appRepositories.calls.listCalls();
    },
    async listTranscripts(callId) {
      return appRepositories.transcripts.listTranscripts(callId);
    },
    async generateMinutes(input) {
      return generateMeetingMinuteForCli(input);
    },
    async setLatestMinute(minute) {
      return appRepositories.minutes.setLatestMeetingMinute(minute);
    },
    getActiveCallId: () => cliActiveCallId,
  };
}

// ---------------------------------------------------------------------------
// Main CLI runner — called from src/main/index.ts
// ---------------------------------------------------------------------------

/**
 * Run the CLI, print JSON to stdout, then call app.exit(code).
 * @param argv - full process.argv (will be sliced after --cli marker)
 */
export async function runCli(argv: string[]): Promise<void> {
  // Extract args after optional electron / node preamble, starting from the subcommand.
  // The caller already stripped the binary path; we look for --cli and take what follows.
  const cliMarkerIdx = argv.indexOf('--cli');
  const cliArgs = cliMarkerIdx !== -1 ? argv.slice(cliMarkerIdx + 1) : argv;

  const parsed = parseCliArgs(cliArgs);

  if (!parsed.ok) {
    process.stdout.write(JSON.stringify(parsed) + '\n');
    app.exit(1);
    return;
  }

  if (parsed.subcommand === 'help') {
    process.stdout.write(CLI_HELP + '\n');
    app.exit(0);
    return;
  }

  try {
    if (parsed.subcommand === 'record') {
      if (parsed.subAction === 'start') {
        const result = await cmdRecordStart(
          { productId: parsed.product },
          buildRecordDeps(),
        );
        process.stdout.write(JSON.stringify(result) + '\n');
        app.exit(result.ok ? 0 : 1);
      } else {
        const result = await cmdRecordStop(buildRecordDeps());
        process.stdout.write(JSON.stringify(result) + '\n');
        app.exit(result.ok ? 0 : 1);
      }
      return;
    }

    if (parsed.subcommand === 'transcribe') {
      const result = await cmdTranscribe(
        { filePath: parsed.file, productId: parsed.product },
        buildTranscribeDeps(),
      );
      process.stdout.write(JSON.stringify(result) + '\n');
      app.exit(result.ok ? 0 : 1);
      return;
    }

    if (parsed.subcommand === 'minutes') {
      const result = await cmdMinutes(
        { callId: parsed.callId, productId: parsed.product },
        buildMinutesDeps(),
      );
      process.stdout.write(JSON.stringify(result) + '\n');
      app.exit(result.ok ? 0 : 1);
      return;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ ok: false, error: 'unexpected_error', detail }) + '\n');
    app.exit(1);
  }
}
