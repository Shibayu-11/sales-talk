import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AppSettings,
  ActionItemTask,
  AudioAsset,
  AudioCaptureStatus,
  AudioSttJob,
  CallSession,
  CallState,
  ConnectionState,
  DetectedObjection,
  KnowledgeEntry,
  MeetingMinute,
  ObjectionResponse,
  PermissionState,
  ProductId,
  ReviewTask,
  ReviewTaskStatus,
  RecordingConsent,
  TaskOwner,
  Transcript,
  TranscriptSegment,
} from '@shared/types';

const PRODUCTS: { id: ProductId; label: string }[] = [
  { id: 'real_estate', label: '不動産' },
  { id: 'kenko_keiei', label: '健康経営優良法人' },
  { id: 'hojokin', label: '補助金助成金' },
];

const NAV_ITEMS = ['ダッシュボード', '商談履歴', 'レビュー', 'ナレッジ', 'タスク', '設定'] as const;
type NavItem = (typeof NAV_ITEMS)[number];

const SECRET_KEYS = [
  { key: 'deepgram_api_key', label: 'Deepgram' },
  { key: 'anthropic_api_key', label: 'Anthropic' },
  { key: 'cohere_api_key', label: 'Cohere' },
  { key: 'supabase_anon_key', label: 'Supabase anon' },
] as const;
const AUDIO_STATUS_POLL_INTERVAL_MS = 1_000;

interface ObjectionHistoryItem {
  objection: DetectedObjection;
  response: ObjectionResponse | null;
}

export function App(): JSX.Element {
  const [version, setVersion] = useState<string>('');
  const [permissions, setPermissions] = useState<PermissionState | null>(null);
  const [call, setCall] = useState<CallState>({ status: 'idle' });
  const [productId, setProductId] = useState<ProductId>('real_estate');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeNav, setActiveNav] = useState<NavItem>('ダッシュボード');
  const [secretStatus, setSecretStatus] = useState<Record<string, boolean>>({});
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [audioStatus, setAudioStatus] = useState<AudioCaptureStatus | null>(null);
  const [sttState, setSttState] = useState<ConnectionState>('disconnected');
  const [audioError, setAudioError] = useState<string | null>(null);
  const [sttError, setSttError] = useState<string | null>(null);
  const [recentTranscripts, setRecentTranscripts] = useState<Transcript[]>([]);
  const [currentObjection, setCurrentObjection] = useState<DetectedObjection | null>(null);
  const [currentResponse, setCurrentResponse] = useState<ObjectionResponse | null>(null);
  const [objectionHistory, setObjectionHistory] = useState<ObjectionHistoryItem[]>([]);
  const [devToolsEnabled, setDevToolsEnabled] = useState(false);
  const shouldPollAudioStatus =
    activeNav === 'ダッシュボード' &&
    (call.status === 'in_call' ||
      Boolean(audioStatus?.nativeCaptureActive) ||
      sttState === 'connecting' ||
      sttState === 'connected' ||
      sttState === 'reconnecting');

  useEffect(() => {
    void window.api.app.getVersion().then(setVersion);
    void window.api.permissions.check().then(setPermissions);
    void refreshAudioStatus();
    void window.api.dev.isEnabled().then(setDevToolsEnabled);
    void window.api.settings.get().then((loadedSettings) => {
      setSettings(loadedSettings);
      if (loadedSettings.selectedProductId) setProductId(loadedSettings.selectedProductId);
    });
    void refreshSecretStatus();
    const offPerm = window.api.permissions.onChange(setPermissions);
    const offCall = window.api.call.onState(setCall);
    const offSettings = window.api.settings.onChange((nextSettings) => {
      setSettings(nextSettings);
      if (nextSettings.selectedProductId) setProductId(nextSettings.selectedProductId);
    });
    const offAudioError = window.api.audio.onError(setAudioError);
    const offSttError = window.api.stt.onError(setSttError);
    const offSttState = window.api.stt.onConnectionState((state) => {
      setSttState(state);
      setAudioStatus((current) => (current ? { ...current, sttState: state } : current));
    });
    const rememberTranscript = (transcript: Transcript): void => {
      setRecentTranscripts((current) => [transcript, ...current].slice(0, 5));
    };
    const offInterim = window.api.stt.onInterim(rememberTranscript);
    const offFinal = window.api.stt.onFinal(rememberTranscript);
    const offObjection = window.api.objection.onDetected((objection) => {
      setCurrentObjection(objection);
      setCurrentResponse(null);
      setObjectionHistory((current) => [{ objection, response: null }, ...current].slice(0, 20));
    });
    const offResponse = window.api.objection.onResponseReady((response) => {
      setCurrentResponse(response);
      setObjectionHistory((current) =>
        current.map((item) =>
          item.objection.id === response.objectionId ? { ...item, response } : item,
        ),
      );
    });
    const offCancelled = window.api.objection.onCancelled((id) => {
      setCurrentObjection((current) => (current?.id === id ? null : current));
      setCurrentResponse((current) => (current?.objectionId === id ? null : current));
    });
    return () => {
      offPerm();
      offCall();
      offSettings();
      offAudioError();
      offSttError();
      offSttState();
      offInterim();
      offFinal();
      offObjection();
      offResponse();
      offCancelled();
    };
  }, []);

  useEffect(() => {
    if (!shouldPollAudioStatus) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void refreshAudioStatus();
    }, AUDIO_STATUS_POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [shouldPollAudioStatus]);

  const startCall = async (): Promise<void> => {
    setAudioError(null);
    setSttError(null);
    await window.api.call.start(productId);
    await refreshAudioStatus();
  };

  const startAudioDiagnostic = async (): Promise<void> => {
    setAudioError(null);
    setSttError(null);
    await window.api.audio.start();
    await refreshAudioStatus();
  };

  const stopAudioDiagnostic = async (): Promise<void> => {
    await window.api.audio.stop();
    await refreshAudioStatus();
  };

  const requestScreenPermission = async (): Promise<void> => {
    await window.api.permissions.requestScreen();
    await refreshAudioStatus();
  };

  const requestMicrophonePermission = async (): Promise<void> => {
    await window.api.permissions.requestMicrophone();
    await refreshAudioStatus();
  };

  const endCall = async (): Promise<void> => {
    await window.api.call.end();
    await refreshAudioStatus();
  };

  const startDevMockCall = async (): Promise<void> => {
    await window.api.dev.startMockCall(productId);
  };

  const endDevMockCall = async (): Promise<void> => {
    await window.api.dev.endMockCall();
    await refreshAudioStatus();
  };

  const injectDevTranscript = async (): Promise<void> => {
    const now = Date.now();
    await window.api.dev.injectTranscript({
      speaker: 'counterpart',
      text: '価格が高いので、今すぐ導入するのは難しいです。',
      isFinal: true,
      startMs: now - 2_000,
      endMs: now,
    });
  };

  const dismissCurrentObjection = async (): Promise<void> => {
    if (!currentObjection) {
      return;
    }
    await window.api.objection.dismiss(currentObjection.id);
    setCurrentObjection(null);
    setCurrentResponse(null);
  };

  const refreshAudioStatus = async (): Promise<void> => {
    const status = await window.api.audio.getStatus();
    setAudioStatus(status);
    setPermissions(status.permissions);
    setSttState(status.sttState);
  };

  const refreshSecretStatus = async (): Promise<void> => {
    const entries = await Promise.all(
      SECRET_KEYS.map(async ({ key }) => [key, await window.api.secrets.has(key)] as const),
    );
    setSecretStatus(Object.fromEntries(entries));
  };

  const selectProduct = async (nextProductId: ProductId): Promise<void> => {
    setProductId(nextProductId);
    await window.api.call.setProduct(nextProductId);
  };

  const saveSecret = async (key: string): Promise<void> => {
    const value = secretInputs[key]?.trim();
    if (!value) return;
    await window.api.secrets.set(key, value);
    setSecretInputs((current) => ({ ...current, [key]: '' }));
    await refreshSecretStatus();
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <h1 className="text-lg font-semibold">SalesTalk</h1>
        <span className="text-xs text-zinc-500">v{version}</span>
      </header>

      <main className="grid flex-1 grid-cols-[260px_1fr]">
        <nav className="border-r border-zinc-800 p-4 text-sm">
          <ul className="space-y-1">
            {NAV_ITEMS.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => setActiveNav(label)}
                className={`w-full rounded px-3 py-2 text-left ${
                  activeNav === label ? 'bg-zinc-800 text-zinc-100' : 'hover:bg-zinc-800/60'
                }`}
              >
                {label}
              </button>
            ))}
          </ul>
        </nav>

        <section className="space-y-6 p-6">
          {activeNav === 'ダッシュボード' && (
            <DashboardPanel
              call={call}
              permissions={permissions}
              productId={productId}
              onEndCall={endCall}
              onRequestMicrophonePermission={requestMicrophonePermission}
              onRequestScreenPermission={requestScreenPermission}
              onRefreshAudioStatus={refreshAudioStatus}
              onStartAudioDiagnostic={startAudioDiagnostic}
              onStartCall={startCall}
              onStopAudioDiagnostic={stopAudioDiagnostic}
              onSelectProduct={selectProduct}
              onStartDevMockCall={startDevMockCall}
              onEndDevMockCall={endDevMockCall}
              onInjectDevTranscript={injectDevTranscript}
              onDismissCurrentObjection={dismissCurrentObjection}
              onOpenSettings={() => setActiveNav('設定')}
              audioError={audioError}
              audioStatus={audioStatus}
              audioStatusPolling={shouldPollAudioStatus}
              deepgramConfigured={Boolean(secretStatus.deepgram_api_key)}
              devToolsEnabled={devToolsEnabled}
              currentObjection={currentObjection}
              currentResponse={currentResponse}
              recentTranscripts={recentTranscripts}
              sttError={sttError}
              sttState={sttState}
            />
          )}
          {activeNav === '商談履歴' && (
            <HistoryPanel
              objectionHistory={objectionHistory}
              productId={productId}
              recentTranscripts={recentTranscripts}
            />
          )}
          {activeNav === 'レビュー' && <ReviewPanel />}
          {activeNav === 'ナレッジ' && <KnowledgePanel productId={productId} />}
          {activeNav === 'タスク' && <TasksPanel />}
          {activeNav === '設定' && (
            <SettingsPanel
              permissions={permissions}
              secretInputs={secretInputs}
              secretStatus={secretStatus}
              settings={settings}
              onSecretInputChange={(key, value) =>
                setSecretInputs((current) => ({ ...current, [key]: value }))
              }
              onSaveSecret={saveSecret}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function DashboardPanel(props: {
  audioError: string | null;
  audioStatus: AudioCaptureStatus | null;
  audioStatusPolling: boolean;
  call: CallState;
  permissions: PermissionState | null;
  productId: ProductId;
  onEndCall: () => Promise<void>;
  onRequestMicrophonePermission: () => Promise<void>;
  onRequestScreenPermission: () => Promise<void>;
  onRefreshAudioStatus: () => Promise<void>;
  onStartAudioDiagnostic: () => Promise<void>;
  onStartCall: () => Promise<void>;
  onStopAudioDiagnostic: () => Promise<void>;
  onSelectProduct: (productId: ProductId) => Promise<void>;
  onStartDevMockCall: () => Promise<void>;
  onEndDevMockCall: () => Promise<void>;
  onInjectDevTranscript: () => Promise<void>;
  onDismissCurrentObjection: () => Promise<void>;
  onOpenSettings: () => void;
  currentObjection: DetectedObjection | null;
  currentResponse: ObjectionResponse | null;
  recentTranscripts: Transcript[];
  deepgramConfigured: boolean;
  devToolsEnabled: boolean;
  sttError: string | null;
  sttState: ConnectionState;
}): JSX.Element {
  const deepgramErrorVisible = Boolean(
    props.sttError &&
      props.deepgramConfigured &&
      !props.sttError.includes('Deepgram API key is not configured'),
  );
  const audioDiagnosticActive =
    Boolean(props.audioStatus?.nativeCaptureActive) ||
    props.sttState === 'connecting' ||
    props.sttState === 'connected' ||
    props.sttState === 'reconnecting';
  const canStartAudioDiagnostic = Boolean(
    props.permissions?.screen && props.permissions?.microphone && !audioDiagnosticActive,
  );

  return (
    <>
      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">商材</h2>
        <div className="flex gap-2">
          {PRODUCTS.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => void props.onSelectProduct(product.id)}
              className={`rounded px-4 py-2 text-sm ${
                props.productId === product.id
                  ? 'bg-zinc-100 text-zinc-900'
                  : 'border border-zinc-700 hover:bg-zinc-800'
              }`}
            >
              {product.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">通話</h2>
        <ActionableDiagnostics
          audioError={props.audioError}
          audioStatus={props.audioStatus}
          deepgramConfigured={props.deepgramConfigured}
          permissions={props.permissions}
          sttError={props.sttError}
          onOpenSettings={props.onOpenSettings}
          onRequestMicrophonePermission={props.onRequestMicrophonePermission}
          onRequestScreenPermission={props.onRequestScreenPermission}
        />
        <div className="flex items-center gap-3">
          {props.call.status === 'in_call' ? (
            <button
              type="button"
              onClick={() => void props.onEndCall()}
              className="rounded bg-overlay-objection px-4 py-2 text-sm font-medium text-white"
            >
              通話を終了
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void props.onStartCall()}
              className="rounded bg-overlay-success px-4 py-2 text-sm font-medium text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!props.permissions?.screen || !props.permissions?.microphone}
            >
              通話を開始
            </button>
          )}
          <span className="text-xs text-zinc-500">状態: {props.call.status}</span>
        </div>
      </div>

      {props.devToolsEnabled && (
        <div className="rounded-lg border border-dashed border-zinc-700 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium text-zinc-400">Dev transcript injection</h2>
              <p className="mt-1 text-xs text-zinc-500">
                API key なしで STT event / pipeline / overlay 表示を確認します。
              </p>
            </div>
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
              dev only
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {props.call.status === 'in_call' ? (
              <button
                type="button"
                onClick={() => void props.onEndDevMockCall()}
                className="rounded bg-overlay-objection px-3 py-2 text-xs font-medium text-white"
              >
                mock 通話終了
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void props.onStartDevMockCall()}
                className="rounded bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900"
              >
                mock 通話開始
              </button>
            )}
            <button
              type="button"
              onClick={() => void props.onInjectDevTranscript()}
              className="rounded bg-zinc-800 px-3 py-2 text-xs hover:bg-zinc-700"
            >
              反論 transcript 注入
            </button>
          </div>
        </div>
      )}

      <CurrentObjectionPanel
        objection={props.currentObjection}
        response={props.currentResponse}
        onDismiss={props.onDismissCurrentObjection}
      />

      <div className="rounded-lg border border-zinc-800 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-zinc-400">音声 / STT 診断</h2>
            {props.audioStatusPolling && (
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-overlay-success">
                auto refresh
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {audioDiagnosticActive ? (
              <button
                type="button"
                onClick={() => void props.onStopAudioDiagnostic()}
                className="rounded bg-overlay-objection px-3 py-1 text-xs font-medium text-white"
              >
                停止
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void props.onStartAudioDiagnostic()}
                className="rounded bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canStartAudioDiagnostic}
              >
                診断開始
              </button>
            )}
            <button
              type="button"
              onClick={() => void props.onRefreshAudioStatus()}
              className="rounded bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700"
            >
              更新
            </button>
          </div>
        </div>
        <div className="grid gap-3 text-sm md:grid-cols-5">
          <StatusTile
            label="Screen Recording"
            value={props.audioStatus?.permissions.screen ? 'granted' : 'missing'}
            ok={Boolean(props.audioStatus?.permissions.screen)}
          />
          <StatusTile
            label="Microphone"
            value={props.audioStatus?.permissions.microphone ? 'granted' : 'missing'}
            ok={Boolean(props.audioStatus?.permissions.microphone)}
          />
          <StatusTile
            label="Native module"
            value={props.audioStatus?.nativeModule.available ? 'available' : 'missing'}
            ok={Boolean(props.audioStatus?.nativeModule.contractValid)}
          />
          <StatusTile
            label="Native capture"
            value={props.audioStatus?.nativeCaptureActive ? 'active' : 'stopped'}
            ok={Boolean(props.audioStatus?.nativeCaptureActive)}
          />
          <StatusTile
            label="STT"
            value={props.sttState}
            ok={props.sttState === 'connected'}
          />
        </div>
        <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
          <AudioStatsTile label="Self audio" stats={props.audioStatus?.stats.self} />
          <AudioStatsTile label="Counterpart audio" stats={props.audioStatus?.stats.counterpart} />
          <AudioStatsTile label="Total audio" stats={props.audioStatus?.stats.total} />
        </div>
        <div className="mt-3 space-y-1 text-xs text-zinc-500">
          <div>module: {props.audioStatus?.nativeModule.modulePath ?? '-'}</div>
          {props.audioStatus?.nativeModule.error && (
            <div className="text-overlay-objection">{props.audioStatus.nativeModule.error}</div>
          )}
          {props.audioError && <div className="text-overlay-objection">Audio: {props.audioError}</div>}
          {deepgramErrorVisible && <div className="text-overlay-objection">STT: {props.sttError}</div>}
        </div>
        <div className="mt-4">
          <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Recent transcripts</div>
          {props.recentTranscripts.length === 0 ? (
            <div className="rounded border border-zinc-800 p-3 text-xs text-zinc-600">未受信</div>
          ) : (
            <ul className="space-y-2">
              {props.recentTranscripts.map((transcript, index) => (
                <li key={`${transcript.startMs}-${index}`} className="rounded border border-zinc-800 p-3 text-xs">
                  <span className="mr-2 text-zinc-500">
                    {transcript.isFinal ? 'final' : 'interim'} / {transcript.speaker}
                  </span>
                  {transcript.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function CurrentObjectionPanel(props: {
  objection: DetectedObjection | null;
  response: ObjectionResponse | null;
  onDismiss: () => Promise<void>;
}): JSX.Element {
  if (!props.objection) {
    return (
      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-2 text-sm font-medium text-zinc-400">現在の反論</h2>
        <p className="text-sm text-zinc-600">検知待機中</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-overlay-objection/50 bg-overlay-objection/10 p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-overlay-objection">現在の反論</h2>
          <div className="mt-1 text-lg font-semibold text-zinc-100">{props.response?.peak ?? props.objection.type}</div>
          <p className="mt-1 text-sm text-zinc-400">{props.objection.triggerText}</p>
        </div>
        <button
          type="button"
          onClick={() => void props.onDismiss()}
          className="rounded bg-zinc-900 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          dismiss
        </button>
      </div>
      <div className="mb-3 flex items-center gap-2 text-xs text-zinc-500">
        <span>type: {props.objection.type}</span>
        <span>confidence: {Math.round(props.objection.confidence * 100)}%</span>
      </div>
      {props.response ? (
        <div className="space-y-3">
          <ul className="grid gap-2 text-sm md:grid-cols-3">
            {props.response.summary.slice(0, 3).map((line) => (
              <li key={line} className="rounded border border-zinc-800 bg-zinc-950/60 p-3">
                {line}
              </li>
            ))}
          </ul>
          <p className="text-xs text-zinc-500">{props.response.reasoning}</p>
        </div>
      ) : (
        <p className="text-xs text-overlay-warning">切り返し生成中</p>
      )}
    </div>
  );
}

function AudioStatsTile(props: {
  label: string;
  stats: AudioCaptureStatus['stats']['self'] | undefined;
}): JSX.Element {
  return (
    <div className="rounded border border-zinc-800 p-3">
      <div className="text-xs text-zinc-500">{props.label}</div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <Metric label="chunks" value={String(props.stats?.chunks ?? 0)} />
        <Metric label="bytes" value={formatBytes(props.stats?.bytes ?? 0)} />
        <Metric label="last" value={formatLastReceivedAt(props.stats?.lastReceivedAtMs ?? null)} />
      </div>
    </div>
  );
}

function ActionableDiagnostics(props: {
  audioError: string | null;
  audioStatus: AudioCaptureStatus | null;
  deepgramConfigured: boolean;
  permissions: PermissionState | null;
  sttError: string | null;
  onOpenSettings: () => void;
  onRequestMicrophonePermission: () => Promise<void>;
  onRequestScreenPermission: () => Promise<void>;
}): JSX.Element | null {
  const permissionMissing = !props.permissions?.screen || !props.permissions?.microphone;
  const nativeMissing =
    props.audioStatus !== null && !props.audioStatus.nativeModule.contractValid;
  const deepgramMissing =
    !props.deepgramConfigured ||
    props.sttError?.includes('Deepgram API key is not configured') === true;

  if (!permissionMissing && !nativeMissing && !deepgramMissing && !props.audioError && !props.sttError) {
    return null;
  }

  return (
    <div className="mb-4 space-y-3">
      {permissionMissing && (
        <ActionCard
          title="通話開始前に権限が必要です"
          body="Zoom 音声の取得には Screen Recording、あなたの発話取得には Microphone を許可してください。"
        >
          {!props.permissions?.screen && (
            <ActionButton onClick={() => void props.onRequestScreenPermission()}>
              Screen Recording を開く
            </ActionButton>
          )}
          {!props.permissions?.microphone && (
            <ActionButton onClick={() => void props.onRequestMicrophonePermission()}>
              Microphone を許可
            </ActionButton>
          )}
        </ActionCard>
      )}
      {deepgramMissing && (
        <ActionCard
          title="Deepgram API key が未設定です"
          body="音声 chunk の取得診断は可能です。STT まで確認するには Settings で Deepgram key を保存してください。"
        >
          <ActionButton onClick={props.onOpenSettings}>Settings を開く</ActionButton>
        </ActionCard>
      )}
      {nativeMissing && (
        <ActionCard
          title="Native audio module が利用できません"
          body="`.node` addon が見つからない、または期待する NAPI contract と一致していません。"
        >
          <span className="font-mono text-[11px] text-zinc-500">
            {props.audioStatus?.nativeModule.modulePath}
          </span>
        </ActionCard>
      )}
      {props.audioError && <InlineError label="Audio" message={props.audioError} />}
      {props.sttError && !deepgramMissing && <InlineError label="STT" message={props.sttError} />}
    </div>
  );
}

function ActionCard(props: {
  title: string;
  body: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded border border-overlay-objection/40 bg-overlay-objection/10 p-4">
      <div className="text-sm font-medium text-overlay-objection">{props.title}</div>
      <div className="mt-1 text-xs text-zinc-400">{props.body}</div>
      <div className="mt-3 flex flex-wrap items-center gap-2">{props.children}</div>
    </div>
  );
}

function ActionButton(props: { children: ReactNode; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="rounded bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 hover:bg-zinc-300"
    >
      {props.children}
    </button>
  );
}

function InlineError(props: { label: string; message: string }): JSX.Element {
  return (
    <div className="rounded border border-overlay-objection/30 bg-zinc-950 p-3 text-xs text-overlay-objection">
      {props.label}: {props.message}
    </div>
  );
}

function Metric(props: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-zinc-600">{props.label}</div>
      <div className="font-mono text-zinc-300">{props.value}</div>
    </div>
  );
}

function StatusTile(props: { label: string; value: string; ok: boolean }): JSX.Element {
  return (
    <div className="rounded border border-zinc-800 p-3">
      <div className="text-xs text-zinc-500">{props.label}</div>
      <div className={props.ok ? 'text-overlay-success' : 'text-zinc-400'}>{props.value}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLastReceivedAt(timestampMs: number | null): string {
  if (timestampMs === null) {
    return '-';
  }
  return new Date(timestampMs).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function createUploadConsent(): RecordingConsent {
  return {
    status: 'granted',
    method: 'upload_attestation',
    capturedAt: new Date().toISOString(),
    noticeVersion: 'local-v1',
  };
}

function SettingsPanel(props: {
  permissions: PermissionState | null;
  secretInputs: Record<string, string>;
  secretStatus: Record<string, boolean>;
  settings: AppSettings | null;
  onSecretInputChange: (key: string, value: string) => void;
  onSaveSecret: (key: string) => Promise<void>;
}): JSX.Element {
  return (
    <>
      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">権限</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <PermissionRow
            label="画面収録 (Screen Recording)"
            granted={props.permissions?.screen}
            onRequest={() => void window.api.permissions.requestScreen()}
          />
          <PermissionRow
            label="マイク (Microphone)"
            granted={props.permissions?.microphone}
            onRequest={() => void window.api.permissions.requestMicrophone()}
          />
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">API Keys</h2>
        <div className="space-y-3">
          {SECRET_KEYS.map(({ key, label }) => (
            <div key={key} className="grid grid-cols-[160px_1fr_auto_auto] items-center gap-3">
              <span className="text-sm">{label}</span>
              <input
                aria-label={`${label} API key`}
                type="password"
                value={props.secretInputs[key] ?? ''}
                onChange={(event) => props.onSecretInputChange(key, event.currentTarget.value)}
                className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                placeholder="Keychainへ保存"
              />
              <span className={props.secretStatus[key] ? 'text-overlay-success' : 'text-zinc-500'}>
                {props.secretStatus[key] ? '保存済み' : '未設定'}
              </span>
              <button
                aria-label={`${label} API key を保存`}
                type="button"
                onClick={() => void props.onSaveSecret(key)}
                className="rounded bg-zinc-100 px-3 py-2 text-sm text-zinc-900 disabled:opacity-40"
                disabled={!props.secretInputs[key]?.trim()}
              >
                保存
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 p-5 text-sm text-zinc-400">
        設定スキーマ: v{props.settings?.schemaVersion ?? '-'} / 通知方式:{' '}
        {props.settings?.consentNoticeMode ?? '-'}
      </div>
    </>
  );
}

function HistoryPanel(props: {
  objectionHistory: ObjectionHistoryItem[];
  productId: ProductId;
  recentTranscripts: Transcript[];
}): JSX.Element {
  const [meetingMinute, setMeetingMinute] = useState<MeetingMinute | null>(null);
  const [savedCalls, setSavedCalls] = useState<CallSession[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [savedTranscripts, setSavedTranscripts] = useState<TranscriptSegment[]>([]);
  const [audioAssets, setAudioAssets] = useState<AudioAsset[]>([]);
  const [sttJobs, setSttJobs] = useState<AudioSttJob[]>([]);
  const [processingAudio, setProcessingAudio] = useState(false);
  const [uploadConsentGranted, setUploadConsentGranted] = useState(false);

  useEffect(() => {
    void window.api.minutes.get().then(setMeetingMinute);
    void window.api.call.list().then((calls) => {
      setSavedCalls(calls);
      setSelectedCallId(calls[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!selectedCallId) {
      setSavedTranscripts([]);
      setAudioAssets([]);
      setSttJobs([]);
      return;
    }

    void window.api.transcripts.list(selectedCallId).then(setSavedTranscripts);
    void window.api.audioAssets.list(selectedCallId).then(setAudioAssets);
    void window.api.sttJobs.list(selectedCallId).then(setSttJobs);
  }, [selectedCallId]);

  const importAudio = async (): Promise<void> => {
    const result = await window.api.audioAssets.import(props.productId, createUploadConsent());
    if (!result) {
      return;
    }

    const calls = await window.api.call.list();
    setSavedCalls(calls);
    setSelectedCallId(result.call.id);
    setAudioAssets([result.asset]);
    setSttJobs(await window.api.sttJobs.list(result.call.id));
    setSavedTranscripts([]);
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

      const calls = await window.api.call.list();
      setSavedCalls(calls);
      setSelectedCallId(result.call.id);
      setAudioAssets([result.asset]);
      setSttJobs([result.job]);
      setSavedTranscripts(await window.api.transcripts.list(result.call.id));
      setMeetingMinute(result.meetingMinute);
    } finally {
      setProcessingAudio(false);
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
    setSttJobs((current) => current.map((candidate) => (candidate.id === job.id ? job : candidate)));
    if (selectedCallId) {
      setSavedTranscripts(await window.api.transcripts.list(selectedCallId));
    }
    if (job.status === 'completed') {
      setMeetingMinute(await window.api.minutes.get());
    }
  };

  const generateMinutes = async (): Promise<void> => {
    const generated = await window.api.minutes.generate(props.productId, props.recentTranscripts);
    setMeetingMinute(generated);
    const calls = await window.api.call.list();
    setSavedCalls(calls);
    setSelectedCallId(generated.callId);
    setSavedTranscripts(await window.api.transcripts.list(generated.callId));
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-800 p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-400">ローカル議事録</h2>
          <div className="flex gap-2">
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
              onClick={() => void generateMinutes()}
              className="rounded bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900"
            >
              transcript から生成
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
        {meetingMinute ? (
          <div className="space-y-3">
            <p className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-sm text-zinc-300">
              {meetingMinute.summary}
            </p>
            <MinuteList title="保留事項" items={meetingMinute.pending} empty="保留事項なし" />
            <MinuteList
              title="数値メモ"
              items={meetingMinute.numbers.map((number) => `${number.label}: ${number.value}`)}
              empty="数値なし"
            />
            <ComplianceFindingList findings={meetingMinute.complianceFindings} />
          </div>
        ) : (
          <p className="text-sm text-zinc-600">まだ生成されていません。</p>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-400">保存済み call / transcript</h2>
          <span className="text-xs text-zinc-600">{savedCalls.length} calls</span>
        </div>
        {savedCalls.length === 0 ? (
          <p className="text-sm text-zinc-600">保存済み call はまだありません。</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            <ul className="space-y-2">
              {savedCalls.slice(0, 20).map((call) => (
                <li key={call.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedCallId(call.id)}
                    className={`w-full rounded border p-3 text-left text-xs ${
                      selectedCallId === call.id
                        ? 'border-zinc-500 bg-zinc-900 text-zinc-100'
                        : 'border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:bg-zinc-900/60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono">{call.id.slice(0, 8)}</span>
                      <span>{call.status}</span>
                    </div>
                    <div className="mt-2 text-zinc-500">
                      {call.source} / {call.industry} / {call.productId}
                    </div>
                    <div className="mt-1 text-zinc-600">
                      tenant {call.tenantId.slice(0, 8)} / org {call.organizationId.slice(0, 8)}
                    </div>
                    <div className="mt-1 text-zinc-600">
                      consent {call.recordingConsent.status} /{' '}
                      {call.recordingConsent.method ?? '未記録'}
                    </div>
                    <div className="mt-1 text-zinc-600">
                      {new Date(call.startedAt).toLocaleString('ja-JP')}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="mb-4">
                <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                  imported audio
                </div>
                {audioAssets.length === 0 ? (
                  <p className="text-xs text-zinc-600">この call の音声ファイルは未登録です。</p>
                ) : (
                  <ul className="space-y-2">
                    {audioAssets.map((asset) => (
                      <li key={asset.id} className="rounded bg-zinc-900/70 p-3 text-xs">
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
              </div>
              <div className="mb-4">
                <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">stt jobs</div>
                {sttJobs.length === 0 ? (
                  <p className="text-xs text-zinc-600">この call の STT job は未作成です。</p>
                ) : (
                  <ul className="space-y-2">
                    {sttJobs.map((job) => (
                      <li key={job.id} className="rounded bg-zinc-900/70 p-3 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-zinc-400">{job.id.slice(0, 8)}</span>
                          <span className="rounded bg-zinc-950 px-2 py-0.5 text-zinc-300">
                            {job.status}
                          </span>
                        </div>
                        <div className="mt-1 text-zinc-500">
                          {job.provider} / asset {job.audioAssetId.slice(0, 8)}
                        </div>
                        <button
                          type="button"
                          disabled={job.status === 'running' || job.status === 'completed'}
                          onClick={() => void runSttJob(job.id)}
                          className="mt-2 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          STT実行
                        </button>
                        {job.errorMessage && (
                          <div className="mt-1 text-overlay-objection">{job.errorMessage}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                saved transcript
              </div>
              {savedTranscripts.length === 0 ? (
                <p className="text-xs text-zinc-600">この call の transcript は未保存です。</p>
              ) : (
                <ul className="space-y-2">
                  {savedTranscripts.map((segment) => (
                    <li key={segment.id} className="rounded bg-zinc-900/70 p-3 text-xs">
                      <span className="mr-2 text-zinc-500">
                        {segment.isFinal ? 'final' : 'interim'} / {segment.speaker}
                      </span>
                      {segment.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">商談履歴</h2>
        {props.objectionHistory.length === 0 ? (
          <p className="text-sm text-zinc-600">このセッションではまだ反論を検知していません。</p>
        ) : (
          <ul className="space-y-3">
            {props.objectionHistory.map((item) => (
              <li key={item.objection.id} className="rounded border border-zinc-800 bg-zinc-950/40 p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-overlay-objection">
                    {item.response?.peak ?? item.objection.type}
                  </span>
                  <span className="text-xs text-zinc-500">
                    confidence {Math.round(item.objection.confidence * 100)}%
                  </span>
                </div>
                <p className="text-sm text-zinc-300">{item.objection.triggerText}</p>
                {item.response && (
                  <ul className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                    {item.response.summary.slice(0, 3).map((line) => (
                      <li key={line} className="rounded bg-zinc-900 p-2 text-zinc-400">
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">直近 transcript</h2>
        {props.recentTranscripts.length === 0 ? (
          <p className="text-sm text-zinc-600">未受信</p>
        ) : (
          <ul className="space-y-2">
            {props.recentTranscripts.map((transcript, index) => (
              <li key={`${transcript.startMs}-${index}`} className="rounded border border-zinc-800 p-3 text-xs">
                <span className="mr-2 text-zinc-500">
                  {transcript.isFinal ? 'final' : 'interim'} / {transcript.speaker}
                </span>
                {transcript.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ComplianceFindingList(props: {
  findings: MeetingMinute['complianceFindings'];
}): JSX.Element {
  return (
    <div>
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">コンプラレビュー</div>
      {props.findings.length === 0 ? (
        <p className="text-xs text-zinc-600">検知なし</p>
      ) : (
        <ul className="space-y-2">
          {props.findings.map((finding) => (
            <li
              key={finding.id}
              className="rounded border border-overlay-objection/40 bg-overlay-objection/10 p-3 text-xs"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="rounded bg-zinc-900 px-2 py-0.5 text-overlay-objection">
                  {finding.severity}
                </span>
                <span className="text-zinc-500">{finding.ruleType}</span>
              </div>
              <div className="text-zinc-200">{finding.quotedText}</div>
              <div className="mt-1 text-zinc-500">{finding.reason}</div>
              <div className="mt-2 text-overlay-warning">{finding.recommendedAction}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MinuteList(props: { title: string; items: string[]; empty: string }): JSX.Element {
  return (
    <div>
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">{props.title}</div>
      {props.items.length === 0 ? (
        <p className="text-xs text-zinc-600">{props.empty}</p>
      ) : (
        <ul className="space-y-1 text-xs text-zinc-400">
          {props.items.map((item) => (
            <li key={item} className="rounded bg-zinc-900 px-3 py-2">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewPanel(): JSX.Element {
  const [reviewTasks, setReviewTasks] = useState<ReviewTask[]>([]);

  useEffect(() => {
    void window.api.reviews.list().then(setReviewTasks);
  }, []);

  const updateStatus = async (
    taskId: string,
    status: ReviewTaskStatus,
  ): Promise<void> => {
    const task = await window.api.reviews.updateStatus(taskId, status);
    setReviewTasks((current) =>
      current.map((candidate) => (candidate.id === task.id ? task : candidate)),
    );
  };

  const openTasks = reviewTasks.filter((task) => task.status === 'open');

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-800 p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-zinc-400">管理者レビュー</h2>
            <p className="mt-1 text-xs text-zinc-500">
              コンプラ検知から自動作成された要確認案件を処理します。
            </p>
          </div>
          <div className="rounded bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            open {openTasks.length} / total {reviewTasks.length}
          </div>
        </div>

        {reviewTasks.length === 0 ? (
          <p className="rounded border border-zinc-800 p-3 text-sm text-zinc-600">
            要レビュー案件はまだありません。
          </p>
        ) : (
          <ul className="space-y-3">
            {reviewTasks.map((task) => (
              <li
                key={task.id}
                className="rounded border border-zinc-800 bg-zinc-950/40 p-4 text-sm"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-zinc-200">{task.title}</span>
                    <span className="rounded bg-overlay-objection/15 px-2 py-0.5 text-xs text-overlay-objection">
                      {task.severity}
                    </span>
                    <span className="rounded bg-zinc-900 px-2 py-0.5 text-xs text-zinc-500">
                      {reviewStatusLabel(task.status)}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-600">
                    {new Date(task.createdAt).toLocaleString('ja-JP')}
                  </span>
                </div>
                <blockquote className="rounded border border-zinc-800 bg-zinc-900/60 p-3 text-zinc-200">
                  {task.quotedText}
                </blockquote>
                <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                  <div className="rounded bg-zinc-900/70 p-3 text-zinc-400">
                    <div className="mb-1 text-zinc-600">検知理由</div>
                    {task.reason}
                  </div>
                  <div className="rounded bg-zinc-900/70 p-3 text-overlay-warning">
                    <div className="mb-1 text-zinc-600">推奨対応</div>
                    {task.recommendedAction}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <ReviewActionButton
                    disabled={task.status === 'approved'}
                    onClick={() => void updateStatus(task.id, 'approved')}
                  >
                    問題なし
                  </ReviewActionButton>
                  <ReviewActionButton
                    disabled={task.status === 'training_required'}
                    onClick={() => void updateStatus(task.id, 'training_required')}
                  >
                    要教育
                  </ReviewActionButton>
                  <ReviewActionButton
                    disabled={task.status === 'escalated'}
                    onClick={() => void updateStatus(task.id, 'escalated')}
                  >
                    重大確認
                  </ReviewActionButton>
                  <ReviewActionButton
                    disabled={task.status === 'dismissed'}
                    onClick={() => void updateStatus(task.id, 'dismissed')}
                  >
                    誤検知
                  </ReviewActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ReviewActionButton(props: {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {props.children}
    </button>
  );
}

function reviewStatusLabel(status: ReviewTaskStatus): string {
  switch (status) {
    case 'open':
      return '未確認';
    case 'approved':
      return '問題なし';
    case 'dismissed':
      return '誤検知';
    case 'training_required':
      return '要教育';
    case 'escalated':
      return '重大確認';
  }
}

function TasksPanel(): JSX.Element {
  const [tasks, setTasks] = useState<ActionItemTask[]>([]);
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState<TaskOwner>('own');

  useEffect(() => {
    void window.api.tasks.list().then(setTasks);
  }, []);

  const addTask = async (): Promise<void> => {
    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      return;
    }
    const task = await window.api.tasks.create(owner, trimmedDescription);
    setTasks((current) => [task, ...current]);
    setDescription('');
  };

  const toggleTask = async (taskId: string, completed: boolean): Promise<void> => {
    const task = await window.api.tasks.complete(taskId, completed);
    setTasks((current) => current.map((candidate) => (candidate.id === task.id ? task : candidate)));
  };

  return (
    <div className="rounded-lg border border-zinc-800 p-5">
      <h2 className="mb-3 text-sm font-medium text-zinc-400">タスク</h2>
      <p className="mb-4 text-xs text-zinc-500">
        議事録生成前でも、商談中に手動タスクを仮置きできます。
      </p>
      <div className="grid gap-2 md:grid-cols-[160px_1fr_auto]">
        <select
          aria-label="タスク担当"
          value={owner}
          onChange={(event) => setOwner(event.currentTarget.value as TaskOwner)}
          className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
        >
          <option value="own">自社</option>
          <option value="customer">顧客</option>
          <option value="joint">共同</option>
        </select>
        <input
          aria-label="タスク内容"
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
          className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          placeholder="例: 次回までに費用対効果の資料を送る"
        />
        <button
          type="button"
          onClick={() => void addTask()}
          className="rounded bg-zinc-100 px-4 py-2 text-sm text-zinc-900 disabled:opacity-40"
          disabled={!description.trim()}
        >
          追加
        </button>
      </div>

      <div className="mt-4">
        {tasks.length === 0 ? (
          <p className="rounded border border-zinc-800 p-3 text-sm text-zinc-600">未登録</p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="flex items-center justify-between gap-3 rounded border border-zinc-800 p-3 text-sm"
              >
                <button
                  type="button"
                  onClick={() => void toggleTask(task.id, !task.completed)}
                  className={`text-left ${task.completed ? 'text-zinc-600 line-through' : 'text-zinc-200'}`}
                >
                  <span className="mr-2 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                    {ownerLabel(task.owner)}
                  </span>
                  {task.description}
                </button>
                <span className={task.completed ? 'text-overlay-success' : 'text-zinc-600'}>
                  {task.completed ? '完了' : '未完了'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function KnowledgePanel(props: { productId: ProductId }): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeEntry[]>([]);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [objectionType, setObjectionType] = useState('price');
  const [trigger, setTrigger] = useState('');
  const [response, setResponse] = useState('');

  useEffect(() => {
    void window.api.knowledge.list(props.productId).then(setEntries);
  }, [props.productId]);

  const search = async (): Promise<void> => {
    if (!query.trim()) return;
    setResults(await window.api.knowledge.search(query, props.productId, 5));
  };

  const createEntry = async (): Promise<void> => {
    if (!trigger.trim() || !response.trim()) {
      return;
    }
    const entry = await window.api.knowledge.create({
      productId: props.productId,
      objectionType,
      trigger,
      response,
      reasoning: 'ローカル登録',
      riskFlags: [],
    });
    setEntries((current) => [entry, ...current]);
    setTrigger('');
    setResponse('');
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">ナレッジ登録</h2>
        <div className="grid gap-2 md:grid-cols-[140px_1fr]">
          <input
            aria-label="反論タイプ"
            value={objectionType}
            onChange={(event) => setObjectionType(event.currentTarget.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
          <input
            aria-label="反論トリガー"
            value={trigger}
            onChange={(event) => setTrigger(event.currentTarget.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
            placeholder="例: 価格が高い"
          />
        </div>
        <textarea
          aria-label="切り返し"
          value={response}
          onChange={(event) => setResponse(event.currentTarget.value)}
          className="mt-2 min-h-24 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          placeholder="切り返しスクリプト"
        />
        <button
          type="button"
          onClick={() => void createEntry()}
          className="mt-2 rounded bg-zinc-100 px-4 py-2 text-sm text-zinc-900 disabled:opacity-40"
          disabled={!trigger.trim() || !response.trim()}
        >
          登録
        </button>
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">ナレッジ検索</h2>
        <div className="flex gap-2">
          <input
            aria-label="ナレッジ検索"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
            placeholder="例: 価格が高い"
          />
          <button
            type="button"
            onClick={() => void search()}
            className="rounded bg-zinc-100 px-4 py-2 text-sm text-zinc-900"
          >
            検索
          </button>
        </div>
        {results.length > 0 && <KnowledgeEntryList entries={results} title="検索結果" />}
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">ローカルナレッジ</h2>
        {entries.length === 0 ? (
          <p className="text-sm text-zinc-600">未登録</p>
        ) : (
          <KnowledgeEntryList entries={entries} title="登録済み" />
        )}
      </div>
    </div>
  );
}

function KnowledgeEntryList(props: {
  entries: KnowledgeEntry[];
  title: string;
}): JSX.Element {
  return (
    <div className="mt-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">{props.title}</div>
      <ul className="space-y-2">
        {props.entries.map((entry) => (
          <li key={entry.id} className="rounded border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="mb-1 text-xs text-overlay-objection">{entry.objectionType}</div>
            <div className="text-sm text-zinc-200">{entry.trigger}</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">{entry.response}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ownerLabel(owner: TaskOwner): string {
  if (owner === 'own') {
    return '自社';
  }
  if (owner === 'customer') {
    return '顧客';
  }
  return '共同';
}

function PermissionRow(props: {
  label: string;
  granted: boolean | undefined;
  onRequest: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between rounded border border-zinc-800 p-3">
      <span>{props.label}</span>
      {props.granted ? (
        <span className="text-overlay-success">✓ 許可済み</span>
      ) : (
        <button
          type="button"
          onClick={props.onRequest}
          className="rounded bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700"
        >
          リクエスト
        </button>
      )}
    </div>
  );
}
