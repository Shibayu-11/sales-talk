import { useEffect, useRef, useState } from 'react';
import type {
  AudioAsset,
  AudioSttJob,
  AudioSttProvider,
  CallSession,
  CloudAudioUploadProcessResult,
  MeetingMinute,
  ProductId,
  Transcript,
  TranscriptRevision,
  TranscriptSegment,
} from '@shared/types';
import { parseLeadingTimestamp } from '@shared/time';
import {
  callDurationLabel,
  callTitle,
  createUploadConsent,
  findSegmentIndexByQuote,
  findSegmentIndexForTimestamp,
  formatBytes,
  groupCallsByRecency,
} from '../lib/call-view';
import { TranscriptBubbles } from './TranscriptBubbles';

/**
 * 商談ライブラリ。三分割(リスト / transcript / Summary)。
 * 議事録の [mm:ss] とコンプラ findings から該当発話へジャンプできる。
 */
export function CallLibrary(props: {
  productId: ProductId;
  recentTranscripts: Transcript[];
}): JSX.Element {
  const [savedCalls, setSavedCalls] = useState<CallSession[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const selectedCallIdRef = useRef<string | null>(null);
  const [savedTranscripts, setSavedTranscripts] = useState<TranscriptSegment[]>([]);
  const [transcriptRevisions, setTranscriptRevisions] = useState<TranscriptRevision[]>([]);
  const [audioAssets, setAudioAssets] = useState<AudioAsset[]>([]);
  const [sttJobs, setSttJobs] = useState<AudioSttJob[]>([]);
  const [retryReasons, setRetryReasons] = useState<Record<string, string>>({});
  const [retryProviders, setRetryProviders] = useState<Record<string, AudioSttProvider>>({});
  const [meetingMinute, setMeetingMinute] = useState<MeetingMinute | null>(null);
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<string | null>(null);
  const [generatingMinutes, setGeneratingMinutes] = useState(false);
  const [processingAudio, setProcessingAudio] = useState(false);
  const [cloudUploading, setCloudUploading] = useState(false);
  const [cloudUploadResult, setCloudUploadResult] =
    useState<CloudAudioUploadProcessResult | null>(null);
  const [uploadConsentGranted, setUploadConsentGranted] = useState(false);
  selectedCallIdRef.current = selectedCallId;

  useEffect(() => {
    void window.api.call.list().then((calls) => {
      setSavedCalls(calls);
      setSelectedCallId(calls[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    setHighlightedSegmentId(null);
    if (!selectedCallId) {
      setSavedTranscripts([]);
      setTranscriptRevisions([]);
      setAudioAssets([]);
      setSttJobs([]);
      return;
    }

    let active = true;
    void refreshCallArtifacts(selectedCallId, () => active);
    return () => {
      active = false;
    };
  }, [selectedCallId]);

  useEffect(() => {
    if (!selectedCallId || !sttJobs.some((job) => job.status === 'running')) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void window.api.sttJobs.list(selectedCallId).then(setSttJobs);
    }, 1_000);
    return () => window.clearInterval(intervalId);
  }, [selectedCallId, sttJobs]);

  const selectedCall = savedCalls.find((call) => call.id === selectedCallId) ?? null;
  const selectedMinute =
    meetingMinute && meetingMinute.callId === selectedCallId ? meetingMinute : null;

  const refreshCalls = async (nextSelectedId?: string): Promise<void> => {
    const calls = await window.api.call.list();
    setSavedCalls(calls);
    if (nextSelectedId) {
      setSelectedCallId(nextSelectedId);
    }
  };

  const refreshCallArtifacts = async (
    callId: string,
    shouldApply: () => boolean = () => true,
  ): Promise<void> => {
    const revisions = await window.api.transcripts.listRevisions(callId);
    const activeRevisionId = revisions.find((revision) => revision.active)?.id ?? null;
    const [transcripts, assets, jobs, minute] = await Promise.all([
      window.api.transcripts.list(callId),
      window.api.audioAssets.list(callId),
      window.api.sttJobs.list(callId),
      window.api.minutes.get({ callId, transcriptRevisionId: activeRevisionId }),
    ]);
    if (!shouldApply()) return;
    setSavedTranscripts(transcripts);
    setTranscriptRevisions(revisions);
    setAudioAssets(assets);
    setSttJobs(jobs);
    setMeetingMinute(minute);
  };

  const importAudio = async (): Promise<void> => {
    const result = await window.api.audioAssets.import(props.productId, createUploadConsent());
    if (!result) {
      return;
    }
    await refreshCalls(result.call.id);
    setAudioAssets([result.asset]);
    setSttJobs(await window.api.sttJobs.list(result.call.id));
    setSavedTranscripts([]);
    setTranscriptRevisions([]);
    setMeetingMinute(null);
  };

  const importAndProcessAudio = async (): Promise<void> => {
    setProcessingAudio(true);
    try {
      const result = await window.api.audioAssets.importAndProcess(
        props.productId,
        createUploadConsent(),
      );
      if (!result) {
        return;
      }
      await refreshCalls(result.call.id);
      await refreshCallArtifacts(result.call.id);
      setMeetingMinute(result.meetingMinute);
    } finally {
      setProcessingAudio(false);
    }
  };

  const cloudUploadAndProcessAudio = async (): Promise<void> => {
    setCloudUploading(true);
    try {
      const result = await window.api.audioAssets.cloudUploadAndProcess(
        props.productId,
        createUploadConsent(),
      );
      if (result) {
        setCloudUploadResult(result);
      }
    } finally {
      setCloudUploading(false);
    }
  };

  const createSttJob = async (audioAssetId: string): Promise<void> => {
    const job = await window.api.sttJobs.create(audioAssetId);
    setSttJobs((current) => [job, ...current]);
  };

  const runSttJob = async (jobId: string): Promise<void> => {
    setSttJobs((current) =>
      current.map((job) => (job.id === jobId ? { ...job, status: 'running' } : job)),
    );
    const job = await window.api.sttJobs.run(jobId);
    if (selectedCallIdRef.current === job.callId) {
      await refreshCallArtifacts(job.callId, () => selectedCallIdRef.current === job.callId);
    }
  };

  const retrySttJob = async (job: AudioSttJob): Promise<void> => {
    const reason = retryReasons[job.id]?.trim() || '文字起こし品質の再確認';
    const provider = retryProviders[job.id] ?? job.provider;
    const retriedJob = await window.api.sttJobs.retry(job.id, reason, provider);
    setSttJobs((current) => [retriedJob, ...current]);
    await runSttJob(retriedJob.id);
  };

  const cancelSttJob = async (jobId: string): Promise<void> => {
    const cancelledJob = await window.api.sttJobs.cancel(jobId);
    setSttJobs((current) =>
      current.map((candidate) => (candidate.id === cancelledJob.id ? cancelledJob : candidate)),
    );
  };

  const activateTranscriptRevision = async (revisionId: string): Promise<void> => {
    if (!selectedCallId) return;
    const callId = selectedCallId;
    await window.api.transcripts.activateRevision(callId, revisionId);
    if (selectedCallIdRef.current === callId) {
      await refreshCallArtifacts(callId, () => selectedCallIdRef.current === callId);
    }
  };

  const generateMinutesFromSession = async (): Promise<void> => {
    setGeneratingMinutes(true);
    try {
      const generated = await window.api.minutes.generate(props.productId, props.recentTranscripts);
      setMeetingMinute(generated);
      await refreshCalls(generated.callId);
      setSavedTranscripts(await window.api.transcripts.list(generated.callId));
    } finally {
      setGeneratingMinutes(false);
    }
  };

  const generateMinutesForSelectedCall = async (): Promise<void> => {
    if (!selectedCall) {
      return;
    }
    setGeneratingMinutes(true);
    try {
      // transcripts を空で渡すと main 側が保存済み transcript から生成する
      const generated = await window.api.minutes.generate(
        selectedCall.productId,
        [],
        selectedCall.source,
        selectedCall.id,
      );
      setMeetingMinute(generated);
    } finally {
      setGeneratingMinutes(false);
    }
  };

  const focusSegment = (index: number): void => {
    const segment = savedTranscripts[index];
    if (!segment) {
      return;
    }
    setHighlightedSegmentId(segment.id);
    document
      .getElementById(`transcript-bubble-${segment.id}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const jumpToTimestamp = (ms: number): void => {
    focusSegment(findSegmentIndexForTimestamp(savedTranscripts, ms));
  };

  const jumpToQuote = (quote: string): void => {
    focusSegment(findSegmentIndexByQuote(savedTranscripts, quote));
  };

  const callGroups = groupCallsByRecency(savedCalls, new Date());

  return (
    <div className="rounded-lg border border-zinc-800 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-zinc-400">商談ライブラリ</h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={cloudUploading || !uploadConsentGranted}
            onClick={() => void cloudUploadAndProcessAudio()}
            className="rounded bg-sky-400 px-3 py-2 text-xs font-medium text-zinc-950 hover:opacity-90 disabled:cursor-wait disabled:opacity-40"
          >
            {cloudUploading ? 'Cloud処理中…' : 'Cloudへアップロード'}
          </button>
          <button
            type="button"
            disabled={processingAudio || !uploadConsentGranted}
            onClick={() => void importAndProcessAudio()}
            className="rounded bg-overlay-success px-3 py-2 text-xs font-medium text-zinc-950 hover:opacity-90 disabled:cursor-wait disabled:opacity-40"
          >
            {processingAudio ? '音声を処理中…' : '音声から自動生成'}
          </button>
          <button
            type="button"
            disabled={!uploadConsentGranted}
            onClick={() => void importAudio()}
            className="rounded border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            音声ファイルを取り込む
          </button>
          <button
            type="button"
            disabled={generatingMinutes}
            onClick={() => void generateMinutesFromSession()}
            className="rounded bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 disabled:cursor-wait disabled:opacity-40"
          >
            {generatingMinutes ? '生成中…' : '現セッションから議事録生成'}
          </button>
        </div>
      </div>

      <label className="mb-4 flex items-start gap-3 rounded border border-zinc-800 bg-zinc-950/50 p-3 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={uploadConsentGranted}
          onChange={(event) => setUploadConsentGranted(event.currentTarget.checked)}
          className="mt-0.5"
        />
        <span>
          顧客から録音・文字起こし・コンプラ解析への同意を取得済みです。この確認は監査証跡として
          call に保存されます。
        </span>
      </label>

      {cloudUploadResult && (
        <div className="mb-4 rounded border border-sky-900/70 bg-sky-950/30 p-3 text-xs text-sky-100">
          <div className="mb-2 font-medium">Cloud STT job</div>
          <div className="grid gap-2 md:grid-cols-4">
            <span>call {cloudUploadResult.callId.slice(0, 8)}</span>
            <span>asset {cloudUploadResult.audioAssetId.slice(0, 8)}</span>
            <span>job {cloudUploadResult.sttJobId.slice(0, 8)}</span>
            <span>
              {cloudUploadResult.status} / transcript {cloudUploadResult.transcriptCount}
            </span>
          </div>
          {cloudUploadResult.job.errorMessage && (
            <div className="mt-2 text-overlay-objection">{cloudUploadResult.job.errorMessage}</div>
          )}
        </div>
      )}

      {savedCalls.length === 0 ? (
        <p className="text-sm text-zinc-600">保存済み商談はまだありません。</p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)_320px]">
          <nav className="max-h-[560px] space-y-4 overflow-y-auto pr-1">
            {callGroups.map((group) => (
              <div key={group.label}>
                <div className="mb-2 text-xs text-zinc-600">{group.label}</div>
                <ul className="space-y-1">
                  {group.calls.map((call) => (
                    <li key={call.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedCallId(call.id)}
                        className={`w-full rounded-lg p-3 text-left text-xs transition-colors ${
                          selectedCallId === call.id
                            ? 'bg-overlay-warning/15 text-zinc-100'
                            : 'text-zinc-400 hover:bg-zinc-900/70'
                        }`}
                      >
                        <div className="truncate font-medium text-zinc-200">{callTitle(call)}</div>
                        <div className="mt-1 flex items-center justify-between text-zinc-500">
                          <span>{callDurationLabel(call) ?? call.status}</span>
                          <span>
                            {new Date(call.startedAt).toLocaleTimeString('ja-JP', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          <div className="min-w-0 rounded border border-zinc-800 bg-zinc-950/40 p-4">
            {selectedCall ? (
              <>
                <div className="mb-4">
                  <div className="text-base font-semibold text-zinc-100">
                    {callTitle(selectedCall)}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {new Date(selectedCall.startedAt).toLocaleString('ja-JP')}
                    {callDurationLabel(selectedCall) && ` ・ ${callDurationLabel(selectedCall)}`}
                    {' ・ '}
                    consent {selectedCall.recordingConsent.status}
                  </div>
                </div>

                {transcriptRevisions.length > 0 && (
                  <label className="mb-4 block rounded border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400">
                    <span className="mb-2 block font-medium text-zinc-300">文字起こし履歴</span>
                    <select
                      aria-label="文字起こし履歴"
                      value={transcriptRevisions.find((revision) => revision.active)?.id ?? ''}
                      onChange={(event) =>
                        void activateTranscriptRevision(event.currentTarget.value)
                      }
                      className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-200"
                    >
                      {transcriptRevisions.map((revision) => (
                        <option key={revision.id} value={revision.id}>
                          v{revision.revisionNumber} /{' '}
                          {revision.origin === 'live' ? 'オリジナル' : revision.provider} /{' '}
                          {revision.segmentCount}件
                          {revision.reason ? ` / ${revision.reason}` : ''}
                        </option>
                      ))}
                    </select>
                    <span className="mt-2 block text-zinc-600">
                      過去版は削除せず保持し、切替時にコンプラ判定と議事録を再生成します。
                    </span>
                  </label>
                )}

                <TranscriptBubbles
                  entries={savedTranscripts.map((segment) => ({
                    id: segment.id,
                    speaker: segment.speaker,
                    text: segment.text,
                    startMs: segment.startMs,
                    isFinal: segment.isFinal,
                  }))}
                  highlightedId={highlightedSegmentId}
                  emptyMessage="この商談の transcript は未保存です。"
                  maxHeightClassName="max-h-[420px]"
                />

                <details className="mt-4 text-xs">
                  <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
                    音声ファイル / STT ジョブ({audioAssets.length} / {sttJobs.length})
                  </summary>
                  <div className="mt-3 space-y-3">
                    {audioAssets.length === 0 ? (
                      <p className="text-zinc-600">この商談の音声ファイルは未登録です。</p>
                    ) : (
                      <ul className="space-y-2">
                        {audioAssets.map((asset) => (
                          <li key={asset.id} className="rounded bg-zinc-900/70 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-zinc-200">{asset.fileName}</div>
                                <div className="mt-1 text-zinc-500">
                                  {asset.mimeType} / {formatBytes(asset.sizeBytes)}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => void createSttJob(asset.id)}
                                className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                              >
                                STT job作成
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {sttJobs.length > 0 && (
                      <ul className="space-y-2">
                        {sttJobs.map((job) => (
                          <li key={job.id} className="rounded bg-zinc-900/70 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-zinc-400">{job.id.slice(0, 8)}</span>
                              <span className="rounded bg-zinc-950 px-2 py-0.5 text-zinc-300">
                                {job.status}
                              </span>
                            </div>
                            <div className="mt-1 text-zinc-500">
                              {job.provider} / attempt {job.attempt} / asset{' '}
                              {job.audioAssetId.slice(0, 8)}
                            </div>
                            <div className="mt-2 h-1.5 overflow-hidden rounded bg-zinc-950">
                              <div
                                className="h-full bg-overlay-success transition-[width]"
                                style={{ width: `${job.progressPercent}%` }}
                              />
                            </div>
                            <div className="mt-1 text-[10px] text-zinc-600">
                              工程目安 {job.progressPercent}%
                              {job.retryReason ? ` / ${job.retryReason}` : ''}
                            </div>
                            {job.status === 'queued' && (
                              <button
                                type="button"
                                onClick={() => void runSttJob(job.id)}
                                className="mt-2 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                              >
                                STT実行
                              </button>
                            )}
                            {job.status === 'running' && (
                              <button
                                type="button"
                                disabled={job.progressPercent >= 90}
                                onClick={() => void cancelSttJob(job.id)}
                                className="mt-2 rounded border border-red-900 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {job.progressPercent >= 90 ? '確定処理中' : '処理をキャンセル'}
                              </button>
                            )}
                            {['completed', 'failed', 'cancelled'].includes(job.status) && (
                              <div className="mt-3 grid gap-2 md:grid-cols-[1fr_170px_auto]">
                                <input
                                  aria-label={`再処理理由 ${job.id.slice(0, 8)}`}
                                  value={retryReasons[job.id] ?? ''}
                                  onChange={(event) =>
                                    setRetryReasons((current) => ({
                                      ...current,
                                      [job.id]: event.currentTarget.value,
                                    }))
                                  }
                                  placeholder="再処理理由"
                                  className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200"
                                />
                                <select
                                  aria-label={`再処理provider ${job.id.slice(0, 8)}`}
                                  value={retryProviders[job.id] ?? job.provider}
                                  onChange={(event) =>
                                    setRetryProviders((current) => ({
                                      ...current,
                                      [job.id]: event.currentTarget.value as AudioSttProvider,
                                    }))
                                  }
                                  className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200"
                                >
                                  <option value="apple_speech_analyzer">Apple SpeechAnalyzer</option>
                                  <option value="deepgram">Deepgram</option>
                                </select>
                                <button
                                  type="button"
                                  onClick={() => void retrySttJob(job)}
                                  className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                                >
                                  再文字起こし
                                </button>
                              </div>
                            )}
                            {job.errorMessage && (
                              <div className="mt-1 text-overlay-objection">{job.errorMessage}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </details>
              </>
            ) : (
              <p className="text-sm text-zinc-600">商談を選択してください。</p>
            )}
          </div>

          <MinuteSummaryPanel
            minute={selectedMinute}
            generating={generatingMinutes}
            canGenerate={selectedCall !== null}
            onGenerate={() => void generateMinutesForSelectedCall()}
            onJumpToTimestamp={jumpToTimestamp}
            onJumpToQuote={jumpToQuote}
          />
        </div>
      )}
    </div>
  );
}

function MinuteSummaryPanel(props: {
  minute: MeetingMinute | null;
  generating: boolean;
  canGenerate: boolean;
  onGenerate: () => void;
  onJumpToTimestamp: (ms: number) => void;
  onJumpToQuote: (quote: string) => void;
}): JSX.Element {
  return (
    <aside className="max-h-[560px] overflow-y-auto rounded border border-zinc-800 bg-zinc-950/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-300">Summary</h3>
        <button
          type="button"
          disabled={props.generating || !props.canGenerate}
          onClick={props.onGenerate}
          className="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-40"
        >
          {props.generating ? '生成中…' : props.minute ? '再生成' : '議事録を生成'}
        </button>
      </div>

      {!props.minute ? (
        <p className="text-xs text-zinc-600">
          この商談の議事録はまだ生成されていません。「議事録を生成」で transcript から作成します。
        </p>
      ) : (
        <div className="space-y-4">
          <section>
            <SummaryHeading label="概要" />
            <p className="text-sm leading-relaxed text-zinc-300">{props.minute.summary}</p>
          </section>
          <SummaryLinkedList
            label="決定事項"
            items={props.minute.decisions}
            empty="決定事項なし"
            onJumpToTimestamp={props.onJumpToTimestamp}
          />
          <SummaryLinkedList
            label="合意事項"
            items={props.minute.agreed}
            empty="合意事項なし"
            onJumpToTimestamp={props.onJumpToTimestamp}
          />
          <SummaryLinkedList
            label="保留・宿題"
            items={props.minute.pending}
            empty="保留事項なし"
            onJumpToTimestamp={props.onJumpToTimestamp}
          />
          <section>
            <SummaryHeading label="数値メモ" />
            {props.minute.numbers.length === 0 ? (
              <p className="text-xs text-zinc-600">数値なし</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {props.minute.numbers.map((number) => (
                  <li
                    key={`${number.label}-${number.value}`}
                    className="rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
                  >
                    {number.value}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <SummaryHeading label="コンプラレビュー" />
            {props.minute.complianceFindings.length === 0 ? (
              <p className="text-xs text-zinc-600">検知なし</p>
            ) : (
              <ul className="space-y-2">
                {props.minute.complianceFindings.map((finding) => (
                  <li
                    key={finding.id}
                    className="rounded border border-overlay-objection/40 bg-overlay-objection/10 p-3 text-xs"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="rounded bg-zinc-900 px-2 py-0.5 text-overlay-objection">
                        {finding.severity}
                      </span>
                      <button
                        type="button"
                        onClick={() => props.onJumpToQuote(finding.quotedText)}
                        className="text-[11px] text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
                      >
                        発話へ
                      </button>
                    </div>
                    <div className="text-zinc-200">{finding.quotedText}</div>
                    <div className="mt-1 text-zinc-500">{finding.reason}</div>
                    <div className="mt-2 text-overlay-warning">{finding.recommendedAction}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="text-[11px] text-zinc-600">
            生成: {new Date(props.minute.generatedAt).toLocaleString('ja-JP')}
          </p>
        </div>
      )}
    </aside>
  );
}

function SummaryHeading(props: { label: string }): JSX.Element {
  return (
    <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">{props.label}</div>
  );
}

/** `[mm:ss] 本文` の項目はタイムスタンプをリンク化して該当発話へジャンプさせる。 */
function SummaryLinkedList(props: {
  label: string;
  items: string[];
  empty: string;
  onJumpToTimestamp: (ms: number) => void;
}): JSX.Element {
  return (
    <section>
      <SummaryHeading label={props.label} />
      {props.items.length === 0 ? (
        <p className="text-xs text-zinc-600">{props.empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {props.items.map((item) => {
            const timestamp = parseLeadingTimestamp(item);
            return (
              <li key={item} className="rounded bg-zinc-900 px-3 py-2 text-xs text-zinc-300">
                {timestamp ? (
                  <>
                    <button
                      type="button"
                      onClick={() => props.onJumpToTimestamp(timestamp.ms)}
                      className="mr-1.5 font-mono text-overlay-warning underline-offset-2 hover:underline"
                    >
                      [{timestamp.label}]
                    </button>
                    {timestamp.rest}
                  </>
                ) : (
                  item
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
