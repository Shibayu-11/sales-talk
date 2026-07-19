import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AppSettings,
  AnthropicDiagnosticResult,
  ActionItemTask,
  AuditLogEntry,
  AuditIntegrityResult,
  AuditLogFilter,
  AudioCaptureStatus,
  CallState,
  CloudActionTokenResult,
  CloudflareConnectionStatus,
  CloudOrganization,
  CloudOrganizationUser,
  ConnectionState,
  ComplianceRule,
  ComplianceRuleType,
  ComplianceSeverity,
  ComplianceRuleSet,
  CurrentUserContext,
  DetectedObjection,
  KnowledgeCandidate,
  KnowledgeEntry,
  ObjectionResponse,
  Organization,
  OrganizationRole,
  OrganizationUser,
  PermissionState,
  ProductId,
  RecoveryRetentionDays,
  RecoverySummary,
  ReviewTask,
  ReviewTaskStatus,
  RecordingConsent,
  TaskOwner,
  Transcript,
} from '@shared/types';
import { UiIcon, type UiIconName } from './components/UiIcon';
import { CallLibrary } from './components/CallLibrary';
import { TranscriptBubbles } from './components/TranscriptBubbles';
import { Onboarding } from './components/Onboarding';
import { formatBytes, PRODUCT_LABELS, SOURCE_LABELS } from './lib/call-view';
import {
  formatMonthLabel,
  summarizeReviewTasksByMonth,
  type MonthlyReviewSummary,
} from './lib/monthly-report';

const PRODUCTS: { id: ProductId; label: string }[] = [
  { id: 'real_estate', label: '不動産' },
  { id: 'kenko_keiei', label: '健康経営優良法人' },
  { id: 'hojokin', label: '補助金助成金' },
];

const NAV_ITEMS: Array<{ label: NavItem; icon: UiIconName }> = [
  { label: 'ダッシュボード', icon: 'dashboard' },
  { label: '商談履歴', icon: 'history' },
  { label: 'レビュー', icon: 'review' },
  { label: '監査ログ', icon: 'audit' },
  { label: 'ルール設定', icon: 'rules' },
  { label: 'ナレッジ', icon: 'knowledge' },
  { label: 'タスク', icon: 'tasks' },
  { label: '設定', icon: 'settings' },
];
type NavItem =
  | 'ダッシュボード'
  | '商談履歴'
  | 'レビュー'
  | '監査ログ'
  | 'ルール設定'
  | 'ナレッジ'
  | 'タスク'
  | '設定';

const SECRET_KEYS = [
  { key: 'deepgram_api_key', label: 'Deepgram' },
  { key: 'anthropic_api_key', label: 'Anthropic' },
  { key: 'cohere_api_key', label: 'Cohere' },
  { key: 'supabase_anon_key', label: 'Supabase anon' },
  { key: 'cloudflare_api_token', label: 'Cloudflare bootstrap token' },
] as const;
const AUDIO_STATUS_POLL_INTERVAL_MS = 1_000;
const RECOVERY_RETENTION_OPTIONS: RecoveryRetentionDays[] = [1, 7, 30];
const AUDIT_ACTION_OPTIONS = [
  'recording.started',
  'recording.consent_captured',
  'checkpoint.degraded',
  'checkpoint.finalized',
  'checkpoint.recovered',
  'checkpoint.discarded',
  'checkpoint.expired',
  'checkpoint.retention_updated',
  'organization.user_role_updated',
  'compliance.rule_set_created',
  'compliance.rule_set_active_updated',
  'compliance.rule_created',
  'compliance.rule_updated',
  'compliance.rule_deleted',
  'compliance.rule_set_submitted',
  'compliance.rule_set_approved',
  'compliance.rule_set_rejected',
  'compliance.rule_set_revision_created',
  'minutes.generated',
  'compliance.finding_detected',
  'review_task.created',
  'review_task.status_updated',
  'call.audio_imported',
  'stt_job.created',
] as const;

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
  const [recordingConsentGranted, setRecordingConsentGranted] = useState(false);
  const [currentUserContext, setCurrentUserContext] = useState<CurrentUserContext | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationUsers, setOrganizationUsers] = useState<OrganizationUser[]>([]);
  const [cloudflareStatus, setCloudflareStatus] = useState<CloudflareConnectionStatus | null>(null);
  const [cloudOrganizations, setCloudOrganizations] = useState<CloudOrganization[]>([]);
  const [cloudOrganizationUsers, setCloudOrganizationUsers] = useState<CloudOrganizationUser[]>([]);
  const [cloudOrganizationError, setCloudOrganizationError] = useState<string | null>(null);
  const [recoverySummaries, setRecoverySummaries] = useState<RecoverySummary[]>([]);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryBusyCallId, setRecoveryBusyCallId] = useState<string | null>(null);
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
    void refreshRecoverySummaries();
    void window.api.dev.isEnabled().then(setDevToolsEnabled);
    void window.api.organizations.getCurrentContext().then(setCurrentUserContext);
    void window.api.organizations.list().then(setOrganizations);
    void window.api.organizations.listUsers().then(setOrganizationUsers);
    void window.api.cloudflare.getStatus().then((status) => {
      setCloudflareStatus(status);
      if (status.authenticated) {
        void refreshCloudOrganizationUsers();
      }
    });
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
    const result = await window.api.call.start(productId, createRealtimeConsent());
    if (result.ok) {
      setRecordingConsentGranted(false);
    }
    await refreshAudioStatus();
    await refreshRecoverySummaries();
  };

  const startAudioDiagnostic = async (): Promise<void> => {
    setAudioError(null);
    setSttError(null);
    const result = await window.api.audio.start(createRealtimeConsent());
    if (result.ok) {
      setRecordingConsentGranted(false);
    }
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

  const saveAnthropicKey = async (value: string): Promise<void> => {
    await window.api.secrets.set('anthropic_api_key', value);
    await refreshSecretStatus();
  };

  const completeOnboarding = async (): Promise<void> => {
    await window.api.settings.set({ onboardingCompletedAt: new Date().toISOString() });
    setSettings(await window.api.settings.get());
  };

  const endCall = async (): Promise<void> => {
    await window.api.call.end();
    await refreshAudioStatus();
    await refreshRecoverySummaries();
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

  const refreshRecoverySummaries = async (): Promise<void> => {
    try {
      setRecoverySummaries(await window.api.recovery.list());
      setRecoveryError(null);
    } catch (error) {
      setRecoveryError(safeRecoveryErrorMessage(error));
    }
  };

  const runRecoveryOperation = async (
    callId: string,
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    setRecoveryBusyCallId(callId);
    setRecoveryError(null);
    try {
      await operation();
      await refreshRecoverySummaries();
    } catch (error) {
      setRecoveryError(safeRecoveryErrorMessage(error));
    } finally {
      setRecoveryBusyCallId(null);
    }
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

  const updateOrganizationUserRole = async (
    membershipId: string,
    role: OrganizationRole,
  ): Promise<void> => {
    const updated = await window.api.organizations.updateUserRole(membershipId, role);
    setOrganizationUsers((current) =>
      current.map((user) => (user.membershipId === updated.membershipId ? updated : user)),
    );
  };

  const refreshCloudOrganizationUsers = async (): Promise<void> => {
    try {
      const [organizationsResult, usersResult] = await Promise.all([
        window.api.cloudflare.listOrganizations(),
        window.api.cloudflare.listUsers(),
      ]);
      setCloudOrganizations(organizationsResult);
      setCloudOrganizationUsers(usersResult);
      setCloudOrganizationError(null);
    } catch (error) {
      setCloudOrganizations([]);
      setCloudOrganizationUsers([]);
      setCloudOrganizationError(errorMessage(error));
    }
  };

  const updateCloudflareStatus = (status: CloudflareConnectionStatus): void => {
    setCloudflareStatus(status);
    if (status.authenticated) {
      void refreshCloudOrganizationUsers();
    } else {
      setCloudOrganizations([]);
      setCloudOrganizationUsers([]);
    }
  };

  // Show onboarding until settings load and confirm it was completed. Guard on
  // settings !== null so the overlay doesn't flash before the first load.
  const showOnboarding = settings !== null && settings.onboardingCompletedAt === null;

  return (
    <div className="flex min-h-screen flex-col">
      {showOnboarding && (
        <Onboarding
          permissions={permissions}
          anthropicKeyConfigured={Boolean(secretStatus.anthropic_api_key)}
          selectedProductId={settings?.selectedProductId ?? null}
          onRequestScreen={requestScreenPermission}
          onRequestMicrophone={requestMicrophonePermission}
          onSaveAnthropicKey={saveAnthropicKey}
          onSelectProduct={selectProduct}
          onComplete={completeOnboarding}
        />
      )}
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <h1 className="text-lg font-semibold">SalesTalk</h1>
        <span className="text-xs text-zinc-500">v{version}</span>
      </header>

      <main className="grid flex-1 grid-cols-[260px_1fr]">
        <nav className="border-r border-zinc-800 p-4 text-sm">
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => setActiveNav(item.label)}
                className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left ${
                  activeNav === item.label ? 'bg-zinc-800 text-zinc-100' : 'hover:bg-zinc-800/60'
                }`}
              >
                <UiIcon name={item.icon} className="h-4 w-4 shrink-0 text-zinc-500" />
                <span>{item.label}</span>
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
              sttProviderMode={settings?.sttProviderMode ?? 'local_first'}
              devToolsEnabled={devToolsEnabled}
              currentObjection={currentObjection}
              currentResponse={currentResponse}
              recentTranscripts={recentTranscripts}
              recordingConsentGranted={recordingConsentGranted}
              onRecordingConsentChange={setRecordingConsentGranted}
              sttError={sttError}
              sttState={sttState}
              recoverySummaries={recoverySummaries}
              recoveryError={recoveryError}
              recoveryBusyCallId={recoveryBusyCallId}
              canManageRecovery={
                currentUserContext?.permissions.includes('checkpoints:manage') ?? false
              }
              onRecoverCheckpoint={(callId) =>
                runRecoveryOperation(callId, () => window.api.recovery.recover(callId))
              }
              onDiscardCheckpoint={(callId) =>
                runRecoveryOperation(callId, () => window.api.recovery.discard(callId))
              }
              onSetCheckpointRetention={(callId, retentionDays) =>
                runRecoveryOperation(callId, () =>
                  window.api.recovery.setRetention(callId, retentionDays),
                )
              }
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
          {activeNav === '監査ログ' && <AuditLogPanel />}
          {activeNav === 'ルール設定' && (
            <ComplianceRuleSetsPanel
              currentUserContext={currentUserContext}
              productId={productId}
            />
          )}
          {activeNav === 'ナレッジ' && (
            <KnowledgePanel productId={productId} currentUserContext={currentUserContext} />
          )}
          {activeNav === 'タスク' && <TasksPanel />}
          {activeNav === '設定' && (
            <SettingsPanel
              permissions={permissions}
              secretInputs={secretInputs}
              secretStatus={secretStatus}
              settings={settings}
              currentUserContext={currentUserContext}
              organizations={organizations}
              organizationUsers={organizationUsers}
              cloudOrganizations={cloudOrganizations}
              cloudOrganizationUsers={cloudOrganizationUsers}
              cloudOrganizationError={cloudOrganizationError}
              cloudflareStatus={cloudflareStatus}
              onRefreshCloudflare={async () => {
                const status = await window.api.cloudflare.getStatus();
                updateCloudflareStatus(status);
              }}
              onRefreshCloudOrganizationUsers={refreshCloudOrganizationUsers}
              onCloudflareStatusChange={updateCloudflareStatus}
              onUpdateUserRole={updateOrganizationUserRole}
              onSettingsChange={async (patch) => {
                await window.api.settings.set(patch);
                setSettings(await window.api.settings.get());
              }}
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
  recordingConsentGranted: boolean;
  onRecordingConsentChange: (granted: boolean) => void;
  deepgramConfigured: boolean;
  sttProviderMode: AppSettings['sttProviderMode'];
  devToolsEnabled: boolean;
  sttError: string | null;
  sttState: ConnectionState;
  recoverySummaries: RecoverySummary[];
  recoveryError: string | null;
  recoveryBusyCallId: string | null;
  canManageRecovery: boolean;
  onRecoverCheckpoint: (callId: string) => Promise<void>;
  onDiscardCheckpoint: (callId: string) => Promise<void>;
  onSetCheckpointRetention: (
    callId: string,
    retentionDays: RecoveryRetentionDays,
  ) => Promise<void>;
}): JSX.Element {
  const deepgramErrorVisible = Boolean(
    props.sttError &&
      props.deepgramConfigured &&
      !props.sttError.includes('Deepgram API key is not configured'),
  );
  const sttProviderLabel = sttProviderModeLabel(props.sttProviderMode);
  const realtimeAudioActive =
    Boolean(props.audioStatus?.nativeCaptureActive) ||
    props.sttState === 'connecting' ||
    props.sttState === 'connected' ||
    props.sttState === 'reconnecting';
  const callAudioActive = props.call.status === 'in_call' && realtimeAudioActive;
  const audioDiagnosticActive = realtimeAudioActive && !callAudioActive;
  const canStartAudioDiagnostic = Boolean(
    props.permissions?.screen &&
      props.permissions?.microphone &&
      props.recordingConsentGranted &&
      props.call.status !== 'in_call' &&
      !audioDiagnosticActive,
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
          sttProviderMode={props.sttProviderMode}
          permissions={props.permissions}
          sttError={props.sttError}
          onOpenSettings={props.onOpenSettings}
          onRequestMicrophonePermission={props.onRequestMicrophonePermission}
          onRequestScreenPermission={props.onRequestScreenPermission}
        />
        <label className="mb-4 flex items-start gap-2 rounded border border-zinc-800 p-3 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={props.recordingConsentGranted}
            onChange={(event) => props.onRecordingConsentChange(event.currentTarget.checked)}
            className="mt-0.5"
          />
          <span>
            顧客へ録音・文字起こし・コンプライアンス解析の目的を説明し、同意を取得しました。
          </span>
        </label>
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
              disabled={
                !props.permissions?.screen ||
                !props.permissions?.microphone ||
                !props.recordingConsentGranted ||
                audioDiagnosticActive
              }
            >
              通話を開始
            </button>
          )}
          <span className="text-xs text-zinc-500">状態: {props.call.status}</span>
        </div>
      </div>

      <RecoveryCheckpointPanel
        summaries={props.recoverySummaries}
        error={props.recoveryError}
        busyCallId={props.recoveryBusyCallId}
        canManage={props.canManageRecovery}
        onRecover={props.onRecoverCheckpoint}
        onDiscard={props.onDiscardCheckpoint}
        onSetRetention={props.onSetCheckpointRetention}
      />

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
            <span className="rounded bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400">
              {sttProviderLabel}
            </span>
            {props.audioStatusPolling && (
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-overlay-success">
                auto refresh
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {callAudioActive ? (
              <span className="rounded bg-zinc-800 px-3 py-1 text-xs text-overlay-success">
                通話中に自動診断
              </span>
            ) : audioDiagnosticActive ? (
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
        <AudioPreflightPanel report={props.audioStatus?.preflight} />
        <div className="mt-3 space-y-1 text-xs text-zinc-500">
          <div>module: {props.audioStatus?.nativeModule.modulePath ?? '-'}</div>
          {props.audioStatus?.nativeModule.error && (
            <div className="text-overlay-objection">{props.audioStatus.nativeModule.error}</div>
          )}
          {props.audioError && <div className="text-overlay-objection">Audio: {props.audioError}</div>}
          {deepgramErrorVisible && <div className="text-overlay-objection">STT: {props.sttError}</div>}
          {props.sttProviderMode === 'local_first' && (
            <div>
              方針: Apple SpeechAnalyzer ローカル文字起こしを第一候補にし、音声を外部STTへ送信しません。
              Deepgram fallback は設定で明示した場合だけ使います。
            </div>
          )}
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

function RecoveryCheckpointPanel(props: {
  summaries: RecoverySummary[];
  error: string | null;
  busyCallId: string | null;
  canManage: boolean;
  onRecover: (callId: string) => Promise<void>;
  onDiscard: (callId: string) => Promise<void>;
  onSetRetention: (callId: string, retentionDays: RecoveryRetentionDays) => Promise<void>;
}): JSX.Element | null {
  if (props.summaries.length === 0 && !props.error) {
    return null;
  }

  return (
    <div className="rounded-lg border border-overlay-warning/40 bg-overlay-warning/10 p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-overlay-warning">未完了録音</h2>
          <p className="mt-1 text-xs text-zinc-400">
            暗号化 checkpoint からローカル WAV を復旧できます。鍵やファイルパスは画面に表示しません。
          </p>
        </div>
        <span className="rounded bg-zinc-950 px-2 py-1 text-[11px] text-zinc-400">
          AES-256-GCM
        </span>
      </div>
      {props.error && (
        <div className="mb-3 rounded border border-overlay-objection/40 bg-overlay-objection/10 p-3 text-xs text-overlay-objection">
          {props.error}
        </div>
      )}
      {!props.canManage && props.summaries.length > 0 && (
        <div className="mb-3 rounded border border-zinc-700 bg-zinc-950/70 p-3 text-xs text-zinc-400">
          監査ロールは未完了録音を閲覧できますが、復旧・破棄・保持期限の変更はできません。
        </div>
      )}
      {props.summaries.length === 0 ? (
        <div className="rounded border border-zinc-800 p-3 text-xs text-zinc-500">
          復旧可能な録音はありません。
        </div>
      ) : (
        <ul className="space-y-3">
          {props.summaries.map((summary) => {
            const busy = props.busyCallId === summary.callId;
            const recording = summary.state === 'recording';
            const actionDisabled = busy || recording || !props.canManage;
            return (
              <li key={summary.callId} className="rounded border border-zinc-800 bg-zinc-950/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-zinc-100">
                      {PRODUCT_LABELS[summary.productId]} / {SOURCE_LABELS[summary.source]}
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      call {summary.callId.slice(0, 8)} ・ {recoveryStateLabel(summary.state)} ・{' '}
                      {formatDurationMs(summary.durationMs)}
                      {summary.expired ? ' ・ 保持期限切れ' : ''}
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      checkpoint {summary.chunkCount} chunks ・ speakers{' '}
                      {summary.availableSpeakers.join(', ') || '-'}
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      最終保存 {formatDateTime(summary.lastCheckpointAt)} ・ 保持期限{' '}
                      {formatDateTime(summary.expiresAt)}（{summary.retentionDays}日）
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={actionDisabled || summary.expired}
                      onClick={() => void props.onRecover(summary.callId)}
                      className="rounded bg-overlay-success px-3 py-2 text-xs font-medium text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy ? '処理中' : '復旧'}
                    </button>
                    <button
                      type="button"
                      disabled={actionDisabled}
                      onClick={() => void props.onDiscard(summary.callId)}
                      className="rounded bg-overlay-objection px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      破棄
                    </button>
                    {RECOVERY_RETENTION_OPTIONS.map((days) => (
                      <button
                        key={days}
                        type="button"
                        disabled={busy || !props.canManage}
                        onClick={() =>
                          void props.onSetRetention(summary.callId, days)
                        }
                        className={`rounded px-2 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${
                          summary.retentionDays === days
                            ? 'bg-zinc-600 text-white'
                            : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                        }`}
                      >
                        保持{days}日
                      </button>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
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

function AudioPreflightPanel(props: {
  report: AudioCaptureStatus['preflight'] | undefined;
}): JSX.Element {
  if (!props.report) {
    return (
      <div className="mt-4 rounded border border-zinc-800 bg-zinc-950/40 p-4 text-xs text-zinc-500">
        商談前チェックを取得中です。
      </div>
    );
  }

  const activeChecks = props.report.checks.filter((check) => check.status !== 'pass');
  const actions = Array.from(
    new Set(
      activeChecks
        .map((check) => check.action)
        .filter((action): action is string => action !== null),
    ),
  );
  const fallbackAction =
    props.report.overall === 'go'
      ? 'このまま商談または音声診断を続行できます。'
      : '確認中の項目が解消するまで数秒待ってから再確認してください。';

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-950/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium text-zinc-400">商談前チェック</div>
        <span
          className={`rounded px-2 py-1 text-[11px] font-semibold ${preflightOverallClass(
            props.report.overall,
          )}`}
        >
          {preflightOverallLabel(props.report.overall)}
        </span>
      </div>
      <div className="mt-3 grid gap-3 text-xs md:grid-cols-[1fr_1fr]">
        <div>
          <div className="mb-1 font-medium text-zinc-300">原因</div>
          {activeChecks.length === 0 ? (
            <div className="text-overlay-success">すべての商談前チェックは正常です。</div>
          ) : (
            <ul className="space-y-1">
              {activeChecks.map((check) => (
                <li key={check.id} className="flex gap-2">
                  <span className={preflightCheckStatusClass(check.status)}>
                    {preflightCheckStatusLabel(check.status)}
                  </span>
                  <span className="text-zinc-400">
                    {check.label}: {check.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-1 font-medium text-zinc-300">次アクション</div>
          {actions.length === 0 ? (
            <div className="text-zinc-400">{fallbackAction}</div>
          ) : (
            <ul className="space-y-1 text-zinc-400">
              {actions.map((action) => (
                <li key={action}>・{action}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
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
  sttProviderMode: AppSettings['sttProviderMode'];
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
  const deepgramFallbackRequired =
    props.sttProviderMode === 'deepgram_fallback' || props.sttProviderMode === 'deepgram_only';

  if (
    !permissionMissing &&
    !nativeMissing &&
    !(deepgramFallbackRequired && deepgramMissing) &&
    !props.audioError &&
    !props.sttError
  ) {
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
      {deepgramFallbackRequired && deepgramMissing && (
        <ActionCard
          title="Deepgram fallback key が未設定です"
          body="ローカルSTT非対応時のfallbackを使うには Settings で Deepgram key を保存してください。"
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
      {props.sttError && !(deepgramFallbackRequired && deepgramMissing) && (
        <InlineError label="STT" message={props.sttError} />
      )}
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

function preflightOverallLabel(overall: AudioCaptureStatus['preflight']['overall']): string {
  switch (overall) {
    case 'go':
      return 'GO';
    case 'warning':
      return '要確認';
    case 'blocked':
      return 'BLOCKED';
  }
}

function preflightOverallClass(overall: AudioCaptureStatus['preflight']['overall']): string {
  switch (overall) {
    case 'go':
      return 'bg-overlay-success/20 text-overlay-success';
    case 'warning':
      return 'bg-overlay-warning/20 text-overlay-warning';
    case 'blocked':
      return 'bg-overlay-objection/20 text-overlay-objection';
  }
}

function preflightCheckStatusLabel(
  status: AudioCaptureStatus['preflight']['checks'][number]['status'],
): string {
  switch (status) {
    case 'pass':
      return '正常';
    case 'warning':
      return '要確認';
    case 'blocked':
      return '停止';
    case 'pending':
      return '確認中';
  }
}

function preflightCheckStatusClass(
  status: AudioCaptureStatus['preflight']['checks'][number]['status'],
): string {
  switch (status) {
    case 'pass':
      return 'text-overlay-success';
    case 'warning':
      return 'text-overlay-warning';
    case 'blocked':
      return 'text-overlay-objection';
    case 'pending':
      return 'text-zinc-500';
  }
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

function createRealtimeConsent(): RecordingConsent {
  return {
    status: 'granted',
    method: 'verbal',
    capturedAt: new Date().toISOString(),
    noticeVersion: 'local-v1',
  };
}

function SettingsPanel(props: {
  permissions: PermissionState | null;
  secretInputs: Record<string, string>;
  secretStatus: Record<string, boolean>;
  settings: AppSettings | null;
  currentUserContext: CurrentUserContext | null;
  organizations: Organization[];
  organizationUsers: OrganizationUser[];
  cloudOrganizations: CloudOrganization[];
  cloudOrganizationUsers: CloudOrganizationUser[];
  cloudOrganizationError: string | null;
  cloudflareStatus: CloudflareConnectionStatus | null;
  onRefreshCloudflare: () => Promise<void>;
  onRefreshCloudOrganizationUsers: () => Promise<void>;
  onCloudflareStatusChange: (status: CloudflareConnectionStatus) => void;
  onUpdateUserRole: (membershipId: string, role: OrganizationRole) => Promise<void>;
  onSettingsChange: (patch: Partial<AppSettings>) => Promise<void>;
  onSecretInputChange: (key: string, value: string) => void;
  onSaveSecret: (key: string) => Promise<void>;
}): JSX.Element {
  const [cloudflareEmail, setCloudflareEmail] = useState('agency-admin@example.local');
  const [cloudflarePassword, setCloudflarePassword] = useState('');
  const [cloudflareAuthPending, setCloudflareAuthPending] = useState(false);
  const [cloudToken, setCloudToken] = useState('');
  const [cloudTokenPassword, setCloudTokenPassword] = useState('');
  const [cloudTokenDisplayName, setCloudTokenDisplayName] = useState('');
  const [cloudInviteEmail, setCloudInviteEmail] = useState('');
  const [cloudInviteDisplayName, setCloudInviteDisplayName] = useState('');
  const [cloudInviteRole, setCloudInviteRole] = useState<OrganizationRole>('agent');
  const [cloudInviteOrganizationId, setCloudInviteOrganizationId] = useState('');
  const [cloudAdminPending, setCloudAdminPending] = useState(false);
  const passwordResetPendingMembershipRef = useRef<string | null>(null);
  const [cloudAdminError, setCloudAdminError] = useState<string | null>(null);
  const [oneTimeCloudToken, setOneTimeCloudToken] = useState<CloudActionTokenResult | null>(null);
  const [anthropicDiagnostic, setAnthropicDiagnostic] =
    useState<AnthropicDiagnosticResult | null>(null);
  const [anthropicDiagnosticPending, setAnthropicDiagnosticPending] = useState(false);

  const clearCloudTokenInputs = useCallback((): void => {
    setCloudToken('');
    setCloudTokenPassword('');
    setCloudTokenDisplayName('');
  }, []);

  const clearGeneratedCloudToken = useCallback((): void => {
    setOneTimeCloudToken(null);
  }, []);

  useEffect(() => {
    if (!props.cloudflareStatus?.authenticated) {
      clearCloudTokenInputs();
      clearGeneratedCloudToken();
      setCloudInviteOrganizationId('');
    }
  }, [clearCloudTokenInputs, clearGeneratedCloudToken, props.cloudflareStatus?.authenticated]);

  useEffect(() => {
    if (
      cloudInviteOrganizationId &&
      !props.cloudOrganizations.some((organization) => organization.id === cloudInviteOrganizationId)
    ) {
      setCloudInviteOrganizationId('');
    }
  }, [cloudInviteOrganizationId, props.cloudOrganizations]);

  useEffect(() => {
    if (!oneTimeCloudToken) {
      return undefined;
    }
    const expiresInMs = Date.parse(oneTimeCloudToken.expiresAt) - Date.now();
    if (expiresInMs <= 0) {
      clearGeneratedCloudToken();
      return undefined;
    }
    const timeout = window.setTimeout(clearGeneratedCloudToken, expiresInMs);
    return () => window.clearTimeout(timeout);
  }, [clearGeneratedCloudToken, oneTimeCloudToken]);

  const runCloudflareAuth = async (
    action: (email: string, password: string) => Promise<CloudflareConnectionStatus>,
  ): Promise<void> => {
    setCloudflareAuthPending(true);
    try {
      props.onCloudflareStatusChange(await action(cloudflareEmail, cloudflarePassword));
      setCloudflarePassword('');
    } finally {
      setCloudflareAuthPending(false);
    }
  };

  const runAnthropicDiagnostic = async (): Promise<void> => {
    setAnthropicDiagnosticPending(true);
    try {
      setAnthropicDiagnostic(await window.api.secrets.checkAnthropic());
    } finally {
      setAnthropicDiagnosticPending(false);
    }
  };

  const completeTokenFlow = async (kind: 'invite' | 'password_reset'): Promise<void> => {
    setCloudflareAuthPending(true);
    try {
      const status =
        kind === 'invite'
          ? await window.api.cloudflare.acceptInvitation(
              cloudToken,
              cloudTokenPassword,
              cloudTokenDisplayName.trim() || undefined,
            )
          : await window.api.cloudflare.completePasswordReset(cloudToken, cloudTokenPassword);
      props.onCloudflareStatusChange(status);
      if (status.authenticated) {
        clearCloudTokenInputs();
      }
    } finally {
      setCloudflareAuthPending(false);
    }
  };

  const logoutCloudflare = async (): Promise<void> => {
    setCloudflareAuthPending(true);
    try {
      props.onCloudflareStatusChange(await window.api.cloudflare.logout());
    } catch (error) {
      props.onCloudflareStatusChange({
        apiUrl: props.cloudflareStatus?.apiUrl ?? '-',
        healthy: props.cloudflareStatus?.healthy ?? false,
        authenticated: false,
        error: errorMessage(error),
      });
    } finally {
      setCloudflarePassword('');
      clearCloudTokenInputs();
      clearGeneratedCloudToken();
      setCloudflareAuthPending(false);
    }
  };

  const createCloudInvitation = async (): Promise<void> => {
    setCloudAdminPending(true);
    setCloudAdminError(null);
    try {
      const invitationInput: {
        email: string;
        displayName?: string;
        role: OrganizationRole;
        organizationId?: string;
      } = {
        email: cloudInviteEmail,
        role: cloudInviteRole,
      };
      if (cloudInviteDisplayName.trim()) {
        invitationInput.displayName = cloudInviteDisplayName.trim();
      }
      if (cloudInviteOrganizationId) {
        invitationInput.organizationId = cloudInviteOrganizationId;
      }
      const result = await window.api.cloudflare.createInvitation(invitationInput);
      setOneTimeCloudToken(result);
      setCloudInviteEmail('');
      setCloudInviteDisplayName('');
      await props.onRefreshCloudOrganizationUsers();
    } catch (error) {
      setCloudAdminError(errorMessage(error));
    } finally {
      setCloudAdminPending(false);
    }
  };

  const issuePasswordReset = async (membershipId: string): Promise<void> => {
    if (passwordResetPendingMembershipRef.current === membershipId) {
      return;
    }
    passwordResetPendingMembershipRef.current = membershipId;
    setCloudAdminPending(true);
    setCloudAdminError(null);
    try {
      setOneTimeCloudToken(await window.api.cloudflare.issuePasswordReset(membershipId));
      await props.onRefreshCloudOrganizationUsers();
    } catch (error) {
      setCloudAdminError(errorMessage(error));
    } finally {
      passwordResetPendingMembershipRef.current = null;
      setCloudAdminPending(false);
    }
  };

  const setCloudMembershipStatus = async (
    membershipId: string,
    status: 'active' | 'disabled',
  ): Promise<void> => {
    setCloudAdminPending(true);
    setCloudAdminError(null);
    try {
      await window.api.cloudflare.setMembershipStatus(membershipId, status);
      await props.onRefreshCloudOrganizationUsers();
    } catch (error) {
      setCloudAdminError(errorMessage(error));
    } finally {
      setCloudAdminPending(false);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-zinc-800 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-zinc-400">Cloudflare接続</h2>
            <div className="mt-2 text-xs text-zinc-500">{props.cloudflareStatus?.apiUrl ?? '-'}</div>
          </div>
          <button
            type="button"
            onClick={() => void props.onRefreshCloudflare()}
            className="rounded bg-zinc-800 px-3 py-2 text-xs"
          >
            接続確認
          </button>
        </div>
        <div className="mt-3 flex gap-2 text-xs">
          <span className={props.cloudflareStatus?.healthy ? 'text-overlay-success' : 'text-overlay-objection'}>
            Worker: {props.cloudflareStatus?.healthy ? '接続済み' : '未接続'}
          </span>
          <span className={props.cloudflareStatus?.authenticated ? 'text-overlay-success' : 'text-zinc-500'}>
            認証: {props.cloudflareStatus?.authenticated ? 'ログイン済み' : '未ログイン'}
          </span>
          {props.cloudflareStatus?.error && <span className="text-zinc-600">{props.cloudflareStatus.error}</span>}
        </div>
        <div className="mt-4 grid gap-3 border-t border-zinc-800 pt-4 md:grid-cols-2">
          <label className="text-xs text-zinc-500">
            メールアドレス
            <input
              type="email"
              value={cloudflareEmail}
              onChange={(event) => setCloudflareEmail(event.currentTarget.value)}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
          </label>
          <label className="text-xs text-zinc-500">
            パスワード（12文字以上）
            <input
              type="password"
              value={cloudflarePassword}
              onChange={(event) => setCloudflarePassword(event.currentTarget.value)}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-200"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={cloudflareAuthPending || cloudflarePassword.length < 12}
            onClick={() => void runCloudflareAuth(window.api.cloudflare.login)}
            className="rounded bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 disabled:opacity-40"
          >
            ログイン
          </button>
          <button
            type="button"
            disabled={cloudflareAuthPending || cloudflarePassword.length < 12}
            onClick={() => void runCloudflareAuth(window.api.cloudflare.bootstrap)}
            className="rounded bg-zinc-800 px-3 py-2 text-xs disabled:opacity-40"
          >
            初回資格情報設定
          </button>
          <button
            type="button"
            disabled={
              cloudflareAuthPending ||
              cloudflarePassword.length < 12 ||
              !props.cloudflareStatus?.authenticated
            }
            onClick={() =>
              void window.api.cloudflare
                .changePassword(cloudflarePassword)
                .then(props.onCloudflareStatusChange)
                .then(() => setCloudflarePassword(''))
            }
            className="rounded bg-zinc-800 px-3 py-2 text-xs disabled:opacity-40"
          >
            パスワード更新
          </button>
          <button
            type="button"
            disabled={cloudflareAuthPending || !props.cloudflareStatus?.authenticated}
            onClick={() => void logoutCloudflare()}
            className="rounded border border-zinc-700 px-3 py-2 text-xs disabled:opacity-40"
          >
            ログアウト
          </button>
        </div>
        <div className="mt-4 border-t border-zinc-800 pt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            メール受信 token
          </h3>
          <p className="mt-1 text-xs text-zinc-600">
            招待メールまたは再設定メールで届いた一回限りの token と新しいパスワードで SaaS セッションを発行します。
            メールには deep link を含めず、アプリへ token を貼り付けます。
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1.4fr_1fr_1fr]">
            <input
              aria-label="Cloudflare action token"
              value={cloudToken}
              onChange={(event) => setCloudToken(event.currentTarget.value)}
              className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
              placeholder="メールで届いた token"
            />
            <input
              aria-label="Cloudflare token password"
              type="password"
              value={cloudTokenPassword}
              onChange={(event) => setCloudTokenPassword(event.currentTarget.value)}
              className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
              placeholder="新しいパスワード"
            />
            <input
              aria-label="Cloudflare invite display name"
              value={cloudTokenDisplayName}
              onChange={(event) => setCloudTokenDisplayName(event.currentTarget.value)}
              className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
              placeholder="表示名（招待時のみ任意）"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={
                cloudflareAuthPending ||
                cloudToken.trim().length < 32 ||
                cloudTokenPassword.length < 12
              }
              onClick={() => void completeTokenFlow('invite')}
              className="rounded bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 disabled:opacity-40"
            >
              招待を承諾
            </button>
            <button
              type="button"
              disabled={
                cloudflareAuthPending ||
                cloudToken.trim().length < 32 ||
                cloudTokenPassword.length < 12
              }
              onClick={() => void completeTokenFlow('password_reset')}
              className="rounded bg-zinc-800 px-3 py-2 text-xs disabled:opacity-40"
            >
              パスワード再設定を完了
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-zinc-400">Cloudflare SaaS ユーザー管理</h2>
            <p className="mt-1 text-xs text-zinc-600">
              招待・停止・再設定メールは Worker/D1 側のアカウントライフサイクルを操作します。
              email mode では管理者画面に raw token を表示しません。
            </p>
          </div>
          <button
            type="button"
            disabled={!props.cloudflareStatus?.authenticated}
            onClick={() => void props.onRefreshCloudOrganizationUsers()}
            className="rounded bg-zinc-800 px-3 py-2 text-xs disabled:opacity-40"
          >
            SaaSユーザー更新
          </button>
        </div>
        {props.cloudflareStatus?.authenticated ? (
          <>
            <div className="mt-4 grid gap-2 md:grid-cols-[1.2fr_1fr_160px_1fr_auto]">
              <input
                aria-label="Cloudflare invitation email"
                type="email"
                value={cloudInviteEmail}
                onChange={(event) => setCloudInviteEmail(event.currentTarget.value)}
                className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
                placeholder="招待メールアドレス"
              />
              <input
                aria-label="Cloudflare invitation display name"
                value={cloudInviteDisplayName}
                onChange={(event) => setCloudInviteDisplayName(event.currentTarget.value)}
                className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
                placeholder="表示名"
              />
              <select
                aria-label="Cloudflare invitation role"
                value={cloudInviteRole}
                onChange={(event) => setCloudInviteRole(event.currentTarget.value as OrganizationRole)}
                className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
              >
                <option value="agency_admin">agency_admin</option>
                <option value="manager">manager</option>
                <option value="agent">agent</option>
                <option value="auditor">auditor</option>
                <option value="insurer_admin">insurer_admin</option>
              </select>
              <select
                aria-label="Cloudflare invitation organization"
                value={cloudInviteOrganizationId}
                onChange={(event) => setCloudInviteOrganizationId(event.currentTarget.value)}
                className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
              >
                <option value="">自組織</option>
                {props.cloudOrganizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={cloudAdminPending || !cloudInviteEmail.includes('@')}
                onClick={() => void createCloudInvitation()}
                className="rounded bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 disabled:opacity-40"
              >
                招待メール送信
              </button>
            </div>
            {oneTimeCloudToken && (
              oneTimeCloudToken.mode === 'email' ? (
                <div className="mt-4 rounded border border-emerald-500/40 bg-emerald-950/20 p-3 text-xs">
                  <div className="font-medium text-emerald-100">送信受付済み</div>
                  <p className="mt-2 text-zinc-400">
                    {oneTimeCloudToken.type === 'invite' ? '招待' : '再設定'}メールを
                    {oneTimeCloudToken.recipient.emailMasked} 宛に受付しました。最終到達はメールログで確認してください。
                  </p>
                  <div className="mt-2 font-mono text-[11px] text-zinc-500">
                    deliveryId: {oneTimeCloudToken.deliveryId}
                  </div>
                  {oneTimeCloudToken.trackingDegraded && (
                    <p className="mt-2 text-overlay-warning">
                      Cloudflare への受付後に D1 tracking 更新が失敗しました。token は画面に表示していません。
                    </p>
                  )}
                </div>
              ) : (
                <div className="mt-4 rounded border border-overlay-warning/40 bg-amber-950/20 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <span className="font-medium text-amber-100">
                        {oneTimeCloudToken.type === 'invite' ? '招待 token' : '再設定 token'}
                      </span>
                      <span className="ml-2 text-zinc-500">
                        期限: {new Date(oneTimeCloudToken.expiresAt).toLocaleString('ja-JP')}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(oneTimeCloudToken.token)}
                      className="rounded bg-zinc-100 px-3 py-1 text-[11px] font-medium text-zinc-900"
                    >
                      コピー
                    </button>
                  </div>
                  <div className="mt-2 break-all rounded bg-zinc-950 p-2 font-mono text-[11px] text-amber-100">
                    {oneTimeCloudToken.token}
                  </div>
                  <p className="mt-2 text-zinc-500">
                    manual_beta の bearer token は再表示されず、期限到来で自動消去されます。
                    見た管理者は受信者になりすませるため本番では使用しません。
                  </p>
                </div>
              )
            )}
            {(cloudAdminError || props.cloudOrganizationError) && (
              <div className="mt-3 rounded border border-overlay-objection/40 bg-red-950/20 p-3 text-xs text-red-100">
                {cloudAdminError ?? props.cloudOrganizationError}
              </div>
            )}
            <div className="mt-4 overflow-hidden rounded border border-zinc-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-900 text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">ユーザー</th>
                    <th className="px-3 py-2">状態</th>
                    <th className="px-3 py-2">ロール</th>
                    <th className="px-3 py-2">組織</th>
                    <th className="px-3 py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {props.cloudOrganizationUsers.map((user) => (
                    <tr key={user.membershipId} className="border-t border-zinc-800">
                      <td className="px-3 py-2">
                        {user.displayName}
                        <div className="text-zinc-600">{user.email}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={cloudMembershipStatusClass(user.status)}>
                          {user.status}
                        </span>
                        {user.mustResetPassword && (
                          <div className="mt-1 text-[11px] text-overlay-warning">
                            reset required
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">{user.role}</td>
                      <td className="px-3 py-2">
                        {user.organizationName}
                        <div className="font-mono text-zinc-600">{user.organizationId.slice(0, 8)}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          {user.status === 'disabled' ? (
                            <button
                              type="button"
                              disabled={cloudAdminPending}
                              onClick={() => void setCloudMembershipStatus(user.membershipId, 'active')}
                              className="rounded bg-zinc-100 px-2 py-1 text-[11px] text-zinc-900 disabled:opacity-40"
                            >
                              有効化
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={cloudAdminPending || user.status === 'invited'}
                              onClick={() => void setCloudMembershipStatus(user.membershipId, 'disabled')}
                              className="rounded bg-overlay-objection px-2 py-1 text-[11px] text-white disabled:opacity-40"
                            >
                              停止
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={cloudAdminPending || user.status !== 'active' || !user.hasCredential}
                            onClick={() => void issuePasswordReset(user.membershipId)}
                            className="rounded bg-zinc-800 px-2 py-1 text-[11px] disabled:opacity-40"
                          >
                            再設定メール送信
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {props.cloudOrganizationUsers.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-zinc-600">
                        SaaS ユーザーは未取得です。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="mt-4 rounded border border-zinc-800 p-4 text-sm text-zinc-600">
            ログイン後に招待・停止・パスワード再設定を操作できます。
          </div>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">ローカル組織・ユーザー権限</h2>
        <p className="mb-3 text-xs text-zinc-600">
          この表は端末内のローカル権限モデルです。Cloudflare SaaS の管理ユーザーとは別です。
        </p>
        <div className="grid gap-4 text-sm md:grid-cols-2">
          <div className="rounded border border-zinc-800 p-3">
            <div className="text-xs text-zinc-500">現在の利用者</div>
            <div className="mt-1 font-medium">{props.currentUserContext?.user.displayName ?? '-'}</div>
            <div className="text-xs text-zinc-500">
              {props.currentUserContext?.organization.name ?? '-'} /{' '}
              {props.currentUserContext?.membership.role ?? '-'}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {props.currentUserContext?.permissions.map((permission) => (
                <span key={permission} className="rounded bg-zinc-800 px-2 py-0.5 text-[11px]">
                  {permission}
                </span>
              ))}
            </div>
          </div>
          <div className="rounded border border-zinc-800 p-3">
            <div className="text-xs text-zinc-500">会社階層</div>
            <ul className="mt-2 space-y-2">
              {props.organizations.map((organization) => (
                <li key={organization.id}>
                  <span className="font-medium">{organization.name}</span>
                  <span className="ml-2 text-xs text-zinc-500">{organization.type}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-4 overflow-hidden rounded border border-zinc-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-900 text-zinc-500">
              <tr>
                <th className="px-3 py-2">ユーザー</th>
                <th className="px-3 py-2">ロール</th>
                <th className="px-3 py-2">組織</th>
              </tr>
            </thead>
            <tbody>
              {props.organizationUsers.map((user) => (
                <tr key={user.membershipId} className="border-t border-zinc-800">
                  <td className="px-3 py-2">
                    {user.displayName}
                    <div className="text-zinc-600">{user.email}</div>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      aria-label={`${user.displayName} role`}
                      value={user.role}
                      disabled={
                        user.membershipId === props.currentUserContext?.membership.id ||
                        (props.currentUserContext?.membership.role !== 'insurer_admin' &&
                          user.organizationId !== props.currentUserContext?.organization.id)
                      }
                      onChange={(event) =>
                        void props.onUpdateUserRole(
                          user.membershipId,
                          event.currentTarget.value as OrganizationRole,
                        )
                      }
                      className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <option value="insurer_admin">insurer_admin</option>
                      <option value="agency_admin">agency_admin</option>
                      <option value="manager">manager</option>
                      <option value="agent">agent</option>
                      <option value="auditor">auditor</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 font-mono text-zinc-500">
                    {user.organizationId.slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

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
        <h2 className="mb-3 text-sm font-medium text-zinc-400">文字起こし方式</h2>
        <div className="grid gap-4 text-sm md:grid-cols-[260px_1fr]">
          <label className="text-xs text-zinc-500">
            STT provider
            <select
              value={props.settings?.sttProviderMode ?? 'local_first'}
              onChange={(event) =>
                void props.onSettingsChange({
                  sttProviderMode: event.currentTarget.value as AppSettings['sttProviderMode'],
                })
              }
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-200"
            >
              <option value="local_first">Apple SpeechAnalyzer優先</option>
              <option value="deepgram_fallback">ローカル + Deepgram fallback</option>
              <option value="deepgram_only">Deepgramのみ</option>
              <option value="manual_only">手動/開発 transcript のみ</option>
            </select>
          </label>
          <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-400">
            <div className="font-medium text-zinc-300">
              {sttProviderModeLabel(props.settings?.sttProviderMode ?? 'local_first')}
            </div>
            <p className="mt-2">
              Mac MVPは音声を外部サーバーに預けない方針です。Apple SpeechAnalyzer実装が入るまでは、
              ローカルSTT provider は未接続として扱います。Deepgram fallback を選んだ場合だけクラウドSTTへ音声を送信します。
              議事録・カンペ生成でAnthropicを使う場合は、音声ではなく文字起こし後のテキストだけを送信します。
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-400">API Keys</h2>
          <button
            type="button"
            disabled={anthropicDiagnosticPending || !props.secretStatus.anthropic_api_key}
            onClick={() => void runAnthropicDiagnostic()}
            className="rounded bg-zinc-800 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40"
          >
            {anthropicDiagnosticPending ? 'Anthropic確認中…' : 'Anthropic実API確認'}
          </button>
        </div>
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
        {anthropicDiagnostic && (
          <div
            className={`mt-4 rounded border p-3 text-xs ${
              anthropicDiagnostic.authenticated
                ? 'border-overlay-success/40 bg-emerald-950/20 text-emerald-100'
                : 'border-overlay-objection/40 bg-red-950/20 text-red-100'
            }`}
          >
            <div className="flex flex-wrap gap-3">
              <span>認証: {anthropicDiagnostic.authenticated ? 'OK' : 'NG'}</span>
              <span>Haiku: {anthropicDiagnostic.haikuModel}</span>
              <span>Sonnet: {anthropicDiagnostic.sonnetModel}</span>
              <span>検知: {anthropicDiagnostic.detectionOk ? 'OK' : '未検知'}</span>
              <span>回答: {anthropicDiagnostic.responseOk ? 'OK' : 'NG'}</span>
              <span>{anthropicDiagnostic.latencyMs}ms</span>
            </div>
            {anthropicDiagnostic.samplePeak && (
              <div className="mt-2">sample peak: {anthropicDiagnostic.samplePeak}</div>
            )}
            {anthropicDiagnostic.error && (
              <div className="mt-2 text-overlay-objection">{anthropicDiagnostic.error}</div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 p-5 text-sm text-zinc-400">
        設定スキーマ: v{props.settings?.schemaVersion ?? '-'} / 通知方式:{' '}
        {props.settings?.consentNoticeMode ?? '-'}
      </div>
    </>
  );
}

function AuditLogPanel(): JSX.Element {
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [integrity, setIntegrity] = useState<AuditIntegrityResult | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<AuditLogFilter>({});

  useEffect(() => {
    void window.api.auditLogs.list().then(setAuditLogs);
    void window.api.auditLogs.verify().then(setIntegrity);
  }, []);

  const refreshAuditLogs = async (nextFilter: AuditLogFilter): Promise<void> => {
    setAuditLogs(await window.api.auditLogs.list(cleanAuditFilter(nextFilter)));
  };

  const updateFilter = (patch: AuditLogFilter): void => {
    setFilter((current) => ({ ...current, ...patch }));
  };

  return (
    <div className="rounded-lg border border-zinc-800 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-medium text-zinc-400">監査ログ</h2>
          <div
            className={`text-xs ${integrity?.valid ? 'text-overlay-success' : 'text-overlay-objection'}`}
          >
            ハッシュチェーン: {integrity?.valid ? 'VALID' : integrity ? 'INVALID' : '検証中'} /{' '}
            {integrity?.checkedEntries ?? 0}件
          </div>
        </div>
        <div className="flex gap-2">
          {(['csv', 'pdf'] as const).map((format) => (
            <button
              key={format}
              type="button"
              onClick={() =>
                void window.api.auditLogs
                  .export(format, cleanAuditFilter(filter))
                  .then((path) => setExportedPath(path))
              }
              className="rounded bg-zinc-100 px-3 py-2 text-xs font-medium uppercase text-zinc-900"
            >
              {format}出力
            </button>
          ))}
        </div>
      </div>
      <p className="mb-4 text-xs text-zinc-500">
        録音開始・同意取得・ユーザーロール変更の実行者と組織スコープを記録します。
      </p>
      <div className="mb-4 grid gap-3 rounded border border-zinc-800 p-3 text-xs md:grid-cols-5">
        <input
          aria-label="監査ログ検索"
          value={filter.query ?? ''}
          onChange={(event) => updateFilter({ query: event.currentTarget.value })}
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-2 outline-none focus:border-zinc-400"
          placeholder="検索語 / target / hash"
        />
        <input
          aria-label="監査ログ開始日"
          type="date"
          value={filter.dateFrom ?? ''}
          onChange={(event) => updateFilter({ dateFrom: event.currentTarget.value })}
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-2 outline-none focus:border-zinc-400"
        />
        <input
          aria-label="監査ログ終了日"
          type="date"
          value={filter.dateTo ?? ''}
          onChange={(event) => updateFilter({ dateTo: event.currentTarget.value })}
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-2 outline-none focus:border-zinc-400"
        />
        <select
          aria-label="監査ログ操作種別"
          value={filter.action ?? ''}
          onChange={(event) =>
            updateFilter({
              action: event.currentTarget.value
                ? (event.currentTarget.value as AuditLogFilter['action'])
                : undefined,
            })
          }
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-2 outline-none focus:border-zinc-400"
        >
          <option value="">全操作</option>
          {AUDIT_ACTION_OPTIONS.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <input
            aria-label="監査ログ実行者"
            value={filter.actor ?? ''}
            onChange={(event) => updateFilter({ actor: event.currentTarget.value })}
            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-2 outline-none focus:border-zinc-400"
            placeholder="実行者"
          />
          <button
            type="button"
            onClick={() => void refreshAuditLogs(filter)}
            className="rounded bg-zinc-800 px-3 py-2 hover:bg-zinc-700"
          >
            適用
          </button>
        </div>
      </div>
      {exportedPath && <div className="mb-4 text-xs text-overlay-success">出力先: {exportedPath}</div>}
      {auditLogs.length === 0 ? (
        <div className="rounded border border-zinc-800 p-4 text-sm text-zinc-600">
          監査ログはまだありません。
        </div>
      ) : (
        <ul className="space-y-2">
          {auditLogs.map((entry) => (
            <li key={entry.id} className="rounded border border-zinc-800 p-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-zinc-200">{entry.action}</span>
                <span className="text-zinc-600">
                  {new Date(entry.createdAt).toLocaleString('ja-JP')}
                </span>
              </div>
              <div className="mt-1 text-zinc-500">
                actor: {entry.actorDisplayName ?? entry.actorType} / {entry.actorRole ?? '-'}
              </div>
              <div className="mt-1 font-mono text-zinc-600">
                tenant {entry.tenantId?.slice(0, 8) ?? '-'} / org{' '}
                {entry.organizationId?.slice(0, 8) ?? '-'} / target {entry.targetType}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-zinc-700">
                sha256: {entry.hash ?? 'unsigned'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ComplianceRuleSetsPanel(props: {
  currentUserContext: CurrentUserContext | null;
  productId: ProductId;
}): JSX.Element {
  const [ruleSets, setRuleSets] = useState<ComplianceRuleSet[]>([]);
  const [name, setName] = useState('');
  const [productCategory, setProductCategory] = useState<string>(props.productId);
  const [selectedRuleSetId, setSelectedRuleSetId] = useState<string | null>(null);
  const [rules, setRules] = useState<ComplianceRule[]>([]);
  const [pattern, setPattern] = useState('');
  const [reason, setReason] = useState('');
  const [recommendedPhrase, setRecommendedPhrase] = useState('');
  const [severity, setSeverity] = useState<ComplianceSeverity>('medium');
  const [ruleType, setRuleType] = useState<ComplianceRuleType>('caution_expression');
  const [priority, setPriority] = useState(100);

  const refresh = async (): Promise<void> => {
    setRuleSets(await window.api.compliance.listRuleSets());
  };

  useEffect(() => {
    void window.api.compliance.listRuleSets().then(setRuleSets);
  }, []);

  const createRuleSet = async (): Promise<void> => {
    const created = await window.api.compliance.createRuleSet({ name, productCategory });
    setName('');
    await refresh();
    setSelectedRuleSetId(created.id);
    setRules([]);
  };

  const selectedRuleSet = ruleSets.find((ruleSet) => ruleSet.id === selectedRuleSetId) ?? null;
  const selectRuleSet = async (id: string): Promise<void> => {
    setSelectedRuleSetId(id);
    setRules(await window.api.compliance.listRulesForSet(id));
  };
  const createRule = async (): Promise<void> => {
    if (!selectedRuleSet) return;
    await window.api.compliance.createRule({
      ruleSetId: selectedRuleSet.id,
      companyId: selectedRuleSet.organizationId,
      industry: 'insurance',
      productCategory: selectedRuleSet.productCategory,
      severity,
      ruleType,
      pattern,
      reason,
      recommendedPhrase,
      priority,
    });
    setPattern('');
    setReason('');
    setRecommendedPhrase('');
    await selectRuleSet(selectedRuleSet.id);
  };
  const updatePriority = async (rule: ComplianceRule, nextPriority: number): Promise<void> => {
    await window.api.compliance.updateRule({ ...rule, priority: nextPriority });
    await selectRuleSet(rule.ruleSetId);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="text-sm font-medium text-zinc-400">会社別プリセット・商品別ルールセット</h2>
        <p className="mt-1 text-xs text-zinc-500">
          保険会社プリセットは継承専用です。代理店独自セットは商品単位で有効化できます。
        </p>
        <div className="mt-4 grid gap-2 md:grid-cols-[1fr_200px_auto]">
          <input
            aria-label="ルールセット名"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            placeholder="例: 医療保険の重点確認"
          />
          <select
            aria-label="ルールセット商品"
            value={productCategory}
            onChange={(event) => setProductCategory(event.currentTarget.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
          >
            <option value="insurance_general">保険共通</option>
            {PRODUCTS.map((product) => (
              <option key={product.id} value={product.id}>
                {product.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() => void createRuleSet()}
            className="rounded bg-zinc-100 px-4 py-2 text-sm text-zinc-900 disabled:opacity-40"
          >
            セット作成
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {ruleSets.map((ruleSet) => {
          const inherited = ruleSet.organizationId !== props.currentUserContext?.organization.id;
          return (
            <div key={ruleSet.id} className="rounded border border-zinc-800 p-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium">{ruleSet.name}</div>
                  <div className="mt-1 text-xs text-zinc-500">
                    商品: {ruleSet.productCategory} / {inherited ? '保険会社プリセット' : '自社ルール'}
                    {ruleSet.presetKey ? ` / ${ruleSet.presetKey}` : ''} / v{ruleSet.version} /{' '}
                    {ruleSet.approvalStatus}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void selectRuleSet(ruleSet.id)} className="rounded bg-zinc-800 px-3 py-2 text-xs">
                    ルール管理
                  </button>
                  {ruleSet.approvalStatus === 'draft' || ruleSet.approvalStatus === 'rejected' ? (
                    <button type="button" disabled={inherited} onClick={() => void window.api.compliance.submitRuleSet(ruleSet.id).then(refresh)} className="rounded bg-zinc-100 px-3 py-2 text-xs text-zinc-900 disabled:opacity-40">
                      承認申請
                    </button>
                  ) : ruleSet.approvalStatus === 'pending_review' ? (
                    <>
                      <button type="button" disabled={inherited} onClick={() => void window.api.compliance.reviewRuleSet(ruleSet.id, true).then(refresh)} className="rounded bg-overlay-success px-3 py-2 text-xs text-zinc-900 disabled:opacity-40">承認</button>
                      <button type="button" disabled={inherited} onClick={() => void window.api.compliance.reviewRuleSet(ruleSet.id, false).then(refresh)} className="rounded bg-overlay-objection px-3 py-2 text-xs text-white disabled:opacity-40">却下</button>
                    </>
                  ) : (
                    <>
                      <button type="button" disabled={inherited} onClick={() => void window.api.compliance.createRuleSetRevision(ruleSet.id).then(refresh)} className="rounded bg-zinc-800 px-3 py-2 text-xs disabled:opacity-40">新版作成</button>
                      <button type="button" disabled={inherited} onClick={() => void window.api.compliance.setRuleSetActive(ruleSet.id, !ruleSet.active).then(refresh)} className="rounded bg-zinc-800 px-3 py-2 text-xs disabled:opacity-40">
                        {ruleSet.active ? '有効' : '無効'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {selectedRuleSet && (
        <div className="rounded-lg border border-zinc-800 p-5">
          <h3 className="text-sm font-medium">{selectedRuleSet.name} のルール</h3>
          {!['draft', 'rejected'].includes(selectedRuleSet.approvalStatus) ? (
            <p className="mt-2 text-xs text-zinc-500">承認申請後のルールは編集できません。</p>
          ) : (
            <div className="mt-4 grid gap-2 md:grid-cols-2">
              <input aria-label="ルール検知表現" value={pattern} onChange={(event) => setPattern(event.currentTarget.value)} className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" placeholder="検知表現" />
              <input aria-label="ルール理由" value={reason} onChange={(event) => setReason(event.currentTarget.value)} className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" placeholder="理由" />
              <input aria-label="ルール推奨表現" value={recommendedPhrase} onChange={(event) => setRecommendedPhrase(event.currentTarget.value)} className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm" placeholder="推奨表現" />
              <div className="flex gap-2">
                <select aria-label="ルール重大度" value={severity} onChange={(event) => setSeverity(event.currentTarget.value as ComplianceSeverity)} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm">
                  {(['critical', 'high', 'medium', 'low'] as const).map((value) => <option key={value}>{value}</option>)}
                </select>
                <select aria-label="ルール種別" value={ruleType} onChange={(event) => setRuleType(event.currentTarget.value as ComplianceRuleType)} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm">
                  {(['prohibited_expression', 'caution_expression', 'required_disclosure'] as const).map((value) => <option key={value}>{value}</option>)}
                </select>
                <input aria-label="ルール優先度" type="number" value={priority} onChange={(event) => setPriority(Number(event.currentTarget.value))} className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm" />
                <button type="button" disabled={!pattern.trim() || !reason.trim() || !recommendedPhrase.trim()} onClick={() => void createRule()} className="rounded bg-zinc-100 px-3 py-2 text-xs text-zinc-900 disabled:opacity-40">ルール追加</button>
              </div>
            </div>
          )}
          <ul className="mt-4 space-y-2">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-center justify-between rounded border border-zinc-800 p-3 text-xs">
                <div><span className="font-medium">{rule.pattern}</span><span className="ml-2 text-zinc-500">優先度 {rule.priority} / {rule.severity}</span></div>
                {['draft', 'rejected'].includes(selectedRuleSet.approvalStatus) && (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void updatePriority(rule, Math.max(0, rule.priority - 10))} className="rounded bg-zinc-800 px-2 py-1">優先度↑</button>
                    <button type="button" onClick={() => void window.api.compliance.deleteRule(rule.id).then(() => selectRuleSet(rule.ruleSetId))} className="rounded bg-overlay-objection px-2 py-1 text-white">削除</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function cleanAuditFilter(filter: AuditLogFilter): AuditLogFilter {
  return Object.fromEntries(
    Object.entries(filter).filter(([, value]) => typeof value === 'string' && value.trim()),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown_error';
}

function safeRecoveryErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  return /[ぁ-んァ-ヶ一-龠]/.test(message)
    ? message
    : '録音 checkpoint の操作に失敗しました。時間をおいて再試行してください。';
}

function recoveryStateLabel(state: RecoverySummary['state']): string {
  switch (state) {
    case 'recording':
      return '録音中';
    case 'recoverable':
      return '復旧可能';
    case 'recovering':
      return '復旧中';
    case 'partial':
      return '一部復旧可能';
  }
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function cloudMembershipStatusClass(status: CloudOrganizationUser['status']): string {
  switch (status) {
    case 'active':
      return 'text-overlay-success';
    case 'invited':
      return 'text-overlay-warning';
    case 'disabled':
      return 'text-overlay-objection';
  }
}

function HistoryPanel(props: {
  objectionHistory: ObjectionHistoryItem[];
  productId: ProductId;
  recentTranscripts: Transcript[];
}): JSX.Element {
  return (
    <div className="space-y-6">
      <CallLibrary productId={props.productId} recentTranscripts={props.recentTranscripts} />

      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">このセッションの反論検知</h2>
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
        <TranscriptBubbles
          entries={props.recentTranscripts.map((transcript, index) => ({
            id: `${transcript.startMs}-${index}`,
            speaker: transcript.speaker,
            text: transcript.text,
            startMs: transcript.startMs,
            isFinal: transcript.isFinal,
          }))}
          emptyMessage="未受信"
          maxHeightClassName="max-h-[320px]"
        />
      </div>
    </div>
  );
}

function MonthlyReviewReport(props: { summaries: MonthlyReviewSummary[] }): JSX.Element {
  if (props.summaries.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="text-sm font-medium text-zinc-400">月次レポート</h2>
        <p className="mt-2 text-sm text-zinc-600">
          コンプラ検知が記録されると、月別の集計がここに表示されます。
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 p-5">
      <h2 className="mb-1 text-sm font-medium text-zinc-400">月次レポート</h2>
      <p className="mb-4 text-xs text-zinc-500">
        コンプラ検知の月別集計。重大リスク件数と処理状況を管理者が一目で把握できます。
      </p>
      <div className="space-y-3">
        {props.summaries.map((summary) => (
          <div
            key={summary.month}
            className="rounded border border-zinc-800 bg-zinc-950/40 p-4"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-zinc-200">
                {formatMonthLabel(summary.month)}
              </span>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-zinc-500">検知 {summary.total} 件</span>
                {summary.highRisk > 0 && (
                  <span className="rounded bg-overlay-objection/15 px-2 py-0.5 text-overlay-objection">
                    重大リスク {summary.highRisk}
                  </span>
                )}
                <span className="rounded bg-zinc-900 px-2 py-0.5 text-overlay-success">
                  処理済 {Math.round(summary.resolutionRate * 100)}%
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <ReportStat label="critical" value={summary.bySeverity.critical} tone="danger" />
              <ReportStat label="high" value={summary.bySeverity.high} tone="danger" />
              <ReportStat label="medium" value={summary.bySeverity.medium} tone="warning" />
              <ReportStat label="low" value={summary.bySeverity.low} tone="muted" />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
              <span>未対応 {summary.byStatus.open}</span>
              <span>承認 {summary.byStatus.approved}</span>
              <span>差戻し {summary.byStatus.dismissed}</span>
              <span>要教育 {summary.byStatus.training_required}</span>
              <span>エスカレ {summary.byStatus.escalated}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportStat(props: {
  label: string;
  value: number;
  tone: 'danger' | 'warning' | 'muted';
}): JSX.Element {
  const color =
    props.tone === 'danger'
      ? 'text-overlay-objection'
      : props.tone === 'warning'
        ? 'text-overlay-warning'
        : 'text-zinc-400';
  return (
    <div className="rounded bg-zinc-900 p-2 text-center">
      <div className={`text-lg font-semibold ${color}`}>{props.value}</div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-600">{props.label}</div>
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
  const monthlySummaries = summarizeReviewTasksByMonth(reviewTasks);

  return (
    <div className="space-y-6">
      <MonthlyReviewReport summaries={monthlySummaries} />

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

function KnowledgePanel(props: {
  productId: ProductId;
  currentUserContext: CurrentUserContext | null;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeEntry[]>([]);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [candidates, setCandidates] = useState<KnowledgeCandidate[]>([]);
  const [objectionType, setObjectionType] = useState('price');
  const [trigger, setTrigger] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const canManage = props.currentUserContext?.permissions.includes('knowledge:manage') ?? false;

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [nextEntries, nextCandidates] = await Promise.all([
        window.api.knowledge.list(props.productId),
        window.api.knowledge.listCandidates({ productId: props.productId }),
      ]);
      setEntries(nextEntries);
      setCandidates(nextCandidates);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'ナレッジを読み込めませんでした');
    }
  }, [props.productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const search = async (): Promise<void> => {
    if (!query.trim()) return;
    setResults(await window.api.knowledge.search(query, props.productId, 5));
  };

  const createEntry = async (): Promise<void> => {
    if (!trigger.trim() || !response.trim()) {
      return;
    }
    try {
      const entry = await window.api.knowledge.create({
        productId: props.productId,
        objectionType,
        trigger,
        response,
        reasoning: '管理者による直接登録',
        riskFlags: [],
      });
      setEntries((current) => [entry, ...current]);
      setTrigger('');
      setResponse('');
      setError(null);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '登録できませんでした');
    }
  };

  const reviewCandidate = async (
    candidate: KnowledgeCandidate,
    input: {
      decision: 'approve' | 'reject';
      title: string;
      content: string;
      objectionType: string;
      reviewNote?: string | undefined;
    },
  ): Promise<void> => {
    try {
      await window.api.knowledge.reviewCandidate({ id: candidate.id, ...input });
      await reload();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : '候補を更新できませんでした');
    }
  };

  const pendingCandidates = candidates.filter((candidate) => candidate.status === 'pending');

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-zinc-200">会社ナレッジ承認キュー</h2>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              商談議事録から自動抽出します。承認済みだけがリアルタイムカンペの検索対象です。
            </p>
            <p className="mt-2 text-xs text-zinc-400">
              {props.currentUserContext?.organization.name ?? '現在の会社'} / 未確認{' '}
              {pendingCandidates.length}件
            </p>
          </div>
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
          >
            更新
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-3 rounded border border-red-900/60 bg-red-950/30 p-3 text-xs text-red-300">
            {error}
          </p>
        )}
        <div className="mt-4 space-y-3">
          {pendingCandidates.length === 0 ? (
            <p className="rounded border border-zinc-800 p-3 text-sm text-zinc-600">
              未確認の候補はありません
            </p>
          ) : (
            pendingCandidates.map((candidate) => (
              <KnowledgeCandidateReviewCard
                key={candidate.id}
                candidate={candidate}
                canManage={canManage}
                onReview={reviewCandidate}
              />
            ))
          )}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 p-5">
        <h2 className="mb-1 text-sm font-medium text-zinc-400">このMacの承認済みナレッジ</h2>
        <p className="mb-3 text-xs text-zinc-600">端末内ですぐ使う、確認済みの切り返しだけを登録してください。</p>
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
          disabled={!canManage || !trigger.trim() || !response.trim()}
        >
          承認済みとして登録
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
        <h2 className="mb-3 text-sm font-medium text-zinc-400">利用中の会社ナレッジ</h2>
        {entries.length === 0 ? (
          <p className="text-sm text-zinc-600">未登録</p>
        ) : (
          <KnowledgeEntryList entries={entries} title="登録済み" />
        )}
      </div>
    </div>
  );
}

function KnowledgeCandidateReviewCard(props: {
  candidate: KnowledgeCandidate;
  canManage: boolean;
  onReview: (
    candidate: KnowledgeCandidate,
    input: {
      decision: 'approve' | 'reject';
      title: string;
      content: string;
      objectionType: string;
      reviewNote?: string | undefined;
    },
  ) => Promise<void>;
}): JSX.Element {
  const [title, setTitle] = useState(props.candidate.title);
  const [content, setContent] = useState(props.candidate.content);
  const [objectionType, setObjectionType] = useState(`meeting_${props.candidate.kind}`);
  const [reviewNote, setReviewNote] = useState('');
  const [busy, setBusy] = useState(false);
  const blocked = props.candidate.legalRisk === 'blocked';

  const submit = async (decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(true);
    try {
      await props.onReview(props.candidate, {
        decision,
        title,
        content,
        objectionType,
        ...(reviewNote.trim() ? { reviewNote: reviewNote.trim() } : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">{props.candidate.kind}</span>
        <span className={blocked ? 'text-red-300' : 'text-amber-300'}>
          {blocked ? '承認ブロック' : '人による確認が必要'}
        </span>
        <span className="text-zinc-600">{props.candidate.sourceMeetingMinuteId.slice(0, 8)}</span>
      </div>
      <div className="grid gap-2 md:grid-cols-[160px_1fr]">
        <input
          aria-label="候補分類"
          value={objectionType}
          onChange={(event) => setObjectionType(event.currentTarget.value)}
          disabled={!props.canManage || busy}
          className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm disabled:opacity-50"
        />
        <input
          aria-label="候補タイトル"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          disabled={!props.canManage || busy}
          className="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm disabled:opacity-50"
        />
      </div>
      <textarea
        aria-label="候補内容"
        value={content}
        onChange={(event) => setContent(event.currentTarget.value)}
        disabled={!props.canManage || busy}
        className="mt-2 min-h-20 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm disabled:opacity-50"
      />
      {(props.candidate.validationFlags.length > 0 || props.candidate.riskFlags.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {[...props.candidate.validationFlags, ...props.candidate.riskFlags].map((flag) => (
            <span key={flag} className="rounded bg-red-950/60 px-2 py-0.5 text-xs text-red-300">
              {flag}
            </span>
          ))}
        </div>
      )}
      <input
        aria-label="レビュー理由"
        value={reviewNote}
        onChange={(event) => setReviewNote(event.currentTarget.value)}
        disabled={!props.canManage || busy}
        placeholder="却下時は理由を入力"
        className="mt-3 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs disabled:opacity-50"
      />
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void submit('approve')}
          disabled={!props.canManage || busy || blocked || !title.trim() || !content.trim()}
          className="rounded bg-emerald-500 px-3 py-1.5 text-xs font-medium text-emerald-950 disabled:opacity-40"
        >
          承認してRAGへ公開
        </button>
        <button
          type="button"
          onClick={() => void submit('reject')}
          disabled={!props.canManage || busy || !reviewNote.trim()}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-40"
        >
          却下
        </button>
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

function sttProviderModeLabel(mode: AppSettings['sttProviderMode']): string {
  switch (mode) {
    case 'local_first':
      return 'Apple SpeechAnalyzer優先';
    case 'deepgram_fallback':
      return 'ローカル + Deepgram fallback';
    case 'deepgram_only':
      return 'Deepgramのみ';
    case 'manual_only':
      return '手動/開発 transcript のみ';
  }
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
