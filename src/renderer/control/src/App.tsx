import { useEffect, useState } from 'react';
import type {
  AppSettings,
  AudioCaptureStatus,
  CallState,
  ConnectionState,
  PermissionState,
  ProductId,
  Transcript,
} from '@shared/types';

const PRODUCTS: { id: ProductId; label: string }[] = [
  { id: 'real_estate', label: '不動産' },
  { id: 'kenko_keiei', label: '健康経営優良法人' },
  { id: 'hojokin', label: '補助金助成金' },
];

const NAV_ITEMS = ['ダッシュボード', '商談履歴', 'ナレッジ', 'タスク', '設定'] as const;
type NavItem = (typeof NAV_ITEMS)[number];

const SECRET_KEYS = [
  { key: 'deepgram_api_key', label: 'Deepgram' },
  { key: 'anthropic_api_key', label: 'Anthropic' },
  { key: 'cohere_api_key', label: 'Cohere' },
  { key: 'supabase_anon_key', label: 'Supabase anon' },
] as const;

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

  useEffect(() => {
    void window.api.app.getVersion().then(setVersion);
    void window.api.permissions.check().then(setPermissions);
    void refreshAudioStatus();
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
    return () => {
      offPerm();
      offCall();
      offSettings();
      offAudioError();
      offSttError();
      offSttState();
      offInterim();
      offFinal();
    };
  }, []);

  const startCall = async (): Promise<void> => {
    await window.api.call.start(productId);
    await refreshAudioStatus();
  };

  const endCall = async (): Promise<void> => {
    await window.api.call.end();
    await refreshAudioStatus();
  };

  const refreshAudioStatus = async (): Promise<void> => {
    const status = await window.api.audio.getStatus();
    setAudioStatus(status);
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
              onRefreshAudioStatus={refreshAudioStatus}
              onStartCall={startCall}
              onSelectProduct={selectProduct}
              audioError={audioError}
              audioStatus={audioStatus}
              recentTranscripts={recentTranscripts}
              sttError={sttError}
              sttState={sttState}
            />
          )}
          {activeNav === '商談履歴' && <EmptyPanel title="商談履歴" body="議事録生成後の履歴一覧をここに表示します。" />}
          {activeNav === 'ナレッジ' && <KnowledgePanel productId={productId} />}
          {activeNav === 'タスク' && <EmptyPanel title="タスク" body="議事録から抽出した own/customer/joint タスクをここで管理します。" />}
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
  call: CallState;
  permissions: PermissionState | null;
  productId: ProductId;
  onEndCall: () => Promise<void>;
  onRefreshAudioStatus: () => Promise<void>;
  onStartCall: () => Promise<void>;
  onSelectProduct: (productId: ProductId) => Promise<void>;
  recentTranscripts: Transcript[];
  sttError: string | null;
  sttState: ConnectionState;
}): JSX.Element {
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

      <div className="rounded-lg border border-zinc-800 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-400">音声 / STT 診断</h2>
          <button
            type="button"
            onClick={() => void props.onRefreshAudioStatus()}
            className="rounded bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700"
          >
            更新
          </button>
        </div>
        <div className="grid gap-3 text-sm md:grid-cols-3">
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
        <div className="mt-3 space-y-1 text-xs text-zinc-500">
          <div>module: {props.audioStatus?.nativeModule.modulePath ?? '-'}</div>
          {props.audioStatus?.nativeModule.error && (
            <div className="text-overlay-objection">{props.audioStatus.nativeModule.error}</div>
          )}
          {props.audioError && <div className="text-overlay-objection">Audio: {props.audioError}</div>}
          {props.sttError && <div className="text-overlay-objection">STT: {props.sttError}</div>}
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

function StatusTile(props: { label: string; value: string; ok: boolean }): JSX.Element {
  return (
    <div className="rounded border border-zinc-800 p-3">
      <div className="text-xs text-zinc-500">{props.label}</div>
      <div className={props.ok ? 'text-overlay-success' : 'text-zinc-400'}>{props.value}</div>
    </div>
  );
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

function KnowledgePanel(props: { productId: ProductId }): JSX.Element {
  const [query, setQuery] = useState('');
  const [resultCount, setResultCount] = useState<number | null>(null);

  const search = async (): Promise<void> => {
    if (!query.trim()) return;
    const results = await window.api.knowledge.search(query, props.productId, 5);
    setResultCount(results.length);
  };

  return (
    <div className="rounded-lg border border-zinc-800 p-5">
      <h2 className="mb-3 text-sm font-medium text-zinc-400">ナレッジ検索</h2>
      <div className="flex gap-2">
        <input
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
      {resultCount !== null && (
        <p className="mt-3 text-sm text-zinc-500">検索結果: {resultCount}件</p>
      )}
    </div>
  );
}

function EmptyPanel(props: { title: string; body: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 p-5">
      <h2 className="mb-2 text-sm font-medium text-zinc-400">{props.title}</h2>
      <p className="text-sm text-zinc-500">{props.body}</p>
    </div>
  );
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
