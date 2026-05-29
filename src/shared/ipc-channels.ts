/**
 * IPC channel constants. Per PRD §23.
 *
 * Naming convention: `domain:action` (kebab-case).
 * Use `invoke/handle` for request-response, `send/on` for one-way notifications.
 */

export const IPC = {
  // Lifecycle
  app: {
    ready: 'app:ready',
    quit: 'app:quit',
    version: 'app:version',
  },

  // Permissions (macOS)
  permissions: {
    check: 'permissions:check', // → { screen: bool, microphone: bool }
    requestScreen: 'permissions:request-screen',
    requestMicrophone: 'permissions:request-microphone',
    onChange: 'permissions:on-change', // notify
  },

  // Audio capture (Swift NAPI bridge)
  audio: {
    listShareableApps: 'audio:list-shareable-apps',
    status: 'audio:status',
    start: 'audio:start',
    stop: 'audio:stop',
    pause: 'audio:pause',
    resume: 'audio:resume',
    onSystemChunk: 'audio:on-system-chunk',
    onMicrophoneChunk: 'audio:on-microphone-chunk',
    onError: 'audio:on-error',
  },

  // STT
  stt: {
    onInterim: 'stt:on-interim',
    onFinal: 'stt:on-final',
    onError: 'stt:on-error',
    onConnectionState: 'stt:on-connection-state',
  },

  // Objection pipeline
  objection: {
    onDetected: 'objection:on-detected',
    onResponseReady: 'objection:on-response-ready',
    onCancelled: 'objection:on-cancelled',
    feedback: 'objection:feedback', // used / not-used
    dismiss: 'objection:dismiss',
  },

  // Overlay window control
  overlay: {
    show: 'overlay:show',
    hide: 'overlay:hide',
    setLayer: 'overlay:set-layer', // 1 | 2 | 3
    setHover: 'overlay:set-hover',
    onSharingState: 'overlay:on-sharing-state',
  },

  // Call lifecycle
  call: {
    list: 'call:list',
    start: 'call:start',
    end: 'call:end',
    setProduct: 'call:set-product', // real_estate | kenko_keiei | hojokin
    onState: 'call:on-state',
  },

  // Transcript segments
  transcripts: {
    list: 'transcripts:list',
  },

  // Knowledge base
  knowledge: {
    search: 'knowledge:search',
    list: 'knowledge:list',
    create: 'knowledge:create',
    update: 'knowledge:update',
    delete: 'knowledge:delete',
  },

  // Meeting minutes / tasks (post-call, §22)
  minutes: {
    generate: 'minutes:generate',
    get: 'minutes:get',
    exportPdf: 'minutes:export-pdf',
  },
  tasks: {
    list: 'tasks:list',
    create: 'tasks:create',
    update: 'tasks:update',
    complete: 'tasks:complete',
  },
  reviews: {
    list: 'reviews:list',
    updateStatus: 'reviews:update-status',
  },

  // Compliance review (two-track plan)
  compliance: {
    rulesList: 'compliance:rules-list',
    rulesCreate: 'compliance:rules-create',
    rulesDelete: 'compliance:rules-delete',
  },

  // Settings
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    onChange: 'settings:on-change',
  },

  // Secrets (Keychain)
  secrets: {
    set: 'secrets:set',
    has: 'secrets:has',
    delete: 'secrets:delete',
    // NOTE: `get` is intentionally absent from IPC. Renderer must never read raw secrets.
  },

  // Feedback / telemetry
  feedback: {
    submit: 'feedback:submit',
  },

  // System state and cross-cutting errors
  system: {
    error: 'system:error',
    degraded: 'system:degraded',
    costAlert: 'system:cost-alert',
  },

  // Logging (Renderer → Main)
  log: {
    write: 'log:write',
  },

  // Development-only diagnostics. Handlers are gated in Main.
  dev: {
    isEnabled: 'dev:is-enabled',
    startMockCall: 'dev:start-mock-call',
    endMockCall: 'dev:end-mock-call',
    injectTranscript: 'dev:inject-transcript',
  },
} as const;

export type IpcChannelMap = typeof IPC;
