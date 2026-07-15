import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { IPC } from '@shared/ipc-channels';
import {
  AppSettingsPatchSchema,
  AudioCaptureStatusSchema,
  AudioDiagnosticSessionResultSchema,
  AuditLogExportInputSchema,
  AuditLogFilterSchema,
  AudioStartInputSchema,
  AudioImportInputSchema,
  AudioChunkSchema,
  AudioSttJobCreateInputSchema,
  AudioSttJobRunInputSchema,
  CallIdInputSchema,
  CallStartInputSchema,
  CloudflareTokenPasswordInputSchema,
  CloudflareCredentialInputSchema,
  CloudOrganizationInvitationInputSchema,
  CloudOrganizationMembershipStatusInputSchema,
  CloudOrganizationPasswordResetInputSchema,
  ComplianceRuleCreateInputSchema,
  ComplianceRuleDeleteInputSchema,
  ComplianceRuleUpdateInputSchema,
  ComplianceRuleSetActiveInputSchema,
  ComplianceRuleSetCreateInputSchema,
  ComplianceRuleSetIdInputSchema,
  ComplianceRuleSetReviewInputSchema,
  DevInjectTranscriptInputSchema,
  FeedbackSchema,
  KnowledgeCreateInputSchema,
  KnowledgeDeleteInputSchema,
  KnowledgeSearchInputSchema,
  KnowledgeSeedDefaultsInputSchema,
  MinutesGenerateInputSchema,
  ObjectionDismissInputSchema,
  OrganizationUserRoleUpdateInputSchema,
  OverlayLayerSchema,
  ProductIdSchema,
  ReviewTaskUpdateStatusInputSchema,
  SecretKeySchema,
  SecretSetInputSchema,
  StartRecordingSessionResultSchema,
  TaskCompleteInputSchema,
  TaskCreateInputSchema,
} from '@shared/schemas';
import type {
  ActionItemTask,
  AuditLogEntry,
  AppSettings,
  AudioDiagnosticSessionResult,
  AudioChunk,
  AudioCaptureStatus,
  AudioImportResult,
  AudioImportProcessResult,
  CloudAudioUploadProcessResult,
  AudioSttJob,
  CallSession,
  CallState,
  ComplianceRule,
  ComplianceRuleSet,
  CurrentUserContext,
  MeetingMinute,
  PermissionState,
  ProductId,
  ReviewTask,
  SharingState,
  SttProviderKind,
  StartRecordingSessionResult,
  Transcript,
} from '@shared/types';
import { logger } from '../logger';
import {
  checkPermissions,
  formatMissingAudioCapturePermissions,
  requestMicrophonePermission,
  requestScreenPermission,
} from '../services/permissions';
import { secretStore } from '../services/secrets';
import { settingsStore } from '../services/settings';
import { setCallModeLogging } from '../logger';
import { createRuntimeKnowledgeSearchService } from '../services/knowledge-runtime';
import { localKnowledgeStore } from '../services/local-knowledge-store';
import { seedLocalKnowledge } from '../seed-local-knowledge';
import { createRuntimeObjectionPipelineService } from '../services/objection-runtime';
import type { ObjectionPipelineService } from '../services/objection-pipeline';
import { runAnthropicDiagnostic } from '../services/anthropic';
import { createRuntimeConfiguredSTTClient } from '../services/stt-runtime';
import type { ResilientSTTClient } from '../services/stt';
import { NativeAudioCaptureService } from '../audio/native-audio-capture';
import {
  createInitialAudioCaptureStats,
  updateAudioCaptureStats,
} from '../audio/audio-capture-stats';
import { evaluateAudioPreflight } from '../audio/audio-preflight';
import {
  getNativeAudioCaptureModuleStatus,
  loadNativeAudioCaptureModule,
} from '../audio/native-module-loader';
import { assertDevToolsEnabled, isDevToolsEnabled } from '../services/dev-mode';
import { appRepositories } from '../services/repositories';
import { evaluateCompliance } from '../services/compliance';
import { tryGenerateLlmMinutesContent } from '../services/minutes-llm';
import { AudioSttJobRunner } from '../services/audio-stt-job-runner';
import { resolveImportSTTProvider } from '../services/import-stt-provider-resolver';
import { createAuditCsv, writeAuditPdf } from '../services/audit-export';
import {
  acceptCloudflareInvitation,
  bootstrapCloudflareCredential,
  changeCloudflarePassword,
  completeCloudflarePasswordReset,
  createCloudflareInvitation,
  getCloudflareConnectionStatus,
  issueCloudflarePasswordReset,
  listCloudflareOrganizations,
  listCloudflareOrganizationUsers,
  loginCloudflare,
  logoutCloudflare,
  setCloudflareMembershipStatus,
  uploadAudioToCloudAndProcess,
} from '../services/cloudflare-api';

/**
 * Register all IPC handlers. Per PRD §23: Main concentrates all logic.
 */
interface IpcWindowAccessors {
  getControlWindow(): BrowserWindow | null;
  getOverlayWindow(): BrowserWindow | null;
}

let callState: CallState = { status: 'idle' };
const sharingState: SharingState = { status: 'not_sharing' };
const knowledgeSearchService = createRuntimeKnowledgeSearchService();
// audioSttJobRunner is initialized lazily so it can pick up current settings at job creation time.
// Per W3-C: importProviderMode is resolved from settings each time a job is created.
let audioSttJobRunner = new AudioSttJobRunner({
  repositories: appRepositories,
  onCompleted: async (job) => {
    const call = (await appRepositories.calls.listCalls()).find(
      (candidate) => candidate.id === job.callId,
    );
    if (!call) {
      throw new Error('Call was not found');
    }

    await appRepositories.minutes.setLatestMeetingMinute(
      await generateMeetingMinuteForCall({
        callId: call.id,
        productId: call.productId,
        source: call.source,
        transcripts: [],
      }),
    );
  },
});
let activeObjectionPipelineService: ObjectionPipelineService | null = null;
let activeSttClient: ResilientSTTClient | null = null;
let activeSttProviderKind: SttProviderKind | null = null;
let activeSttDegradedReason: string | null = null;
let activeNativeAudioCaptureService: NativeAudioCaptureService | null = null;
let audioCaptureStats = createInitialAudioCaptureStats();
let audioPreflightStartedAtMs: number | null = null;
let audioPreflightSttError: string | null = null;
let audioPreflightNativeCaptureError: string | null = null;
let activeCallId: string | null = null;
let realtimeAudioOwner: 'none' | 'diagnostic' | 'call' = 'none';
let diagnosticStartPromise: Promise<AudioDiagnosticSessionResult> | null = null;
let recordingStartPromise: Promise<StartRecordingSessionResult> | null = null;
let callEndPromise: Promise<void> | null = null;
const localSessionId = randomUUID();

export function registerIpcHandlers(windows: IpcWindowAccessors): void {
  activeObjectionPipelineService = createRuntimeObjectionPipelineService(
    windows,
    () => (callState.status === 'in_call' ? callState.productId : null),
  );

  ipcMain.handle(IPC.app.version, () => app.getVersion());
  ipcMain.handle(IPC.cloudflare.status, () => getCloudflareConnectionStatus());
  ipcMain.handle(IPC.cloudflare.bootstrap, async (_event, payload: unknown) => {
    const input = CloudflareCredentialInputSchema.parse(payload);
    return bootstrapCloudflareCredential(input);
  });
  ipcMain.handle(IPC.cloudflare.login, async (_event, payload: unknown) => {
    const input = CloudflareCredentialInputSchema.parse(payload);
    return loginCloudflare(input);
  });
  ipcMain.handle(IPC.cloudflare.changePassword, async (_event, payload: unknown) => {
    const input = CloudflareCredentialInputSchema.pick({ password: true }).parse(payload);
    return changeCloudflarePassword(input.password);
  });
  ipcMain.handle(IPC.cloudflare.acceptInvitation, async (_event, payload: unknown) => {
    const input = CloudflareTokenPasswordInputSchema.parse(payload);
    return acceptCloudflareInvitation(input);
  });
  ipcMain.handle(IPC.cloudflare.completePasswordReset, async (_event, payload: unknown) => {
    const input = CloudflareTokenPasswordInputSchema.omit({ displayName: true }).parse(payload);
    return completeCloudflarePasswordReset(input);
  });
  ipcMain.handle(IPC.cloudflare.organizationsList, () => listCloudflareOrganizations());
  ipcMain.handle(IPC.cloudflare.usersList, () => listCloudflareOrganizationUsers());
  ipcMain.handle(IPC.cloudflare.createInvitation, async (_event, payload: unknown) => {
    const input = CloudOrganizationInvitationInputSchema.parse(payload);
    return createCloudflareInvitation(input);
  });
  ipcMain.handle(IPC.cloudflare.issuePasswordReset, async (_event, payload: unknown) => {
    const input = CloudOrganizationPasswordResetInputSchema.parse(payload);
    return issueCloudflarePasswordReset(input.membershipId);
  });
  ipcMain.handle(IPC.cloudflare.setMembershipStatus, async (_event, payload: unknown) => {
    const input = CloudOrganizationMembershipStatusInputSchema.parse(payload);
    return setCloudflareMembershipStatus(input.membershipId, input.status);
  });
  ipcMain.handle(IPC.cloudflare.logout, () => logoutCloudflare());

  ipcMain.handle(IPC.permissions.check, () => checkPermissions());
  ipcMain.handle(IPC.permissions.requestScreen, async () => {
    const permissions = await requestScreenPermission();
    notifyPermissions(windows, permissions);
  });
  ipcMain.handle(IPC.permissions.requestMicrophone, async () => {
    const permissions = await requestMicrophonePermission();
    notifyPermissions(windows, permissions);
  });

  ipcMain.handle(IPC.settings.get, () => settingsStore.get());
  ipcMain.handle(IPC.settings.set, async (_event, payload: unknown) => {
    const patch = AppSettingsPatchSchema.parse(payload);
    const settings = await settingsStore.set(patch);
    notifySettings(windows, settings);
  });

  ipcMain.handle(IPC.secrets.set, async (_event, payload: unknown) => {
    const input = SecretSetInputSchema.parse(payload);
    await secretStore.set(input.key, input.value);
  });
  ipcMain.handle(IPC.secrets.has, (_event, payload: unknown) => {
    const key = SecretKeySchema.parse(payload);
    return secretStore.has(key);
  });
  ipcMain.handle(IPC.secrets.delete, async (_event, payload: unknown) => {
    const key = SecretKeySchema.parse(payload);
    await secretStore.delete(key);
  });
  ipcMain.handle(IPC.secrets.anthropicDiagnostic, () => runAnthropicDiagnostic());

  ipcMain.handle(IPC.audio.status, () => AudioCaptureStatusSchema.parse(getAudioCaptureStatus()));

  ipcMain.handle(IPC.audio.start, async (_event, payload: unknown) => {
    const input = AudioStartInputSchema.parse(payload);
    return AudioDiagnosticSessionResultSchema.parse(
      await startAudioDiagnosticSession(windows, input.consent),
    );
  });

  ipcMain.handle(IPC.audio.stop, async () => {
    return AudioDiagnosticSessionResultSchema.parse(await stopAudioDiagnosticSession(windows));
  });

  ipcMain.handle(IPC.audioAssets.import, async (_event, payload: unknown) => {
    const input = AudioImportInputSchema.parse(payload);
    return importAudioAsset(windows, input.productId, input.consent);
  });
  ipcMain.handle(IPC.audioAssets.importAndProcess, async (_event, payload: unknown) => {
    const input = AudioImportInputSchema.parse(payload);
    return importAndProcessAudioAsset(windows, input.productId, input.consent);
  });
  ipcMain.handle(IPC.audioAssets.cloudUploadAndProcess, async (_event, payload: unknown) => {
    const input = AudioImportInputSchema.parse(payload);
    return cloudUploadAndProcessAudioAsset(windows, input.productId, input.consent);
  });
  ipcMain.handle(IPC.audioAssets.list, (_event, payload: unknown) => {
    const callId = CallIdInputSchema.parse(payload);
    return appRepositories.audioAssets.listAudioAssets(callId);
  });
  ipcMain.handle(IPC.sttJobs.create, async (_event, payload: unknown) => {
    const input = AudioSttJobCreateInputSchema.parse(payload);
    return createAudioSttJob(input.audioAssetId);
  });
  ipcMain.handle(IPC.sttJobs.run, async (_event, payload: unknown) => {
    const input = AudioSttJobRunInputSchema.parse(payload);
    return audioSttJobRunner.run(input.jobId);
  });
  ipcMain.handle(IPC.sttJobs.list, (_event, payload: unknown) => {
    const callId = CallIdInputSchema.parse(payload);
    return appRepositories.sttJobs.listJobs(callId);
  });

  ipcMain.handle(IPC.audio.onSystemChunk, async (_event, payload: unknown) => {
    const chunk = AudioChunkSchema.parse(payload);
    await sendAudioChunkToSTT({ ...chunk, speaker: 'counterpart' });
  });

  ipcMain.handle(IPC.audio.onMicrophoneChunk, async (_event, payload: unknown) => {
    const chunk = AudioChunkSchema.parse(payload);
    await sendAudioChunkToSTT({ ...chunk, speaker: 'self' });
  });

  ipcMain.handle(IPC.call.list, async () => {
    await appRepositories.organizations.assertPermission('calls:read');
    return appRepositories.calls.listCalls();
  });
  ipcMain.handle(IPC.call.start, async (_event, payload: unknown) => {
    const input = CallStartInputSchema.parse(payload);
    return StartRecordingSessionResultSchema.parse(
      await startRecordingSession(windows, {
        productId: input.productId,
        consent: input.consent,
        source: 'zoom_desktop',
      }),
    );
  });

  ipcMain.handle(IPC.call.end, async () => {
    await stopRecordingSession(windows);
    logger.info('call ended');
  });

  ipcMain.handle(IPC.call.setProduct, async (_event, payload: unknown) => {
    const productId = ProductIdSchema.parse(payload);
    const settings = await settingsStore.set({ selectedProductId: productId });
    notifySettings(windows, settings);
    if (callState.status === 'in_call') {
      callState = { ...callState, productId };
      notifyCallState(windows);
    }
  });

  ipcMain.handle(IPC.transcripts.list, (_event, payload: unknown) => {
    const callId = CallIdInputSchema.parse(payload);
    return appRepositories.transcripts.listTranscripts(callId);
  });

  ipcMain.handle(IPC.organizations.currentContext, () =>
    appRepositories.organizations.getCurrentContext(),
  );
  ipcMain.handle(IPC.organizations.list, async () => {
    const context = await appRepositories.organizations.getCurrentContext();
    return appRepositories.organizations.listOrganizations(context.tenant.id);
  });
  ipcMain.handle(IPC.organizations.usersList, async () => {
    const context = await appRepositories.organizations.assertPermission('organization:manage');
    return appRepositories.organizations.listUsers(context.tenant.id);
  });
  ipcMain.handle(IPC.organizations.updateUserRole, async (_event, payload: unknown) => {
    const context = await appRepositories.organizations.assertPermission('organization:manage');
    const input = OrganizationUserRoleUpdateInputSchema.parse(payload);
    const users = await appRepositories.organizations.listUsers(context.tenant.id);
    const target = users.find((user) => user.membershipId === input.membershipId);
    if (!target) {
      throw new Error('Organization user was not found');
    }
    if (
      context.membership.role !== 'insurer_admin' &&
      target.organizationId !== context.organization.id
    ) {
      throw new Error('Current user cannot manage users outside their organization');
    }
    if (context.membership.role !== 'insurer_admin' && input.role === 'insurer_admin') {
      throw new Error('Only insurer administrators can assign insurer administrator role');
    }
    const previousRole = target.role;
    const updated = await appRepositories.organizations.updateUserRole(
      context.tenant.id,
      input.membershipId,
      input.role,
    );
    await appRepositories.auditLogs.appendAuditLogs([
      createUserAuditLogEntry(context, {
        action: 'organization.user_role_updated',
        targetType: 'organization_membership',
        targetId: updated.membershipId,
        metadata: {
          targetUserId: updated.id,
          targetOrganizationId: updated.organizationId,
          previousRole,
          nextRole: updated.role,
        },
      }),
    ]);
    return updated;
  });

  ipcMain.handle(IPC.auditLogs.list, async (_event, payload: unknown) => {
    const filter = AuditLogFilterSchema.optional().parse(payload);
    const context = await appRepositories.organizations.getCurrentContext();
    return appRepositories.auditLogs.listAuditLogs(auditLogScope(context), filter);
  });
  ipcMain.handle(IPC.auditLogs.verify, async () => {
    const context = await appRepositories.organizations.getCurrentContext();
    return appRepositories.auditLogs.verifyAuditLogs({ tenantId: context.tenant.id });
  });
  ipcMain.handle(IPC.auditLogs.export, async (_event, payload: unknown) => {
    const input = AuditLogExportInputSchema.parse(payload);
    const context = await appRepositories.organizations.getCurrentContext();
    const entries = await appRepositories.auditLogs.listAuditLogs(
      auditLogScope(context),
      input.filter,
    );
    const integrity = await appRepositories.auditLogs.verifyAuditLogs({ tenantId: context.tenant.id });
    const result = await dialog.showSaveDialog({
      title: '監査ログをエクスポート',
      defaultPath: `audit-log-${new Date().toISOString().slice(0, 10)}.${input.format}`,
      filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    if (input.format === 'csv') {
      await writeFile(result.filePath, createAuditCsv(entries, integrity), 'utf8');
    } else {
      await writeAuditPdf(result.filePath, entries, integrity);
    }
    return result.filePath;
  });

  ipcMain.handle(IPC.overlay.show, () => windows.getOverlayWindow()?.showInactive());
  ipcMain.handle(IPC.overlay.hide, () => windows.getOverlayWindow()?.hide());
  ipcMain.handle(IPC.overlay.setHover, (_event, payload: unknown) => {
    const isHover = typeof payload === 'boolean' ? payload : false;
    windows.getOverlayWindow()?.setIgnoreMouseEvents(!isHover, { forward: true });
  });
  ipcMain.handle(IPC.overlay.setLayer, (_event, payload: unknown) => {
    const layer = OverlayLayerSchema.parse(payload);
    windows.getOverlayWindow()?.webContents.send(IPC.overlay.setLayer, layer);
  });

  ipcMain.handle(IPC.knowledge.search, async (_event, payload: unknown) => {
    const input = KnowledgeSearchInputSchema.parse(payload);
    logger.debug({ productId: input.productId, limit: input.limit }, 'knowledge search requested');
    const limit = input.limit ?? 5;
    const localResults = await appRepositories.knowledge.search(input.query, input.productId, limit);
    const remoteResults = await knowledgeSearchService.search({
      query: input.query,
      productId: input.productId,
      limit,
    });
    return [...localResults, ...remoteResults].slice(0, limit);
  });
  ipcMain.handle(IPC.knowledge.list, (_event, payload: unknown) => {
    const productId = ProductIdSchema.parse(payload);
    return appRepositories.knowledge.list(productId);
  });
  ipcMain.handle(IPC.knowledge.create, (_event, payload: unknown) => {
    const input = KnowledgeCreateInputSchema.parse(payload);
    return appRepositories.knowledge.create(input);
  });
  ipcMain.handle(IPC.knowledge.delete, async (_event, payload: unknown) => {
    const id = KnowledgeDeleteInputSchema.parse(payload);
    await appRepositories.knowledge.delete(id);
  });
  ipcMain.handle(IPC.knowledge.seedDefaults, async (_event, payload: unknown) => {
    const input = KnowledgeSeedDefaultsInputSchema.parse(payload);
    const result = await seedLocalKnowledge(localKnowledgeStore, input ?? {});
    logger.info({ ...result, productId: input?.productId ?? 'all' }, 'knowledge seed completed');
    return result;
  });

  ipcMain.handle(IPC.minutes.generate, async (_event, payload: unknown) => {
    const input = MinutesGenerateInputSchema.parse(payload);
    return appRepositories.minutes.setLatestMeetingMinute(
      await generateMeetingMinuteForCall({
        // callId 指定時は過去 call の再生成。未指定はアクティブ通話(従来動作)。
        callId: input.callId ?? getCurrentCallId(),
        productId: input.productId,
        source: input.source,
        transcripts: input.transcripts,
      }),
    );
  });
  ipcMain.handle(IPC.minutes.get, () => appRepositories.minutes.getLatestMeetingMinute());

  ipcMain.handle(IPC.tasks.list, () => appRepositories.tasks.listTasks());
  ipcMain.handle(IPC.tasks.create, async (_event, payload: unknown) => {
    const input = TaskCreateInputSchema.parse(payload);
    const task: ActionItemTask = {
      id: randomUUID(),
      callId: getCurrentCallId(),
      owner: input.owner,
      description: input.description,
      due: { kind: 'none' },
      completed: false,
      createdAt: new Date().toISOString(),
    };
    return appRepositories.tasks.createTask(task);
  });
  ipcMain.handle(IPC.tasks.complete, (_event, payload: unknown) => {
    const input = TaskCompleteInputSchema.parse(payload);
    return appRepositories.tasks.completeTask(input.id, input.completed);
  });

  ipcMain.handle(IPC.reviews.list, () => appRepositories.reviews.listReviewTasks());
  ipcMain.handle(IPC.reviews.updateStatus, async (_event, payload: unknown) => {
    await appRepositories.organizations.assertPermission('reviews:manage');
    const input = ReviewTaskUpdateStatusInputSchema.parse(payload);
    const task = await appRepositories.reviews.updateReviewTaskStatus(input.id, input.status);
    await appRepositories.auditLogs.appendAuditLogs([
      createAuditLogEntry({
        action: 'review_task.status_updated',
        targetType: 'review_task',
        targetId: task.id,
        metadata: { status: task.status, severity: task.severity },
      }),
    ]);
    return task;
  });

  ipcMain.handle(IPC.compliance.rulesList, async () => {
    const context = await appRepositories.organizations.getCurrentContext();
    return appRepositories.complianceRules.listRules('insurance', {
      tenantId: context.tenant.id,
      organizationId: context.organization.id,
    });
  });
  ipcMain.handle(IPC.compliance.rulesListForSet, async (_event, payload: unknown) => {
    const context = await appRepositories.organizations.getCurrentContext();
    const ruleSetId = ComplianceRuleSetIdInputSchema.parse(payload);
    await assertManageableRuleSet(context, ruleSetId, false);
    return appRepositories.complianceRules.listRulesForSet(ruleSetId);
  });
  ipcMain.handle(IPC.compliance.ruleSetsList, async () => {
    const context = await appRepositories.organizations.getCurrentContext();
    return appRepositories.complianceRules.listRuleSets({
      tenantId: context.tenant.id,
      organizationId: context.organization.id,
    });
  });
  ipcMain.handle(IPC.compliance.ruleSetsCreate, async (_event, payload: unknown) => {
    const context = await appRepositories.organizations.assertPermission('rules:manage');
    const input = ComplianceRuleSetCreateInputSchema.parse(payload);
    if (input.presetKey && context.membership.role !== 'insurer_admin') {
      throw new Error('Only insurer administrators can create company presets');
    }
    const ruleSet = await appRepositories.complianceRules.createRuleSet(
      { tenantId: context.tenant.id, organizationId: context.organization.id },
      input,
    );
    await appRepositories.auditLogs.appendAuditLogs([
      createUserAuditLogEntry(context, {
        action: 'compliance.rule_set_created',
        targetType: 'compliance_rule_set',
        targetId: ruleSet.id,
        metadata: {
          name: ruleSet.name,
          productCategory: ruleSet.productCategory,
          presetKey: ruleSet.presetKey,
        },
      }),
    ]);
    return ruleSet;
  });
  ipcMain.handle(IPC.compliance.ruleSetsSetActive, async (_event, payload: unknown) => {
    const context = await appRepositories.organizations.assertPermission('rules:manage');
    const input = ComplianceRuleSetActiveInputSchema.parse(payload);
    const ruleSets = await appRepositories.complianceRules.listRuleSets({
      tenantId: context.tenant.id,
      organizationId: context.organization.id,
    });
    const target = ruleSets.find((ruleSet) => ruleSet.id === input.id);
    if (!target || target.organizationId !== context.organization.id) {
      throw new Error('Inherited compliance presets cannot be changed by this organization');
    }
    const updated = await appRepositories.complianceRules.setRuleSetActive(input.id, input.active);
    await appRepositories.auditLogs.appendAuditLogs([
      createUserAuditLogEntry(context, {
        action: 'compliance.rule_set_active_updated',
        targetType: 'compliance_rule_set',
        targetId: updated.id,
        metadata: {
          active: updated.active,
          productCategory: updated.productCategory,
        },
      }),
    ]);
    return updated;
  });
  ipcMain.handle(IPC.compliance.ruleSetsSubmit, async (_event, payload: unknown) => {
    const context = await appRepositories.organizations.assertPermission('rules:manage');
    const id = ComplianceRuleSetIdInputSchema.parse(payload);
    await assertManageableRuleSet(context, id, true);
    const updated = await appRepositories.complianceRules.submitRuleSet(id);
    await appendRuleSetAudit(context, updated, 'compliance.rule_set_submitted');
    return updated;
  });
  ipcMain.handle(IPC.compliance.ruleSetsReview, async (_event, payload: unknown) => {
    const context = await appRepositories.organizations.assertPermission('rules:approve');
    const input = ComplianceRuleSetReviewInputSchema.parse(payload);
    await assertManageableRuleSet(context, input.id, true);
    const updated = await appRepositories.complianceRules.reviewRuleSet(
      input.id,
      input.approved,
      context.user.id,
    );
    await appendRuleSetAudit(
      context,
      updated,
      input.approved ? 'compliance.rule_set_approved' : 'compliance.rule_set_rejected',
    );
    return updated;
  });
  ipcMain.handle(IPC.compliance.ruleSetsCreateRevision, async (_event, payload: unknown) => {
    const context = await appRepositories.organizations.assertPermission('rules:manage');
    const id = ComplianceRuleSetIdInputSchema.parse(payload);
    await assertManageableRuleSet(context, id, true);
    const revision = await appRepositories.complianceRules.createRuleSetRevision(id);
    await appendRuleSetAudit(context, revision, 'compliance.rule_set_revision_created');
    return revision;
  });
  ipcMain.handle(IPC.compliance.rulesCreate, async (_event, payload: unknown) => {
    const context = await appRepositories.organizations.assertPermission('rules:manage');
    const input = ComplianceRuleCreateInputSchema.parse(payload);
    const ruleSet = await assertManageableRuleSet(context, input.ruleSetId, true);
    const rule = await appRepositories.complianceRules.createRule({
      ...input,
      tenantId: context.tenant.id,
      organizationId: context.organization.id,
      companyId: context.organization.id,
      productCategory: ruleSet.productCategory,
    });
    await appendRuleAudit(context, rule, 'compliance.rule_created');
    return rule;
  });
  ipcMain.handle(IPC.compliance.rulesUpdate, async (_event, payload: unknown) => {
    const context = await appRepositories.organizations.assertPermission('rules:manage');
    const input = ComplianceRuleUpdateInputSchema.parse(payload);
    const existing = (await appRepositories.complianceRules.listRuleSets({
      tenantId: context.tenant.id,
      organizationId: context.organization.id,
    }));
    const rules = await Promise.all(existing.map((ruleSet) => appRepositories.complianceRules.listRulesForSet(ruleSet.id)));
    const current = rules.flat().find((rule) => rule.id === input.id);
    if (!current) throw new Error('Compliance rule was not found');
    await assertManageableRuleSet(context, current.ruleSetId, true);
    const updated = await appRepositories.complianceRules.updateRule(input);
    await appendRuleAudit(context, updated, 'compliance.rule_updated');
    return updated;
  });
  ipcMain.handle(IPC.compliance.rulesDelete, async (_event, payload: unknown) => {
    const context = await appRepositories.organizations.assertPermission('rules:manage');
    const id = ComplianceRuleDeleteInputSchema.parse(payload);
    const ruleSets = await appRepositories.complianceRules.listRuleSets({
      tenantId: context.tenant.id,
      organizationId: context.organization.id,
    });
    const rules = await Promise.all(ruleSets.map((ruleSet) => appRepositories.complianceRules.listRulesForSet(ruleSet.id)));
    const current = rules.flat().find((rule) => rule.id === id);
    if (!current) throw new Error('Compliance rule was not found');
    await assertManageableRuleSet(context, current.ruleSetId, true);
    await appRepositories.complianceRules.deleteRule(id);
    await appendRuleAudit(context, current, 'compliance.rule_deleted');
  });

  ipcMain.handle(IPC.objection.feedback, (_event, payload: unknown) => {
    const feedback = FeedbackSchema.parse(payload);
    logger.info({ objectionResponseId: feedback.objectionResponseId, used: feedback.used }, 'feedback');
  });

  ipcMain.handle(IPC.objection.dismiss, (_event, payload: unknown) => {
    const id = ObjectionDismissInputSchema.parse(payload);
    activeObjectionPipelineService?.cancelActive();
    notifyObjectionCancelled(windows, id);
    logger.info({ id }, 'objection dismissed');
  });

  ipcMain.handle(IPC.dev.isEnabled, () => isDevToolsEnabled());
  ipcMain.handle(IPC.dev.startMockCall, async (_event, payload: unknown) => {
    assertDevToolsEnabled();
    const productId = ProductIdSchema.parse(payload);
    const startedAt = new Date();
    const scope = await appRepositories.organizations.getDefaultScope();
    const call = await appRepositories.calls.createCall({
      ...scope,
      source: 'manual_transcript',
      industry: 'insurance',
      productId,
      recordingConsent: {
        status: 'granted',
        method: 'digital',
        capturedAt: startedAt.toISOString(),
        noticeVersion: 'local-v1',
      },
      startedAt,
    });
    activeCallId = call.id;
    callState = { status: 'in_call', productId, startedAt: startedAt.getTime() };
    setCallModeLogging(true);
    notifyCallState(windows);
    windows.getOverlayWindow()?.showInactive();
    logger.info({ productId }, 'development mock call started');
  });
  ipcMain.handle(IPC.dev.endMockCall, async () => {
    assertDevToolsEnabled();
    await endCurrentCall(windows);
    logger.info('development mock call ended');
  });
  ipcMain.handle(IPC.dev.injectTranscript, async (_event, payload: unknown) => {
    assertDevToolsEnabled();
    const transcript = DevInjectTranscriptInputSchema.parse(payload);
    notifyTranscript(windows, transcript);
    if (callState.status === 'in_call') {
      await handlePipelineTranscript(transcript);
    }
  });

  notifyCallState(windows);
  notifySharingState(windows);
  notifyPermissions(windows, checkPermissions());

  logger.debug('ipc handlers registered');
}

export async function handlePipelineTranscript(transcript: Transcript): Promise<void> {
  await persistCurrentTranscript(transcript);
  await activeObjectionPipelineService?.handleTranscript(transcript);
}

export async function sendAudioChunkToSTT(chunk: AudioChunk): Promise<void> {
  audioCaptureStats = updateAudioCaptureStats(audioCaptureStats, chunk);
  await activeSttClient?.sendAudio(chunk);
}

function getAudioCaptureStatus(): AudioCaptureStatus {
  const nativeModule = getNativeAudioCaptureModuleStatus();
  const permissions = checkPermissions();
  const sttState = activeSttClient?.getState() ?? 'disconnected';

  return {
    nativeModule,
    permissions,
    stats: audioCaptureStats,
    sttState,
    nativeCaptureActive: activeNativeAudioCaptureService !== null,
    preflight: evaluateAudioPreflight({
      nativeModule,
      nativeCaptureActive: activeNativeAudioCaptureService !== null,
      nativeCaptureError: audioPreflightNativeCaptureError,
      permissions,
      stats: audioCaptureStats,
      sttState,
      startedAtMs: audioPreflightStartedAtMs,
      sttError: audioPreflightSttError,
    }),
  };
}

function startAudioPreflight(startedAtMs = Date.now()): void {
  audioPreflightStartedAtMs = startedAtMs;
  audioPreflightSttError = null;
  audioPreflightNativeCaptureError = null;
}

function resetAudioPreflight(): void {
  audioPreflightStartedAtMs = null;
  audioPreflightSttError = null;
  audioPreflightNativeCaptureError = null;
}

function preflightAudioCapturePermissions(windows: IpcWindowAccessors): boolean {
  const permissions = checkPermissions();
  notifyPermissions(windows, permissions);
  const message = formatMissingAudioCapturePermissions(permissions);
  if (!message) {
    return true;
  }

  windows.getControlWindow()?.webContents.send(IPC.audio.onError, message);
  logger.warn({ permissions }, 'audio capture permission preflight failed');
  return false;
}

async function startSTT(windows: IpcWindowAccessors): Promise<void> {
  if (!activeSttClient) {
    const settings = await settingsStore.get();
    const configured = await createRuntimeConfiguredSTTClient({
      mode: settings.sttProviderMode,
      windows,
      isInCall: () => callState.status === 'in_call',
      onPipelineTranscript: handlePipelineTranscript,
    });
    activeSttClient = configured.client;
    activeSttProviderKind = configured.providerKind;
    activeSttDegradedReason = configured.degradedReason;
  }
  await activeSttClient.start();
  if (activeSttClient.getState() !== 'connected') {
    throw new Error('STT did not reach connected state');
  }
}

async function tryStartSTT(windows: IpcWindowAccessors): Promise<boolean> {
  try {
    await startSTT(windows);
    audioPreflightSttError = null;
    return true;
  } catch (error) {
    audioPreflightSttError = 'stt_start_failed';
    windows.getControlWindow()?.webContents.send(
      IPC.stt.onError,
      'STT の起動に失敗しました。設定とローカル helper の状態を確認してください。',
    );
    logger.warn({ error }, 'stt start failed');
    return false;
  }
}

async function stopSTT(): Promise<void> {
  const client = activeSttClient;
  activeSttClient = null;
  activeSttProviderKind = null;
  activeSttDegradedReason = null;
  await client?.stop();
}

async function tryStartNativeAudioCapture(windows: IpcWindowAccessors): Promise<boolean> {
  try {
    await startNativeAudioCapture(windows);
    audioPreflightNativeCaptureError = null;
    return true;
  } catch (error) {
    audioPreflightNativeCaptureError = 'native_capture_start_failed';
    windows.getControlWindow()?.webContents.send(
      IPC.audio.onError,
      'native audio capture の起動に失敗しました。権限と Zoom の起動状態を確認してください。',
    );
    logger.warn({ error }, 'native audio capture start failed');
    return false;
  }
}

async function startNativeAudioCapture(windows: IpcWindowAccessors): Promise<void> {
  if (!activeNativeAudioCaptureService) {
    const nativeModule = loadNativeAudioCaptureModule();
    if (!nativeModule) {
      throw new Error('Native audio capture module not found');
    }

    activeNativeAudioCaptureService = new NativeAudioCaptureService({
      module: nativeModule,
      sendAudioChunk: sendAudioChunkToSTT,
      onError: (error) => {
        const message = formatNativeCaptureError(error);
        audioPreflightNativeCaptureError = message;
        windows.getControlWindow()?.webContents.send(
          IPC.audio.onError,
          'native audio capture が停止しました。診断を停止してから再実行してください。',
        );
        logger.warn({ error }, 'native audio capture error');
      },
    });
  }

  await activeNativeAudioCaptureService.start();
}

function formatNativeCaptureError(error: { code: string; message: string }): string {
  return error.code || 'native_capture_error';
}

export type RecordingStartFailureCleanupReason =
  | 'diagnostic_audit_failed'
  | 'call_create_failed'
  | 'call_audit_failed';

export interface RecordingStartFailureCleanupPlan {
  stopAudioServices: true;
  resetPreflight: true;
  endCallId: string | null;
  userMessage: string;
}

export function createRecordingStartFailureCleanupPlan(input: {
  reason: RecordingStartFailureCleanupReason;
  callId?: string | null | undefined;
}): RecordingStartFailureCleanupPlan {
  const userMessage =
    input.reason === 'diagnostic_audit_failed'
      ? '録音監査ログの記録に失敗したため、音声診断を停止しました。時間をおいて再試行してください。'
      : input.reason === 'call_create_failed'
        ? '録音セッションの作成に失敗しました。時間をおいて再試行してください。'
        : '録音監査ログの記録に失敗したため、録音を開始できませんでした。時間をおいて再試行してください。';

  return {
    stopAudioServices: true,
    resetPreflight: true,
    endCallId: input.reason === 'call_audit_failed' ? (input.callId ?? null) : null,
    userMessage,
  };
}

export async function startAudioDiagnosticSession(
  windows: IpcWindowAccessors,
  consent: CallSession['recordingConsent'],
): Promise<AudioDiagnosticSessionResult> {
  if (
    callState.status === 'in_call' ||
    recordingStartPromise ||
    callEndPromise ||
    realtimeAudioOwner === 'call'
  ) {
    notifyAudioError(windows, '通話中または録音処理中は standalone 音声診断を開始できません。');
    return { ok: false, error: 'recording_in_progress' };
  }

  if (diagnosticStartPromise || realtimeAudioOwner === 'diagnostic') {
    notifyAudioError(windows, '音声診断はすでに実行中です。');
    return { ok: false, error: 'already_running' };
  }

  diagnosticStartPromise = startAudioDiagnosticSessionOnce(windows, consent).finally(() => {
    diagnosticStartPromise = null;
  });
  return diagnosticStartPromise;
}

async function startAudioDiagnosticSessionOnce(
  windows: IpcWindowAccessors,
  consent: CallSession['recordingConsent'],
): Promise<AudioDiagnosticSessionResult> {
  let context: CurrentUserContext;
  try {
    context = await appRepositories.organizations.assertPermission('recording:start');
  } catch (error) {
    logger.warn({ error }, 'audio diagnostic permission denied');
    return { ok: false, error: 'permission_required' };
  }

  if (!preflightAudioCapturePermissions(windows)) {
    return { ok: false, error: 'permission_required' };
  }

  startAudioPreflight();
  audioCaptureStats = createInitialAudioCaptureStats();
  const sttStarted = await tryStartSTT(windows);
  const nativeCaptureStarted = sttStarted ? await tryStartNativeAudioCapture(windows) : false;
  if (!sttStarted || !nativeCaptureStarted) {
    await stopRealtimeAudioServices();
    realtimeAudioOwner = 'none';
    return { ok: false, error: 'start_failed' };
  }

  try {
    await appendRecordingAuditLogs(context, localSessionId, consent, 'audio_diagnostic');
  } catch (error) {
    logger.warn({ error }, 'audio diagnostic audit log failed');
    await runRecordingStartFailureCleanup(
      windows,
      createRecordingStartFailureCleanupPlan({ reason: 'diagnostic_audit_failed' }),
    );
    return { ok: false, error: 'start_failed' };
  }

  realtimeAudioOwner = 'diagnostic';
  return { ok: true };
}

export async function stopAudioDiagnosticSession(
  windows: IpcWindowAccessors,
): Promise<AudioDiagnosticSessionResult> {
  if (
    callState.status === 'in_call' ||
    recordingStartPromise ||
    callEndPromise ||
    realtimeAudioOwner === 'call'
  ) {
    notifyAudioError(windows, '通話中の録音は、商談終了操作でのみ停止します。');
    return { ok: false, error: 'recording_in_progress' };
  }

  if (diagnosticStartPromise) {
    notifyAudioError(windows, '音声診断の開始処理中です。完了後に停止してください。');
    return { ok: false, error: 'already_running' };
  }

  if (realtimeAudioOwner !== 'diagnostic') {
    notifyAudioError(windows, '停止できる standalone 音声診断はありません。');
    return { ok: false, error: 'not_running' };
  }

  await stopRealtimeAudioServices();
  realtimeAudioOwner = 'none';
  resetAudioPreflight();
  return { ok: true };
}

async function runRecordingStartFailureCleanup(
  windows: IpcWindowAccessors,
  plan: RecordingStartFailureCleanupPlan,
): Promise<void> {
  if (plan.stopAudioServices) {
    await stopRealtimeAudioServices();
  }

  if (plan.endCallId) {
    await appRepositories.calls.endCall(plan.endCallId).catch((error: unknown) => {
      logger.warn({ error }, 'failed to cleanup unaudited call');
    });
  }

  if (plan.resetPreflight) {
    resetAudioPreflight();
  }
  realtimeAudioOwner = 'none';
  notifyAudioError(windows, plan.userMessage);
}

function notifyAudioError(windows: IpcWindowAccessors, message: string): void {
  windows.getControlWindow()?.webContents.send(IPC.audio.onError, message);
}

async function importAudioAsset(
  windows: IpcWindowAccessors,
  productId: AudioImportResult['call']['productId'],
  recordingConsent: AudioImportResult['call']['recordingConsent'],
): Promise<AudioImportResult | null> {
  const filePath = await selectAudioFile(windows);
  if (!filePath) {
    return null;
  }

  const startedAt = new Date();
  const context = await appRepositories.organizations.assertPermission('recording:start');
  const call = await appRepositories.calls.createCall({
    tenantId: context.tenant.id,
    organizationId: context.organization.id,
    source: 'uploaded_audio',
    industry: 'insurance',
    productId,
    recordingConsent,
    startedAt,
  });
  await appRepositories.calls.endCall(call.id, startedAt);
  const asset = await appRepositories.audioAssets.importAudioFile({
    callId: call.id,
    filePath,
  });
  await appRepositories.auditLogs.appendAuditLogs([
    createUserAuditLogEntry(context, {
      action: 'call.audio_imported',
      targetType: 'audio_asset',
      targetId: asset.id,
      metadata: {
        callId: call.id,
        fileName: asset.fileName,
        sizeBytes: asset.sizeBytes,
        tenantId: call.tenantId,
        organizationId: call.organizationId,
        consentStatus: call.recordingConsent.status,
        consentMethod: call.recordingConsent.method ?? 'unknown',
        consentCapturedAt: call.recordingConsent.capturedAt ?? 'unknown',
        consentNoticeVersion: call.recordingConsent.noticeVersion,
      },
    }),
    createUserAuditLogEntry(context, {
      action: 'recording.consent_captured',
      targetType: 'call',
      targetId: call.id,
      metadata: recordingConsentMetadata(call.recordingConsent, call.source),
    }),
  ]);

  return { call: { ...call, status: 'ended', endedAt: startedAt.toISOString() }, asset };
}

async function cloudUploadAndProcessAudioAsset(
  windows: IpcWindowAccessors,
  productId: AudioImportResult['call']['productId'],
  recordingConsent: AudioImportResult['call']['recordingConsent'],
): Promise<CloudAudioUploadProcessResult | null> {
  const filePath = await selectAudioFile(windows);
  if (!filePath) {
    return null;
  }

  const context = await appRepositories.organizations.assertPermission('recording:start');
  const result = await uploadAudioToCloudAndProcess({ filePath, productId });
  await appRepositories.auditLogs.appendAuditLogs([
    createUserAuditLogEntry(context, {
      action: 'call.audio_imported',
      targetType: 'cloud_audio_asset',
      targetId: result.audioAssetId,
      metadata: {
        callId: result.callId,
        audioAssetId: result.audioAssetId,
        sttJobId: result.sttJobId,
        provider: result.job.provider,
        status: result.status,
        productId,
        consentStatus: recordingConsent.status,
        consentMethod: recordingConsent.method ?? 'unknown',
        consentCapturedAt: recordingConsent.capturedAt ?? 'unknown',
        consentNoticeVersion: recordingConsent.noticeVersion,
      },
    }),
    createUserAuditLogEntry(context, {
      action: 'recording.consent_captured',
      targetType: 'cloud_call',
      targetId: result.callId,
      metadata: recordingConsentMetadata(recordingConsent, 'uploaded_audio'),
    }),
  ]);

  return result;
}

async function selectAudioFile(windows: IpcWindowAccessors): Promise<string | null> {
  const dialogOptions = {
    title: '音声ファイルを取り込む',
    properties: ['openFile'],
    filters: [
      {
        name: 'Audio',
        extensions: ['m4a', 'mp3', 'wav', 'aac', 'mp4', 'webm'],
      },
    ],
  } satisfies Electron.OpenDialogOptions;
  const controlWindow = windows.getControlWindow();
  const dialogResult = controlWindow
    ? await dialog.showOpenDialog(controlWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  return dialogResult.canceled ? null : (dialogResult.filePaths[0] ?? null);
}

async function createAudioSttJob(audioAssetId: string): Promise<AudioSttJob> {
  // Resolve provider from current settings (local_first → Apple when available, else Deepgram).
  const settings = await settingsStore.get();
  const importMode = settings.sttImportProviderMode ?? 'local_first';
  const resolved = resolveImportSTTProvider({ mode: importMode });

  // Rebuild runner with current settings so transcribe() uses the correct provider.
  audioSttJobRunner = new AudioSttJobRunner({
    repositories: appRepositories,
    importProviderMode: importMode,
    onCompleted: async (job) => {
      const call = (await appRepositories.calls.listCalls()).find(
        (candidate) => candidate.id === job.callId,
      );
      if (!call) {
        throw new Error('Call was not found');
      }

      await appRepositories.minutes.setLatestMeetingMinute(
        await generateMeetingMinuteForCall({
          callId: call.id,
          productId: call.productId,
          source: call.source,
          transcripts: [],
        }),
      );
    },
  });

  const calls = await appRepositories.calls.listCalls();
  for (const call of calls) {
    const assets = await appRepositories.audioAssets.listAudioAssets(call.id);
    const asset = assets.find((candidate) => candidate.id === audioAssetId);
    if (!asset) {
      continue;
    }

    const job = await appRepositories.sttJobs.createJob({
      callId: call.id,
      audioAssetId: asset.id,
      provider: resolved.kind,
    });
    await appRepositories.auditLogs.appendAuditLogs([
      createAuditLogEntry({
        action: 'stt_job.created',
        targetType: 'audio_stt_job',
        targetId: job.id,
        metadata: {
          callId: call.id,
          audioAssetId: asset.id,
          provider: job.provider,
          status: job.status,
          sttProvider: job.provider,
          ...(resolved.degradedReason ? { sttDegradedReason: resolved.degradedReason } : {}),
        },
      }),
    ]);
    return job;
  }

  throw new Error('Audio asset was not found');
}

async function importAndProcessAudioAsset(
  windows: IpcWindowAccessors,
  productId: AudioImportResult['call']['productId'],
  recordingConsent: AudioImportResult['call']['recordingConsent'],
): Promise<AudioImportProcessResult | null> {
  const imported = await importAudioAsset(windows, productId, recordingConsent);
  if (!imported) {
    return null;
  }

  const createdJob = await createAudioSttJob(imported.asset.id);
  const job = await audioSttJobRunner.run(createdJob.id);
  const meetingMinute =
    job.status === 'completed' ? await appRepositories.minutes.getLatestMeetingMinute() : null;

  return {
    ...imported,
    job,
    meetingMinute,
  };
}

async function stopNativeAudioCapture(): Promise<void> {
  const service = activeNativeAudioCaptureService;
  activeNativeAudioCaptureService = null;
  await service?.stop();
}

async function stopRealtimeAudioServices(): Promise<void> {
  const results = await Promise.allSettled([stopNativeAudioCapture(), stopSTT()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn({ error: result.reason }, 'audio service stop failed');
    }
  }
}

function notifyCallState(windows: IpcWindowAccessors): void {
  windows.getControlWindow()?.webContents.send(IPC.call.onState, callState);
}

function notifyPermissions(windows: IpcWindowAccessors, permissions: PermissionState): void {
  windows.getControlWindow()?.webContents.send(IPC.permissions.onChange, permissions);
}

function notifySettings(windows: IpcWindowAccessors, settings: AppSettings): void {
  windows.getControlWindow()?.webContents.send(IPC.settings.onChange, settings);
}

function notifySharingState(windows: IpcWindowAccessors): void {
  windows.getOverlayWindow()?.webContents.send(IPC.overlay.onSharingState, sharingState);
}

function notifyTranscript(windows: IpcWindowAccessors, transcript: Transcript): void {
  const channel = transcript.isFinal ? IPC.stt.onFinal : IPC.stt.onInterim;
  windows.getControlWindow()?.webContents.send(channel, transcript);
}

function notifyObjectionCancelled(windows: IpcWindowAccessors, id: string): void {
  windows.getControlWindow()?.webContents.send(IPC.objection.onCancelled, id);
  windows.getOverlayWindow()?.webContents.send(IPC.objection.onCancelled, id);
}

async function generateMeetingMinuteForCall(input: {
  callId: string;
  productId: MeetingMinute['productId'];
  source: MeetingMinute['source'];
  transcripts: Transcript[];
}): Promise<MeetingMinute> {
  const effectiveTranscripts =
    input.transcripts.length === 0 ? await getStoredTranscripts(input.callId) : input.transcripts;
  const finalTexts = effectiveTranscripts
    .filter((transcript) => transcript.isFinal)
    .map((transcript) => transcript.text.trim())
    .filter((text) => text.length > 0);
  const summarySource = finalTexts[0] ?? '商談 transcript はまだありません。';
  const pending = finalTexts.filter((text) =>
    ['高い', '難しい', '検討', '確認', '次回'].some((keyword) => text.includes(keyword)),
  );
  const call = (await appRepositories.calls.listCalls()).find(
    (candidate) => candidate.id === input.callId,
  );
  const rules = await appRepositories.complianceRules.listRules(
    'insurance',
    call ? { tenantId: call.tenantId, organizationId: call.organizationId } : undefined,
    call?.productId,
  );

  // LLM 生成が主、失敗・未設定時はヒューリスティックへ縮退。findings はルールエンジン固定。
  const llmContent = await tryGenerateLlmMinutesContent(input.productId, effectiveTranscripts);

  const meetingMinute: MeetingMinute = {
    id: randomUUID(),
    callId: input.callId,
    source: input.source,
    productId: input.productId,
    summary: llmContent?.summary ?? `直近の発話: ${summarySource}`,
    agreed: llmContent?.agreed ?? [],
    pending: llmContent?.pending ?? pending.slice(0, 5),
    decisions: llmContent?.decisions ?? [],
    numbers: extractNumbers(finalTexts.join('\n')),
    complianceFindings: evaluateCompliance({
      meetingId: input.callId,
      transcripts: effectiveTranscripts,
      rules,
    }),
    generatedAt: new Date().toISOString(),
  };
  const reviewTasks = createReviewTasksFromMinute(meetingMinute);
  await appRepositories.reviews.createReviewTasks(reviewTasks);
  await appRepositories.auditLogs.appendAuditLogs([
    createAuditLogEntry({
      action: 'minutes.generated',
      targetType: 'meeting_minute',
      targetId: meetingMinute.id,
      metadata: {
        callId: meetingMinute.callId,
        source: meetingMinute.source,
        complianceFindings: meetingMinute.complianceFindings.length,
      },
    }),
    ...meetingMinute.complianceFindings.map((finding) =>
      createAuditLogEntry({
        action: 'compliance.finding_detected',
        targetType: 'compliance_finding',
        targetId: finding.id,
        metadata: {
          callId: meetingMinute.callId,
          severity: finding.severity,
          ruleType: finding.ruleType,
        },
      }),
    ),
    ...reviewTasks.map((task) =>
      createAuditLogEntry({
        action: 'review_task.created',
        targetType: 'review_task',
        targetId: task.id,
        metadata: {
          callId: task.callId,
          findingId: task.findingId,
          severity: task.severity,
        },
      }),
    ),
  ]);
  return meetingMinute;
}

async function getStoredTranscripts(callId: string): Promise<Transcript[]> {
  const storedTranscripts = await appRepositories.transcripts.listTranscripts(callId);
  return storedTranscripts.map((segment) =>
    segment.isFinal
      ? {
          speaker: segment.speaker,
          text: segment.text,
          isFinal: true,
          startMs: segment.startMs,
          endMs: segment.endMs ?? segment.startMs,
        }
      : {
          speaker: segment.speaker,
          text: segment.text,
          isFinal: false,
          startMs: segment.startMs,
        },
  );
}

function createReviewTasksFromMinute(minute: MeetingMinute): ReviewTask[] {
  const now = new Date().toISOString();
  return minute.complianceFindings.map((finding) => ({
    id: randomUUID(),
    callId: minute.callId,
    meetingMinuteId: minute.id,
    findingId: finding.id,
    severity: finding.severity,
    status: 'open',
    title: createReviewTaskTitle(finding.severity),
    quotedText: finding.quotedText,
    reason: finding.reason,
    recommendedAction: finding.recommendedAction,
    createdAt: now,
    updatedAt: now,
  }));
}

function createReviewTaskTitle(severity: ReviewTask['severity']): string {
  switch (severity) {
    case 'critical':
      return '重大リスク発話の確認';
    case 'high':
      return '高リスク発話の確認';
    case 'medium':
      return '要注意発話の確認';
    case 'low':
      return '低リスク発話の確認';
  }
}

function createAuditLogEntry(input: {
  action: AuditLogEntry['action'];
  targetType: string;
  targetId: string;
  metadata: AuditLogEntry['metadata'];
}): AuditLogEntry {
  return {
    id: randomUUID(),
    tenantId: null,
    organizationId: null,
    actorType: 'system',
    actorUserId: null,
    actorMembershipId: null,
    actorDisplayName: null,
    actorRole: null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: input.metadata,
    previousHash: null,
    hash: null,
    createdAt: new Date().toISOString(),
  };
}

function createUserAuditLogEntry(
  context: CurrentUserContext,
  input: {
    action: AuditLogEntry['action'];
    targetType: string;
    targetId: string;
    metadata: AuditLogEntry['metadata'];
  },
): AuditLogEntry {
  return {
    id: randomUUID(),
    tenantId: context.tenant.id,
    organizationId: context.organization.id,
    actorType: 'user',
    actorUserId: context.user.id,
    actorMembershipId: context.membership.id,
    actorDisplayName: context.user.displayName,
    actorRole: context.membership.role,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: input.metadata,
    previousHash: null,
    hash: null,
    createdAt: new Date().toISOString(),
  };
}

async function appendRecordingAuditLogs(
  context: CurrentUserContext,
  targetId: string,
  consent: CallSession['recordingConsent'],
  source: string,
): Promise<void> {
  await appRepositories.auditLogs.appendAuditLogs([
    createUserAuditLogEntry(context, {
      action: 'recording.consent_captured',
      targetType: 'call',
      targetId,
      metadata: recordingConsentMetadata(consent, source),
    }),
    createUserAuditLogEntry(context, {
      action: 'recording.started',
      targetType: 'call',
      targetId,
      metadata: recordingConsentMetadata(consent, source),
    }),
  ]);
}

function recordingConsentMetadata(
  consent: CallSession['recordingConsent'],
  source: string,
): AuditLogEntry['metadata'] {
  // 計画書 §7-2: どの STT で文字起こしされた録音かを監査証跡に残す。
  return {
    source,
    consentStatus: consent.status,
    consentMethod: consent.method,
    consentCapturedAt: consent.capturedAt,
    consentNoticeVersion: consent.noticeVersion,
    sttProvider: activeSttProviderKind,
    sttDegradedReason: activeSttDegradedReason,
  };
}

function auditLogScope(context: CurrentUserContext): {
  tenantId: string;
  organizationId?: string | undefined;
} {
  return {
    tenantId: context.tenant.id,
    organizationId:
      context.membership.role === 'insurer_admin' ? undefined : context.organization.id,
  };
}

async function assertManageableRuleSet(
  context: CurrentUserContext,
  ruleSetId: string,
  requireOwner: boolean,
): Promise<ComplianceRuleSet> {
  const ruleSets = await appRepositories.complianceRules.listRuleSets({
    tenantId: context.tenant.id,
    organizationId: context.organization.id,
  });
  const ruleSet = ruleSets.find((candidate) => candidate.id === ruleSetId);
  if (!ruleSet || (requireOwner && ruleSet.organizationId !== context.organization.id)) {
    throw new Error('Compliance rule set cannot be managed by this organization');
  }
  return ruleSet;
}

async function appendRuleSetAudit(
  context: CurrentUserContext,
  ruleSet: ComplianceRuleSet,
  action: AuditLogEntry['action'],
): Promise<void> {
  await appRepositories.auditLogs.appendAuditLogs([
    createUserAuditLogEntry(context, {
      action,
      targetType: 'compliance_rule_set',
      targetId: ruleSet.id,
      metadata: {
        name: ruleSet.name,
        version: ruleSet.version,
        approvalStatus: ruleSet.approvalStatus,
        active: ruleSet.active,
      },
    }),
  ]);
}

async function appendRuleAudit(
  context: CurrentUserContext,
  rule: ComplianceRule,
  action: AuditLogEntry['action'],
): Promise<void> {
  await appRepositories.auditLogs.appendAuditLogs([
    createUserAuditLogEntry(context, {
      action,
      targetType: 'compliance_rule',
      targetId: rule.id,
      metadata: {
        ruleSetId: rule.ruleSetId,
        priority: rule.priority,
        severity: rule.severity,
        ruleType: rule.ruleType,
      },
    }),
  ]);
}

function extractNumbers(text: string): MeetingMinute['numbers'] {
  const matches = text.match(/\d[\d,]*(?:円|万円|%|％|ヶ月|か月|月|日)?/g) ?? [];
  return [...new Set(matches)].slice(0, 10).map((value, index) => ({
    label: `number_${index + 1}`,
    value,
  }));
}

function getCurrentCallId(): string {
  return activeCallId ?? localSessionId;
}

export interface StartRecordingSessionInput {
  productId: ProductId;
  consent: CallSession['recordingConsent'];
  source: CallSession['source'];
}

/**
 * Canonical recording start. Drives the singleton session state (activeCallId,
 * STT client, native capture, overlay) so the GUI button, IPC, and the
 * salestalk:// URL scheme all share one session — never parallel ones.
 */
export async function startRecordingSession(
  windows: IpcWindowAccessors,
  input: StartRecordingSessionInput,
): Promise<StartRecordingSessionResult> {
  const pendingEnd = callEndPromise;
  if (pendingEnd) {
    await pendingEnd;
  }

  if (callState.status === 'in_call' || recordingStartPromise) {
    // Idempotent: a second start (e.g. Shortcut fired twice) must not spawn a
    // parallel call. Report the already-active one instead.
    return { ok: false, error: 'already_recording', callId: activeCallId ?? undefined };
  }

  recordingStartPromise = startRecordingSessionOnce(windows, input).finally(() => {
    recordingStartPromise = null;
  });
  return recordingStartPromise;
}

async function startRecordingSessionOnce(
  windows: IpcWindowAccessors,
  input: StartRecordingSessionInput,
): Promise<StartRecordingSessionResult> {
  if (callState.status === 'in_call') {
    return { ok: false, error: 'already_recording', callId: activeCallId ?? undefined };
  }

  if (diagnosticStartPromise || realtimeAudioOwner === 'diagnostic') {
    notifyAudioError(windows, '音声診断中は録音を開始できません。診断を停止してから再試行してください。');
    return { ok: false, error: 'start_failed' };
  }

  let context: CurrentUserContext;
  try {
    context = await appRepositories.organizations.assertPermission('recording:start');
  } catch (error) {
    logger.warn({ error }, 'recording start permission denied');
    return { ok: false, error: 'permission_required' };
  }

  if (!preflightAudioCapturePermissions(windows)) {
    return { ok: false, error: 'permission_required' };
  }

  const startedAt = new Date();
  startAudioPreflight(startedAt.getTime());
  audioCaptureStats = createInitialAudioCaptureStats();

  const sttStarted = await tryStartSTT(windows);
  const nativeCaptureStarted = sttStarted ? await tryStartNativeAudioCapture(windows) : false;
  if (!sttStarted || !nativeCaptureStarted) {
    await stopRealtimeAudioServices();
    windows.getControlWindow()?.webContents.send(
      IPC.audio.onError,
      '録音の開始に失敗しました。音声診断を確認してから再試行してください。',
    );
    return { ok: false, error: 'start_failed' };
  }

  let call: CallSession;
  try {
    call = await appRepositories.calls.createCall({
      tenantId: context.tenant.id,
      organizationId: context.organization.id,
      source: input.source,
      industry: 'btob_sales',
      productId: input.productId,
      recordingConsent: input.consent,
      startedAt,
    });
  } catch (error) {
    await runRecordingStartFailureCleanup(
      windows,
      createRecordingStartFailureCleanupPlan({ reason: 'call_create_failed' }),
    );
    logger.warn({ error }, 'call record creation failed after audio startup');
    return { ok: false, error: 'start_failed' };
  }

  try {
    await appendRecordingAuditLogs(context, call.id, input.consent, input.source);
  } catch (error) {
    logger.warn({ error, callId: call.id }, 'call recording audit log failed');
    await runRecordingStartFailureCleanup(
      windows,
      createRecordingStartFailureCleanupPlan({ reason: 'call_audit_failed', callId: call.id }),
    );
    return { ok: false, error: 'start_failed' };
  }

  activeCallId = call.id;
  realtimeAudioOwner = 'call';
  callState = { status: 'in_call', productId: input.productId, startedAt: startedAt.getTime() };
  setCallModeLogging(true);
  notifyCallState(windows);
  windows.getOverlayWindow()?.showInactive();
  logger.info(
    {
      productId: input.productId,
      source: input.source,
      tenantId: context.tenant.id,
      organizationId: context.organization.id,
      consentMethod: input.consent.method,
    },
    'call started',
  );
  return { ok: true, callId: call.id };
}

/** The live recording call id, or null when idle. Unlike getCurrentCallId there is no fallback id. */
export function getActiveRecordingCallId(): string | null {
  return activeCallId;
}

async function persistCurrentTranscript(transcript: Transcript): Promise<void> {
  if (!activeCallId) {
    return;
  }

  try {
    await appRepositories.transcripts.appendTranscript(activeCallId, transcript);
  } catch (error) {
    logger.warn({ error }, 'failed to persist transcript');
  }
}

async function endCurrentCall(windows: IpcWindowAccessors): Promise<void> {
  if (callEndPromise) {
    await callEndPromise;
    return;
  }

  callEndPromise = endCurrentCallOnce(windows).finally(() => {
    callEndPromise = null;
  });
  await callEndPromise;
}

async function endCurrentCallOnce(windows: IpcWindowAccessors): Promise<void> {
  const endedCallId = activeCallId;
  const wasCallActive =
    endedCallId !== null || callState.status === 'in_call' || realtimeAudioOwner === 'call';
  if (wasCallActive) {
    activeObjectionPipelineService?.cancelActive();
  }

  const endCallPromise = endedCallId
    ? appRepositories.calls.endCall(endedCallId).catch((error: unknown) => {
        logger.warn({ error }, 'failed to persist call end');
      })
    : Promise.resolve();
  const stopAudioPromise =
    realtimeAudioOwner === 'call' ? stopRealtimeAudioServices() : Promise.resolve();

  await Promise.all([stopAudioPromise, endCallPromise]);

  activeCallId = null;
  if (realtimeAudioOwner === 'call') {
    realtimeAudioOwner = 'none';
  }
  callState = { status: 'idle' };
  resetAudioPreflight();
  setCallModeLogging(false);
  notifyCallState(windows);
  windows.getOverlayWindow()?.hide();
  if (wasCallActive) {
    for (const listener of callEndedListeners) {
      listener();
    }
  }
}

const callEndedListeners = new Set<() => void>();

/** Notified after a call ends — lets the updater install a deferred update promptly. */
export function onCallEnded(listener: () => void): () => void {
  callEndedListeners.add(listener);
  return () => callEndedListeners.delete(listener);
}

/** True while a sales call is in progress. Used by the updater to defer installs (PRD §32). */
export function isRecordingInProgress(): boolean {
  return callState.status === 'in_call' || recordingStartPromise !== null || callEndPromise !== null;
}

/**
 * Canonical recording stop. Ends whatever session the singleton state holds —
 * so salestalk://record/stop stops a GUI-started session and vice versa.
 */
export async function stopRecordingSession(
  windows: IpcWindowAccessors,
): Promise<{ ok: true; callId: string | null }> {
  const pendingStart = recordingStartPromise;
  if (pendingStart) {
    await pendingStart;
  }

  const endedCallId = activeCallId;
  await endCurrentCall(windows);
  return { ok: true, callId: endedCallId };
}
