/**
 * Shared types between Main and Renderer.
 * Keep this file dependency-free (no zod, no node, no electron imports).
 */

export type ProductId = 'real_estate' | 'kenko_keiei' | 'hojokin';

export type Speaker = 'self' | 'counterpart';

export type ObjectionType =
  | 'price'
  | 'timing'
  | 'authority'
  | 'status_quo'
  | 'trust'
  | 'competitor'
  // Product-specific extension points (added at runtime per product)
  | string;

export interface AudioChunk {
  speaker: Speaker;
  /** PCM 16-bit LE, 16kHz, mono. Base64 when crossing IPC. */
  data: string;
  startMs: number;
  durationMs: number;
}

export interface InterimTranscript {
  speaker: Speaker;
  text: string;
  isFinal: false;
  startMs: number;
}

export interface FinalTranscript {
  speaker: Speaker;
  text: string;
  isFinal: true;
  startMs: number;
  endMs: number;
}

export type Transcript = InterimTranscript | FinalTranscript;

export interface DetectedObjection {
  id: string;
  type: ObjectionType;
  confidence: number;
  triggerText: string;
  detectedAt: number;
}

export interface ObjectionResponse {
  id: string;
  objectionId: string;
  /** Layer 1: peak label (≤ 15 chars per PRD §12.2) */
  peak: string;
  /** Layer 2: 3-line summary */
  summary: string[];
  /** Layer 3: full script */
  fullScript: string;
  reasoning: string;
  notes: string[];
  /** Per PRD §16: guardrail risk flags */
  riskFlags: string[];
  generatedAtMs: number;
}

export type CallState =
  | { status: 'uninitialized' }
  | { status: 'setup' }
  | { status: 'idle' }
  | { status: 'in_call'; productId: ProductId; startedAt: number }
  | { status: 'error'; message: string };

export type SharingState =
  | { status: 'not_sharing' }
  | { status: 'verifying' }
  | { status: 'sharing' }
  | { status: 'protection_failed' };

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface AudioCaptureSourceStats {
  chunks: number;
  bytes: number;
  lastReceivedAtMs: number | null;
}

export interface AudioCaptureStats {
  self: AudioCaptureSourceStats;
  counterpart: AudioCaptureSourceStats;
  total: AudioCaptureSourceStats;
}

export interface AudioCaptureStatus {
  nativeModule: {
    available: boolean;
    contractValid: boolean;
    modulePath: string;
    error?: string | undefined;
  };
  permissions: PermissionState;
  stats: AudioCaptureStats;
  sttState: ConnectionState;
  nativeCaptureActive: boolean;
}

export interface AppInfo {
  bundleId: string;
  name: string;
  windowCount: number;
  iconBase64?: string;
}

export interface PermissionState {
  screen: boolean;
  microphone: boolean;
}

export interface AppSettings {
  selectedProductId: ProductId | null;
  overlayPosition: { x: number; y: number; display: number };
  hotkeys: Record<string, string>;
  consentNoticeMode: 'verbal' | 'zoom_background' | 'sdk';
  /** Per PRD §31: keep deprecated keys for 3 months */
  schemaVersion: number;
}

export interface KnowledgeEntry {
  id: string;
  productId: ProductId;
  objectionType: ObjectionType;
  trigger: string;
  response: string;
  reasoning: string;
  riskFlags: string[];
  /** Per PRD §17: chunked as one objection-response pair */
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface MeetingMinute {
  id: string;
  callId: string;
  productId: ProductId;
  summary: string;
  agreed: string[];
  pending: string[];
  decisions: string[];
  numbers: { label: string; value: string }[];
  generatedAt: string;
}

export type TaskOwner = 'own' | 'customer' | 'joint';
export type TaskDue = { kind: 'explicit'; date: string } | { kind: 'inferred'; date: string } | { kind: 'none' };

export interface ActionItemTask {
  id: string;
  callId: string;
  owner: TaskOwner;
  description: string;
  due: TaskDue;
  completed: boolean;
  createdAt: string;
}

export type ErrorSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ErrorCategory =
  | 'network'
  | 'api'
  | 'permission'
  | 'audio'
  | 'database'
  | 'llm'
  | 'storage'
  | 'unknown';

export interface AppError {
  severity: ErrorSeverity;
  category: ErrorCategory;
  code: string;
  message: string;
  technicalMessage?: string | undefined;
  recoverable: boolean;
  recoveryAction?: 'retry' | 'fallback' | 'user_action' | 'restart' | undefined;
  context?: Record<string, unknown> | undefined;
}

/**
 * Public surface exposed via `contextBridge` to the renderer.
 * Per PRD §23: Main is heavy, Renderer is thin.
 */
export interface RendererApi {
  app: {
    getVersion(): Promise<string>;
  };
  permissions: {
    check(): Promise<PermissionState>;
    requestScreen(): Promise<void>;
    requestMicrophone(): Promise<void>;
    onChange(cb: (state: PermissionState) => void): () => void;
  };
  call: {
    start(productId: ProductId): Promise<void>;
    end(): Promise<void>;
    setProduct(productId: ProductId): Promise<void>;
    onState(cb: (state: CallState) => void): () => void;
  };
  audio: {
    getStatus(): Promise<AudioCaptureStatus>;
    start(): Promise<void>;
    stop(): Promise<void>;
    onError(cb: (message: string) => void): () => void;
  };
  stt: {
    onInterim(cb: (transcript: Transcript) => void): () => void;
    onFinal(cb: (transcript: Transcript) => void): () => void;
    onError(cb: (message: string) => void): () => void;
    onConnectionState(cb: (state: ConnectionState) => void): () => void;
  };
  objection: {
    onDetected(cb: (obj: DetectedObjection) => void): () => void;
    onResponseReady(cb: (resp: ObjectionResponse) => void): () => void;
    onCancelled(cb: (id: string) => void): () => void;
    submitFeedback(id: string, used: boolean, reason?: string): Promise<void>;
    dismiss(id: string): Promise<void>;
  };
  overlay: {
    setHover(isHover: boolean): Promise<void>;
    setLayer(layer: 1 | 2 | 3): Promise<void>;
    onSharingState(cb: (state: SharingState) => void): () => void;
  };
  knowledge: {
    search(query: string, productId: ProductId, limit?: number): Promise<KnowledgeEntry[]>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<void>;
    onChange(cb: (settings: AppSettings) => void): () => void;
  };
  secrets: {
    set(key: string, value: string): Promise<void>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<void>;
  };
}

declare global {
  interface Window {
    api: RendererApi;
  }
}
