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

  cloudflare: {
    status: 'cloudflare:status',
    bootstrap: 'cloudflare:bootstrap',
    login: 'cloudflare:login',
    changePassword: 'cloudflare:change-password',
    acceptInvitation: 'cloudflare:accept-invitation',
    completePasswordReset: 'cloudflare:complete-password-reset',
    organizationsList: 'cloudflare:organizations-list',
    usersList: 'cloudflare:users-list',
    createInvitation: 'cloudflare:create-invitation',
    issuePasswordReset: 'cloudflare:issue-password-reset',
    setMembershipStatus: 'cloudflare:set-membership-status',
    logout: 'cloudflare:logout',
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

  organizations: {
    currentContext: 'organizations:current-context',
    list: 'organizations:list',
    usersList: 'organizations:users-list',
    updateUserRole: 'organizations:update-user-role',
  },

  auditLogs: {
    list: 'audit-logs:list',
    verify: 'audit-logs:verify',
    export: 'audit-logs:export',
  },

  // Transcript segments
  transcripts: {
    list: 'transcripts:list',
  },

  // Uploaded / imported audio assets
  audioAssets: {
    import: 'audio-assets:import',
    importAndProcess: 'audio-assets:import-and-process',
    cloudUploadAndProcess: 'audio-assets:cloud-upload-and-process',
    list: 'audio-assets:list',
  },

  // STT jobs for imported audio
  sttJobs: {
    create: 'stt-jobs:create',
    run: 'stt-jobs:run',
    list: 'stt-jobs:list',
  },

  // Encrypted recording checkpoints / crash recovery
  recovery: {
    list: 'recovery:list',
    recover: 'recovery:recover',
    discard: 'recovery:discard',
    setRetention: 'recovery:set-retention',
  },

  // Knowledge base
  knowledge: {
    search: 'knowledge:search',
    list: 'knowledge:list',
    create: 'knowledge:create',
    update: 'knowledge:update',
    delete: 'knowledge:delete',
    seedDefaults: 'knowledge:seed-defaults',
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
    rulesListForSet: 'compliance:rules-list-for-set',
    rulesCreate: 'compliance:rules-create',
    rulesUpdate: 'compliance:rules-update',
    rulesDelete: 'compliance:rules-delete',
    ruleSetsList: 'compliance:rule-sets-list',
    ruleSetsCreate: 'compliance:rule-sets-create',
    ruleSetsSetActive: 'compliance:rule-sets-set-active',
    ruleSetsSubmit: 'compliance:rule-sets-submit',
    ruleSetsReview: 'compliance:rule-sets-review',
    ruleSetsCreateRevision: 'compliance:rule-sets-create-revision',
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
    anthropicDiagnostic: 'secrets:anthropic-diagnostic',
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
