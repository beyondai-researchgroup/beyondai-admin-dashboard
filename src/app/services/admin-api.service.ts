import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, firstValueFrom, map, of, timeout } from 'rxjs';
import { AuthService } from './auth.service';

const REQUEST_TIMEOUT_MS = 15_000;

export interface ResearchSummary {
  id: number;
  name: string;
  description: string | null;
  university: string | null;
  city: string | null;
  country: string | null;
  createdAt: string;
  hasPrConfig: boolean;
  usesEeg: boolean;
  eegDeviceType: string | null;
  /** 2026-09-08 follow-up — the consent-andrejkatin entry-point path segment
   *  (`${consentAppUrl}/${slug}`), generated at creation, editable via
   *  updateResearchSlug/PUT /api/admin/consent-form/:researchId/slug. Read-only here. */
  slug: string | null;
}

export interface ResearchDetail extends Omit<ResearchSummary, 'hasPrConfig'> {}

export interface PrConfig {
  id: number;
  label: string;
  owner: string;
  repo: string;
  prNumber: number;
  tokenMasked: string;
  isIntro: boolean;
  createdAt: string;
}

// EEG is deliberately not editable here — it's owned solely by the Study Configuration page
// (updateStudyConfig) now, so there's only one write path for it. ResearchSummary/Detail
// still surface usesEeg/eegDeviceType for read-only display (e.g. the Researches list badge).
//
// The four instrument fields (2026-08-20) are creation-time-only conveniences — updateResearch
// (the edit path) also accepts this same shape, but the edit form never sends them (they stay
// owned by Configuration's own updateStudyConfig/updateTaskType afterward); createResearch is the
// one path that actually uses them, so a new research doesn't have to start with the DB column
// defaults and need an immediate follow-up edit.
export interface ResearchInput {
  name: string;
  description: string | null;
  university: string | null;
  city: string | null;
  country: string | null;
  usesTlx?: boolean;
  tlxCalculateScores?: boolean;
  tlxIncludeWeightings?: boolean;
  usesPsychTests?: boolean;
  taskType?: TaskType;
  /** Study Builder wizard only (Part C of the platform re-architecture, 2026-09-07) — every other
   *  creation path omits it and gets the column's own default (true, matching today's mandatory
   *  consent behavior). */
  usesConsentForm?: boolean;
  /** 2026-09-08 follow-up — creation-time convenience, same pattern as the fields above. Ignored
   *  (forced true) server-side when taskType is 'PR_REVIEW'. */
  tracksParticipants?: boolean;
  consentLanguageSr?: boolean;
  consentLanguageEn?: boolean;
}

export type ResearcherRole = 'OWNER' | 'COLLABORATOR' | 'VIEWER';

export interface ResearcherResearchRef {
  id: number;
  name: string;
  /** Role granularity (Phase 6 of the modular-platform plan) — OWNER/COLLABORATOR keep full
   *  access (matches every assignment's behavior before this phase existed); VIEWER is
   *  read-only, enforced so far only on DELETE /api/admin/experimental-sessions/:id as the
   *  reference implementation. */
  role: ResearcherRole;
  /** 2026-09-08 — 'pending' means an invite email was sent but not yet accepted; this researcher
   *  has NO actual access to that research yet (not in their JWT). 'active' is today's original
   *  meaning, unchanged. */
  status: 'active' | 'pending';
}

// Part B of the platform re-architecture (2026-09-07) — lets a non-superadmin OWNER of a research
// add any existing researcher (from the directory below) to it, without going through the
// superadmin-only researcher-management page.
export interface ResearcherDirectoryEntry {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}

export interface TeamMember {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: ResearcherRole;
  /** 2026-09-08 — 'pending' means an invite was sent but not yet accepted (no real access yet);
   *  'active' is an accepted member. */
  status: 'active' | 'pending';
}

export type AcademicStatus = 'PHD_STUDENT' | 'MASTER' | 'DOCTOR';

export interface ResearcherSummary {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  academicStatus: AcademicStatus | null;
  country: string | null;
  isSuperAdmin: boolean;
  createdAt: string;
  mustChangePassword: boolean;
  researches: ResearcherResearchRef[];
}

/** POST /api/admin/researchers (brand-new account — sends an invite email, no password field:
 *  the account gets a random unusable password until the invite is accepted). */
export interface NewResearcherInput {
  firstName: string;
  lastName: string;
  email: string;
  dateOfBirth: string | null;
  academicStatus: AcademicStatus | null;
  country: string | null;
  isSuperAdmin: boolean;
  researchIds: number[];
  /** Optional per-research role for entries in researchIds; any id omitted here defaults to
   *  OWNER server-side (today's behavior, unchanged). */
  researchRoles?: Partial<Record<number, ResearcherRole>>;
  lang: 'sr' | 'en';
}

export interface NewResearcherResult extends ResearcherSummary {
  inviteEmailSent: boolean;
}

/** PUT /api/admin/researchers/:id — editing an existing account, or "add an existing researcher
 *  to a research" (resend the same profile fields with an expanded researchIds set, no invite). */
export interface ResearcherInput {
  firstName: string;
  lastName: string;
  email: string;
  dateOfBirth: string | null;
  academicStatus: AcademicStatus | null;
  country: string | null;
  /** Only sent when a superadmin is force-resetting someone else's password. */
  newPassword?: string;
  isSuperAdmin: boolean;
  researchIds: number[];
  /** See NewResearcherInput's doc comment — same optional per-research role map. */
  researchRoles?: Partial<Record<number, ResearcherRole>>;
}

export interface MyProfile {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  academicStatus: AcademicStatus | null;
  country: string | null;
  isSuperAdmin: boolean;
  language: 'sr' | 'en';
  hasAvatar: boolean;
  researches: ResearcherResearchRef[];
}

export interface MyProfileInput {
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  academicStatus: AcademicStatus | null;
  country: string | null;
  language: 'sr' | 'en';
}

export type InviteResolveErrorCode = 'NOT_FOUND' | 'EXPIRED' | 'ALREADY_USED';

export interface InviteResolveResult {
  email: string;
  firstName: string;
  lastName: string;
}

export type TaskType = 'PR_REVIEW' | 'GOOGLE_FORMS' | 'GENERIC';

export interface TaskConfig {
  taskType: TaskType;
  taskTypes: TaskType[];
  googleFormsUrl: string | null;
  taskInstructions: string | null;
}

export type AnalysisRunStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'TIMEOUT';

export interface AnalysisScriptMeta {
  exists: boolean;
  id?: number;
  originalFilename?: string;
  uploadedAt?: string;
}

export interface AnalysisRunSummary {
  id: number;
  status: AnalysisRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface AnalysisRunPlotMeta {
  id: number;
  filename: string;
}

export interface AnalysisRunDetail extends AnalysisRunSummary {
  stdOut: string | null;
  stdErr: string | null;
  resultsText: string | null;
  plots: AnalysisRunPlotMeta[];
}

export interface TaskFileMeta {
  id: number;
  originalFilename: string;
  contentType: string | null;
  fileSizeBytes: number;
  uploadedAt: string;
}

/** Fixed checkbox categories for the task-app upload zone — must match the backend's
 *  FILE_TYPE_CATEGORIES allowlist (server/generic-tasks/routes.mjs) and task-app-andrejkatin's
 *  own copy of the same extension mapping exactly. */
export const GENERIC_TASK_FILE_TYPES = ['PDF', 'WORD', 'EXCEL', 'POWERPOINT', 'ZIP', 'IMAGE', 'TEXT'] as const;
export type GenericTaskFileType = (typeof GENERIC_TASK_FILE_TYPES)[number];

export interface GenericTaskMeta {
  id: number;
  title: string;
  hasText: boolean;
  hasPdf: boolean;
  pdfFilename: string | null;
  createdAt: string;
  timerMinutes: number;
  allowedFileTypes: GenericTaskFileType[];
  allowMultipleFiles: boolean;
}

export interface GenericTaskDetail {
  id: number;
  title: string;
  instructionsText: string | null;
  hasPdf: boolean;
  pdfFilename: string | null;
  createdAt: string;
  timerMinutes: number;
  allowedFileTypes: GenericTaskFileType[];
  allowMultipleFiles: boolean;
}

export interface GenericTaskAssignableParticipant {
  participantId: string;
  firstName: string | null;
  lastName: string | null;
  genericTaskId: number | null;
}

export interface GenericTaskSubmissionFile {
  id: number;
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface GenericTaskSubmission {
  submissionId: number;
  participantId: string;
  taskTitle: string;
  isTimedOut: boolean;
  submittedAt: string;
  files: GenericTaskSubmissionFile[];
}

export interface ConsentSection {
  id?: number;
  titleSr: string | null;
  titleEn: string | null;
  bodySr: string;
  bodyEn: string;
}

export interface ConsentConfig {
  sections: ConsentSection[];
  checkboxTextSr: string;
  checkboxTextEn: string;
}

export interface DemographicQuestionOption {
  id?: number;
  labelSr: string;
  labelEn: string;
  isOtherSpecify: boolean;
}

export interface DemographicQuestion {
  id?: number;
  type: 'TEXT' | 'SINGLE_CHOICE';
  promptSr: string;
  promptEn: string;
  options: DemographicQuestionOption[];
}

export interface DemographicResponseRow {
  participantId: string;
  language: string;
  answers: Record<string, { value: string; otherText?: string }>;
  completedAt: string;
}

export interface DemographicResultsRaw {
  questions: DemographicQuestion[];
  responses: DemographicResponseRow[];
}

export interface DemographicAggregateQuestion {
  questionId: number;
  type: 'TEXT' | 'SINGLE_CHOICE';
  promptSr: string;
  promptEn: string;
  /** TEXT questions only. */
  textAnswers?: string[];
  /** SINGLE_CHOICE questions only. */
  optionCounts?: { optionId: number; labelSr: string; labelEn: string; count: number }[];
  otherTexts?: string[];
}

export interface DemographicResultsAggregate {
  totalResponses: number;
  questions: DemographicAggregateQuestion[];
}

export type MailingListRowErrorCode = 'INVALID_EMAIL' | 'INVALID_LANGUAGE' | 'SEND_FAILED';
export interface MailingListRowError {
  row: number;
  reasonCode: MailingListRowErrorCode;
}

/** One stored review-session activity log (metadata only — the CSV itself is fetched separately). */
export interface ActivityLogMeta {
  id: number;
  sessionId: number;
  sessionName: string;
  reviewMode: string;
  originalFilename: string;
  rowCount: number;
  savedAt: string;
}

/** A single activity log with its CSV already parsed into table-ready columns + rows. */
export interface ActivityLogDetail extends ActivityLogMeta {
  columns: string[];
  rows: Record<string, string | null>[];
}

export interface EegMeta {
  exists: boolean;
  originalFilename?: string;
  deviceType?: string | null;
  rowCount?: number;
  columns?: string[];
  uploadedAt?: string;
}

export interface EegPreview {
  columns: string[];
  rows: Record<string, string | null>[];
}

export interface EegMarker {
  code: string;
  timestamp: string;
}

export interface EegBandSeries {
  theta: (number | null)[];
  alpha: (number | null)[];
  betaL: (number | null)[];
  betaH: (number | null)[];
  gamma: (number | null)[];
}

export interface EegIndexSeries {
  timestamps: string[];
  elapsedSeconds: (number | null)[];
  engagement: (number | null)[];
  cognitiveLoad: (number | null)[];
  frontalAsymmetry: (number | null)[];
  bands: EegBandSeries;
}

export interface EegSegment {
  label: string;
  avgIndices: { engagement: number | null; cognitiveLoad: number | null; frontalAsymmetry: number | null };
  /** Device-reported Cortex contact-quality (0-100%) — a raw quality metric, not a composite
   *  index, so it's a sibling field rather than nested inside avgIndices. */
  avgSignalQuality: number | null;
}

export type EegInterpretation =
  | { recognized: false }
  | {
      recognized: true;
      markers: EegMarker[];
      series: EegIndexSeries;
      segments: EegSegment[];
      avgSignalQuality: number | null;
    };

export interface ParticipantSessionRow {
  sessionId: number;
  sessionName: string;
  sequenceOrder: number;
  isFinished: boolean;
  /** Set only when this session has an explicit PR override (via the PrAssignments import
   *  sheet) — null falls back to the research's active PR config at review time. */
  prNumber: number | null;
  /** Null means this session was never tied to an Experimental Session — expected before it's
   *  scheduled, but a warning sign if isFinished is also true. */
  experimentalSessionId: number | null;
}

export interface ParticipantRow {
  participantId: string;
  firstName: string | null;
  lastName: string | null;
  researchId: number;
  isTestParticipant: boolean;
  sessions: ParticipantSessionRow[];
}

export type LinkType = 'CODE_REVIEW' | 'CONSENT_ENTRY' | 'REI40' | 'BIGFIVE' | 'DEMOGRAPHIC';

export interface ParticipantLink {
  type: LinkType;
  url: string;
  createdAt: string;
  expiresAt: string;
  status: 'valid' | 'expired';
}

export type TimelineStepKey =
  | 'consent' | 'questionnaires' | 'intro' | 'scheduled' | 'experimentalSession1' | 'experimentalSession2';

export interface TimelineStep {
  step: TimelineStepKey;
  status: 'done' | 'current' | 'pending' | 'skipped';
  at: string | null;
}

export interface ParticipantOverview {
  participantId: string;
  isTestParticipant: boolean;
  baselineDoneAt: string | null;
  hasEmail: boolean;
  links: ParticipantLink[];
  timeline: TimelineStep[];
  scheduling: {
    experimentalSession1: ParticipantOverviewScheduledSession | null;
    experimentalSession2: ParticipantOverviewScheduledSession | null;
  };
}

/** One scheduled experimental session's info, as surfaced on the Participant Detail Timeline —
 *  `id`/`label` let the researcher jump straight to that Experimental Session's own detail page. */
export interface ParticipantOverviewScheduledSession {
  date: string | null;
  time: string | null;
  id: number;
  label: string | null;
  googleCalendarEventId: string | null;
  googleCalendarEventUrl: string | null;
}

export type ImportTaskErrorCode = 'NOT_FOUND' | 'WRONG_RESEARCH' | 'TASK_NOT_FOUND' | 'SESSION_NOT_FOUND';

export interface ImportTaskError {
  participantId: string;
  reasonCode: ImportTaskErrorCode;
}

export interface ImportResult {
  participants: { imported: string[]; skippedExisting: string[] };
  /** introAdded: participants who got their Intro session auto-inserted by this import (see
   *  server/participants/routes.mjs's POST /import — Intro is never listed in the Tasks sheet). */
  tasks: { introAdded: string[]; assigned: string[]; errors: ImportTaskError[] };
}

export type Instrument = 'tlx' | 'rei40' | 'bigfive';

/** Per-research instrument configuration — see server/study-config/routes.mjs. */
export interface StudyConfig {
  usesEeg: boolean;
  eegDeviceType: string | null;
  /** Whether the admin dashboard's Results menu shows "NASA-TLX" for this research. Does not
   *  affect the separate NASA-TLX app's own participant-facing flow — TLX is still run for
   *  every participant there regardless of this flag; it only hides the results view here. */
  usesTlx: boolean;
  tlxCalculateScores: boolean;
  tlxIncludeWeightings: boolean;
  rei40Variant: string;
  /** Every REI-40 variant id the dropdown may offer — just `['v1']` today. */
  rei40Variants: string[];
  /** True once any participant in this research has a Rei40Result — rei40Variant can no
   *  longer be changed through this page (mixing item-sets under one variant label). */
  rei40VariantLocked: boolean;
  /** Phase D of platform-ification — when false, the Consent app skips REI-40/Big Five token
   *  issuance entirely and sends a fixed-template thank-you email instead. */
  usesPsychTests: boolean;
  /** The only configurable piece of that thank-you email's fixed copy. Falls back to the
   *  research's own Name server-side, so this is never blank in practice. */
  studyDisplayName: string;
  /** Optional override for the display-name portion of every participant-facing email this
   *  research sends (consent, regenerate-links, thank-you) — null falls back to studyDisplayName,
   *  then the research's raw Name, then each email builder's own hardcoded default. Gmail SMTP
   *  with a single sending account only allows changing the display name, never the actual
   *  address — a real ceiling, not a shortcut. */
  emailSenderName: string | null;
  /** Part C of the platform re-architecture (2026-09-07) — when false, this research's Consent
   *  Form nav entry hides itself and consent-andrejkatin skips the consent screen entirely for
   *  its participants, showing a shared "your links" page instead. Defaults true — every existing
   *  research keeps requiring consent exactly as before this toggle existed. */
  usesConsentForm: boolean;
  /** Demographic Questionnaire (2026-10-01) — when true, a DEMOGRAPHIC link is minted and emailed
   *  (same send as REI-40/Big Five, labeled "Demografski upitnik"/"Demographic questionnaire", not
   *  part of the numbered "Upitnik N" sequence), and the Demographic Questions nav entry + Results-
   *  menu item appear. Defaults false — unlike usesPsychTests/usesTlx, this is a brand-new feature
   *  nobody has authored content for yet, so it stays off until a researcher explicitly turns it on. */
  usesDemographics: boolean;
  /** 2026-09-08 follow-up — whether Participants/Import/Experimental-Sessions are shown at all
   *  for this research. Always true (and un-editable) for TaskType='PR_REVIEW', which structurally
   *  requires participants; optional for every other task type. */
  tracksParticipants: boolean;
  /** Which language(s) a participant is offered at their very first Consent-app login — at least
   *  one is always true. Both true = today's SR/EN picker; exactly one = the picker is skipped
   *  and that language auto-locked. */
  consentLanguageSr: boolean;
  consentLanguageEn: boolean;
  /** Per-app participant timer (2026-09-11) — independently configurable per app, only offered in
   *  the UI for an app this research actually uses. On expiry the participant app auto-submits
   *  whatever is currently entered. `*Minutes` is null whenever its `*Enabled` is false (enforced
   *  server-side regardless of what's sent). */
  timerCodeReviewEnabled: boolean;
  timerCodeReviewMinutes: number | null;
  timerRei40Enabled: boolean;
  timerRei40Minutes: number | null;
  timerBigFiveEnabled: boolean;
  timerBigFiveMinutes: number | null;
  timerNasaTlxEnabled: boolean;
  timerNasaTlxMinutes: number | null;
}

export type RegenerateLinksErrorCode = 'NOT_FOUND' | 'NOT_CONSENTED' | 'NO_EMAIL' | 'NO_LINKS_TO_ISSUE' | 'SERVER_ERROR';
export type SendConsentEmailErrorCode = 'NOT_FOUND' | 'CONSENT_NOT_USED' | 'NO_EMAIL' | 'SERVER_ERROR';
export type UpdateStudyConfigErrorCode = 'REI40_VARIANT_LOCKED' | 'SERVER_ERROR';

export interface ExperimentalSessionSummary {
  id: number;
  researchId: number;
  sessionDate: string;
  label: string | null;
  notes: string | null;
  createdAt: string;
  participantSessionCount: number;
}

export interface ExperimentalSessionParticipantRow {
  participantId: string;
  sessionId: number;
  sessionName: string;
  isFinished: boolean;
  notes: string | null;
  /** HH:MM — required when assigned via assignParticipantSession, cleared on unassign. */
  scheduledTime: string | null;
  /** Predefined tag ids (see session-tags.ts) and/or free-form custom strings. */
  tags: string[];
  /** Set once a Google Calendar event has been created for this row (see googleCalendar.mjs); null if unsynced. */
  googleCalendarEventId: string | null;
  /** The real "open in Google Calendar" link (htmlLink) — null for a row synced before this field
   *  existed (has an EventId but no stored URL yet) until it's reassigned/rescheduled. */
  googleCalendarEventUrl: string | null;
}

export interface ExperimentalSessionDetail {
  id: number;
  researchId: number;
  sessionDate: string;
  label: string | null;
  notes: string | null;
  createdAt: string;
  participantSessions: ExperimentalSessionParticipantRow[];
}

export interface CalendarStatus {
  connected: boolean;
  email: string | null;
}

// Part G of the platform re-architecture (2026-09-07) — mirrors CalendarStatus's shape exactly,
// separate connection (own OAuth client/columns — see server/google-forms/).
export interface GoogleFormsStatus {
  connected: boolean;
  email: string | null;
}

export type FormQuestionType = 'NUMBER' | 'TEXT' | 'LIKERT' | 'CHOICE';
export type FormQuestionSource = 'GOOGLE_FORMS' | 'MANUAL';

export interface FormQuestion {
  id?: number;
  columnKey: string;
  label: string;
  questionType: FormQuestionType;
  source: FormQuestionSource;
  // 2026-09-08 follow-up — at most one question across the whole array may have this true (the
  // CSV column matched against imported Participant.ParticipantId).
  isParticipantIdColumn?: boolean;
}

export interface DescriptiveStatsColumn {
  columnKey: string;
  label: string;
  questionType: FormQuestionType | 'CHOICE';
  mapped: boolean;
  count: number;
  mean?: number | null;
  stddev?: number | null;
  min?: number | null;
  max?: number | null;
  // NUMBER/LIKERT/CHOICE all carry a value→count distribution now (2026-09-08) — powers the
  // master-detail table's per-question chart, one consistent chart shape per question type.
  frequencies?: { value: string; count: number }[];
  // TEXT only — free text has nothing to chart, so the detail view lists the actual responses.
  sampleAnswers?: string[];
}

export type TaskFileUploadRejectReason = 'NOT_CSV' | 'FORM_MISMATCH' | 'CSV_PARSE_ERROR';
export interface TaskFileUploadRejection {
  filename: string;
  reason: TaskFileUploadRejectReason;
  matched?: number;
  total?: number;
}

// 2026-09-08 follow-up — present only when a research has designated a participant-ID column
// (TaskFormQuestion.IsParticipantIdColumn); `null` means "not configured", not "nobody responded".
export interface ParticipantMatchSummary {
  idColumnKey: string;
  totalParticipants: number;
  matchedCount: number;
  notResponded: { participantId: string; firstName: string | null; lastName: string | null }[];
}

export interface DescriptiveStatsResult {
  sourceFilename: string;
  rowCount: number;
  columns: DescriptiveStatsColumn[];
  participantMatch: ParticipantMatchSummary | null;
}

export interface ParticipantSurveyAnswer {
  columnKey: string;
  label: string;
  value: string;
}

export type NotificationType = 'PARTICIPANT_IMPORT' | 'EXPERIMENTAL_SESSION_CREATED' | 'SESSION_REMINDER';

export interface NotificationItem {
  id: number;
  researchId: number | null;
  researchName: string | null;
  type: NotificationType;
  message: string;
  isRead: boolean;
  createdAt: string;
}

export interface AggregateResult {
  count: number;
  means: Record<string, number | null>;
  stdDevs: Record<string, number | null>;
}

/** Thin wrapper around every /api/admin/* call used by the dashboard. */
@Injectable({ providedIn: 'root' })
export class AdminApiService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  private req<T>(obs: import('rxjs').Observable<T>): Promise<T> {
    return firstValueFrom(obs.pipe(timeout(REQUEST_TIMEOUT_MS)));
  }

  getResearches(): Promise<ResearchSummary[]> {
    return this.req(this.http.get<ResearchSummary[]>('/api/admin/researches'));
  }

  getResearch(id: number): Promise<ResearchDetail> {
    return this.req(this.http.get<ResearchDetail>(`/api/admin/researches/${id}`));
  }

  createResearch(body: ResearchInput): Promise<ResearchSummary> {
    return this.req(this.http.post<ResearchSummary>('/api/admin/researches', body));
  }

  updateResearch(id: number, body: ResearchInput): Promise<{ ok: true }> {
    return this.req(this.http.put<{ ok: true }>(`/api/admin/researches/${id}`, body));
  }

  getPrConfigs(researchId: number): Promise<PrConfig[]> {
    return this.req(this.http.get<PrConfig[]>(`/api/admin/researches/${researchId}/pr-configs`));
  }

  addPrConfig(
    researchId: number,
    body: { label: string; owner: string; repo: string; prNumber: number; token: string; isIntro?: boolean }
  ): Promise<PrConfig> {
    return this.req(this.http.post<PrConfig>(`/api/admin/researches/${researchId}/pr-configs`, body));
  }

  updatePrConfig(
    researchId: number,
    configId: number,
    body: { label?: string; isIntro?: boolean }
  ): Promise<{ ok: true }> {
    return this.req(this.http.put<{ ok: true }>(`/api/admin/researches/${researchId}/pr-configs/${configId}`, body));
  }

  deletePrConfig(researchId: number, configId: number): Promise<{ ok: true }> {
    return this.req(this.http.delete<{ ok: true }>(`/api/admin/researches/${researchId}/pr-configs/${configId}`));
  }

  getResearcherDirectory(): Promise<ResearcherDirectoryEntry[]> {
    return this.req(this.http.get<ResearcherDirectoryEntry[]>('/api/admin/researchers/directory'));
  }

  getTeam(researchId: number): Promise<TeamMember[]> {
    return this.req(this.http.get<TeamMember[]>(`/api/admin/researches/${researchId}/team`));
  }

  async updateTeamMember(
    researchId: number,
    researcherId: number,
    role: ResearcherRole
  ): Promise<{ ok: true; status: 'updated' | 'invited' } | { ok: false; error?: string }> {
    try {
      const res = await this.req(
        this.http.put<{ ok: true; status: 'updated' | 'invited' }>(`/api/admin/researches/${researchId}/team/${researcherId}`, { role })
      );
      return res;
    } catch (err: any) {
      return { ok: false, error: err?.error?.error };
    }
  }

  async removeTeamMember(researchId: number, researcherId: number): Promise<{ ok: true } | { ok: false; error?: string }> {
    try {
      await this.req(this.http.delete<{ ok: true }>(`/api/admin/researches/${researchId}/team/${researcherId}`));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error };
    }
  }

  getResearchers(): Promise<ResearcherSummary[]> {
    return this.req(this.http.get<ResearcherSummary[]>('/api/admin/researchers'));
  }

  createResearcher(body: NewResearcherInput): Promise<NewResearcherResult> {
    return this.req(this.http.post<NewResearcherResult>('/api/admin/researchers', body));
  }

  updateResearcher(id: number, body: ResearcherInput): Promise<{ ok: true; newInvites: number }> {
    return this.req(this.http.put<{ ok: true; newInvites: number }>(`/api/admin/researchers/${id}`, body));
  }

  // ── Team invite (public — no auth header needed, the token itself authenticates) ────────────
  resolveTeamInvite(
    token: string
  ): Promise<{ ok: true; researchName: string; researcherFirstName: string } | { ok: false; error: 'NOT_FOUND' | 'EXPIRED' | 'ALREADY_ACCEPTED' }> {
    return firstValueFrom(
      this.http.get<{ researchName: string; researcherFirstName: string }>(`/api/team-invite/${token}`).pipe(
        timeout(REQUEST_TIMEOUT_MS),
        map((result) => ({ ok: true as const, ...result })),
        catchError((err) => {
          const code = err?.error?.error;
          if (code === 'EXPIRED') return of({ ok: false as const, error: 'EXPIRED' as const });
          if (code === 'ALREADY_ACCEPTED') return of({ ok: false as const, error: 'ALREADY_ACCEPTED' as const });
          return of({ ok: false as const, error: 'NOT_FOUND' as const });
        })
      )
    );
  }

  acceptTeamInvite(
    token: string
  ): Promise<{ ok: true; researchName: string } | { ok: false; error: 'NOT_FOUND' | 'EXPIRED' | 'ALREADY_ACCEPTED' | 'SERVER_ERROR' }> {
    return firstValueFrom(
      this.http.post<{ ok: true; researchName: string }>(`/api/team-invite/${token}/accept`, {}).pipe(
        timeout(REQUEST_TIMEOUT_MS),
        map((result) => ({ ...result, ok: true as const })),
        catchError((err) => {
          const code = err?.error?.error;
          if (code === 'EXPIRED') return of({ ok: false as const, error: 'EXPIRED' as const });
          if (code === 'ALREADY_ACCEPTED') return of({ ok: false as const, error: 'ALREADY_ACCEPTED' as const });
          if (code === 'NOT_FOUND') return of({ ok: false as const, error: 'NOT_FOUND' as const });
          return of({ ok: false as const, error: 'SERVER_ERROR' as const });
        })
      )
    );
  }

  deleteResearcher(id: number): Promise<{ ok: true }> {
    return this.req(this.http.delete<{ ok: true }>(`/api/admin/researchers/${id}`));
  }

  // ── Researcher invite (public — no auth header needed, the token itself authenticates) ──────

  resolveResearcherInvite(
    token: string
  ): Promise<{ ok: true; result: InviteResolveResult } | { ok: false; error: InviteResolveErrorCode }> {
    return firstValueFrom(
      this.http.get<InviteResolveResult>(`/api/researcher-invite/${token}`).pipe(
        timeout(REQUEST_TIMEOUT_MS),
        map((result) => ({ ok: true as const, result })),
        catchError((err) => {
          const code = err?.error?.error;
          if (code === 'EXPIRED') return of({ ok: false as const, error: 'EXPIRED' as const });
          if (code === 'ALREADY_USED') return of({ ok: false as const, error: 'ALREADY_USED' as const });
          return of({ ok: false as const, error: 'NOT_FOUND' as const });
        })
      )
    );
  }

  acceptResearcherInvite(
    token: string,
    newPassword: string
  ): Promise<{ ok: true } | { ok: false; error: InviteResolveErrorCode | 'SERVER_ERROR' }> {
    return firstValueFrom(
      this.http.post<{ ok: true }>(`/api/researcher-invite/${token}/accept`, { newPassword }).pipe(
        timeout(REQUEST_TIMEOUT_MS),
        map(() => ({ ok: true as const })),
        catchError((err) => {
          const code = err?.error?.error;
          if (code === 'EXPIRED') return of({ ok: false as const, error: 'EXPIRED' as const });
          if (code === 'ALREADY_USED') return of({ ok: false as const, error: 'ALREADY_USED' as const });
          if (code === 'NOT_FOUND') return of({ ok: false as const, error: 'NOT_FOUND' as const });
          return of({ ok: false as const, error: 'SERVER_ERROR' as const });
        })
      )
    );
  }

  // ── My profile (self-service) ─────────────────────────────────────────────────────────────

  getMyProfile(): Promise<MyProfile> {
    return this.req(this.http.get<MyProfile>('/api/admin/researcher-profile/me'));
  }

  updateMyProfile(body: MyProfileInput): Promise<{ ok: true }> {
    return this.req(this.http.put<{ ok: true }>('/api/admin/researcher-profile/me', body));
  }

  changeMyPassword(
    currentPassword: string,
    newPassword: string
  ): Promise<{ ok: true } | { ok: false; error: 'CURRENT_PASSWORD_INCORRECT' | 'SERVER_ERROR' }> {
    return firstValueFrom(
      this.http.post<{ ok: true }>('/api/admin/researcher-profile/me/password', { currentPassword, newPassword }).pipe(
        timeout(REQUEST_TIMEOUT_MS),
        map(() => ({ ok: true as const })),
        catchError((err) => {
          const code = err?.error?.error;
          if (code === 'CURRENT_PASSWORD_INCORRECT') return of({ ok: false as const, error: 'CURRENT_PASSWORD_INCORRECT' as const });
          return of({ ok: false as const, error: 'SERVER_ERROR' as const });
        })
      )
    );
  }

  uploadMyAvatar(file: File): Promise<{ ok: true }> {
    const formData = new FormData();
    formData.append('avatar', file);
    return this.req(this.http.post<{ ok: true }>('/api/admin/researcher-profile/me/avatar', formData));
  }

  /** The raw endpoint URL — NOT directly usable as an `<img src>`: the route sits behind
   *  requireAuth and a plain `<img>` tag can't carry the Authorization header (same limitation
   *  documented for task-file/EEG downloads elsewhere in this app). Use
   *  `fetchAvatarObjectUrl` instead to actually render one. */
  avatarUrl(researcherId: number): string {
    return `/api/admin/researcher-profile/${researcherId}/avatar`;
  }

  /** Authenticated fetch + Blob + ObjectURL — same pattern as `fetchAnalysisPlotObjectUrl` — so
   *  the Bearer token actually reaches the protected avatar route. Returns null if the
   *  researcher has no avatar (a 404) rather than throwing, since "no avatar yet" is the normal
   *  case, not an error; the caller should fall back to initials. Remember to
   *  `URL.revokeObjectURL(...)` the previous one before fetching a new one, to avoid leaking
   *  blob URLs. */
  async fetchAvatarObjectUrl(researcherId: number): Promise<string | null> {
    const token = this.auth.token();
    const res = await fetch(this.avatarUrl(researcherId), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  leaveResearch(researchId: number): Promise<{ ok: true } | { ok: false; error: 'LAST_RESEARCH' | 'SERVER_ERROR' }> {
    return firstValueFrom(
      this.http.delete<{ ok: true }>(`/api/admin/researcher-profile/me/researches/${researchId}`).pipe(
        timeout(REQUEST_TIMEOUT_MS),
        map(() => ({ ok: true as const })),
        catchError((err) => {
          const code = err?.error?.error;
          if (code === 'LAST_RESEARCH') return of({ ok: false as const, error: 'LAST_RESEARCH' as const });
          return of({ ok: false as const, error: 'SERVER_ERROR' as const });
        })
      )
    );
  }

  // ── Notifications ─────────────────────────────────────────────────────────────────────────

  getNotifications(): Promise<NotificationItem[]> {
    return this.req(this.http.get<NotificationItem[]>('/api/admin/notifications'));
  }

  getUnreadNotificationCount(): Promise<{ count: number }> {
    return this.req(this.http.get<{ count: number }>('/api/admin/notifications/unread-count'));
  }

  markNotificationRead(id: number): Promise<{ ok: true }> {
    return this.req(this.http.post<{ ok: true }>(`/api/admin/notifications/${id}/read`, {}));
  }

  markAllNotificationsRead(): Promise<{ ok: true }> {
    return this.req(this.http.post<{ ok: true }>('/api/admin/notifications/read-all', {}));
  }

  getTaskConfig(researchId: number): Promise<TaskConfig> {
    return this.req(this.http.get<TaskConfig>(`/api/admin/task-config/${researchId}`));
  }

  updateTaskType(researchId: number, taskType: TaskType): Promise<{ ok: true }> {
    return this.req(this.http.put<{ ok: true }>(`/api/admin/task-config/${researchId}`, { taskType }));
  }

  updateTaskDetails(
    researchId: number,
    body: { googleFormsUrl?: string | null; taskInstructions?: string | null }
  ): Promise<{ ok: true }> {
    return this.req(this.http.put<{ ok: true }>(`/api/admin/task-config/${researchId}/details`, body));
  }

  // Standardized export — Phase 5 of the modular-platform plan. Additive: existing per-page
  // download buttons (Results TLX/REI-40/Big Five, R Analysis) keep using their own bespoke
  // export/download calls, untouched — this is exposed for future use (e.g. a unified export
  // picker) without risking any currently-working download link.
  buildResultsExportUrl(researchId: number, instrumentCode: 'NASA_TLX' | 'REI40' | 'BIGFIVE' | 'R_ANALYSIS', participantId?: string): string {
    const base = `/api/admin/results-export/${researchId}/${instrumentCode}/export`;
    return participantId ? `${base}?participantId=${encodeURIComponent(participantId)}` : base;
  }

  /** Downloads via the standardized results-export endpoint — same authenticated
   *  fetch+blob+synthetic-<a> mechanics as exportCsv()/downloadTaskFile()/downloadEeg() (a plain
   *  <a href> can't carry the Bearer token requireAuth needs). Filename comes from the response's
   *  Content-Disposition header (the backend always sets one) with a generic fallback. Throws
   *  NO_SUCCESSFUL_RUN (surfaced via the thrown Error's message) when instrumentCode is
   *  R_ANALYSIS and no run has ever succeeded — callers should catch and show a friendly message. */
  async exportResultsFile(
    researchId: number,
    instrumentCode: 'NASA_TLX' | 'REI40' | 'BIGFIVE' | 'R_ANALYSIS',
    participantId?: string
  ): Promise<void> {
    const token = this.auth.token();
    const res = await fetch(this.buildResultsExportUrl(researchId, instrumentCode, participantId), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      if (res.status === 404) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'NOT_FOUND');
      }
      throw new Error(`Export failed: ${res.status}`);
    }

    const disposition = res.headers.get('Content-Disposition');
    const filenameMatch = disposition?.match(/filename="([^"]+)"/);
    const filename = filenameMatch?.[1] ?? `${instrumentCode.toLowerCase()}-export`;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  getTaskFiles(researchId: number): Promise<TaskFileMeta[]> {
    return this.req(this.http.get<TaskFileMeta[]>(`/api/admin/task-files/${researchId}`));
  }

  async uploadTaskFiles(
    researchId: number,
    files: File[]
  ): Promise<{ ok: true; files: TaskFileMeta[] } | { ok: false; error: string; details?: TaskFileUploadRejection[] }> {
    const formData = new FormData();
    for (const file of files) formData.append('files', file, file.name);
    try {
      const uploaded = await this.req(this.http.post<TaskFileMeta[]>(`/api/admin/task-files/${researchId}`, formData));
      return { ok: true, files: uploaded };
    } catch (err: any) {
      // The Google-Forms CSV-only / form-match validation (2026-09-08) responds 400 with a
      // structured `details` list — surfaced as-is so the component can show exactly which file(s)
      // failed and why, instead of one generic "upload failed" message.
      const body = err?.error;
      return { ok: false, error: body?.error ?? 'UPLOAD_FAILED', details: body?.details };
    }
  }

  deleteTaskFile(researchId: number, fileId: number): Promise<{ ok: true }> {
    return this.req(this.http.delete<{ ok: true }>(`/api/admin/task-files/${researchId}/${fileId}`));
  }

  /** Downloads a task file — can't use a plain <a href> since it needs the auth header. */
  async downloadTaskFile(researchId: number, fileId: number, filename: string): Promise<void> {
    const token = this.auth.token();
    const res = await fetch(`/api/admin/task-files/${researchId}/${fileId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // --- Generic Task multi-task + assignment (2026-09-11) ---

  getGenericTasks(researchId: number): Promise<GenericTaskMeta[]> {
    return this.req(this.http.get<GenericTaskMeta[]>(`/api/admin/generic-tasks/${researchId}`));
  }

  getGenericTask(researchId: number, taskId: number): Promise<GenericTaskDetail> {
    return this.req(this.http.get<GenericTaskDetail>(`/api/admin/generic-tasks/${researchId}/${taskId}`));
  }

  private async saveGenericTask(
    url: string,
    method: 'POST' | 'PUT',
    fields: {
      title: string;
      instructionsText: string;
      timerMinutes: number;
      allowedFileTypes: GenericTaskFileType[];
      allowMultipleFiles: boolean;
      removePdf?: boolean;
    },
    pdfFile: File | null
  ): Promise<{ ok: true; task: GenericTaskMeta } | { ok: false; error: string }> {
    const formData = new FormData();
    formData.append('title', fields.title);
    formData.append('instructionsText', fields.instructionsText);
    formData.append('timerMinutes', String(fields.timerMinutes));
    formData.append('allowedFileTypes', JSON.stringify(fields.allowedFileTypes));
    formData.append('allowMultipleFiles', String(fields.allowMultipleFiles));
    if (fields.removePdf) formData.append('removePdf', 'true');
    if (pdfFile) formData.append('pdf', pdfFile, pdfFile.name);
    try {
      const task = await this.req(
        method === 'POST'
          ? this.http.post<GenericTaskMeta>(url, formData)
          : this.http.put<GenericTaskMeta>(url, formData)
      );
      return { ok: true, task };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SAVE_FAILED' };
    }
  }

  createGenericTask(
    researchId: number,
    fields: { title: string; instructionsText: string; timerMinutes: number; allowedFileTypes: GenericTaskFileType[]; allowMultipleFiles: boolean },
    pdfFile: File | null
  ): Promise<{ ok: true; task: GenericTaskMeta } | { ok: false; error: string }> {
    return this.saveGenericTask(`/api/admin/generic-tasks/${researchId}`, 'POST', fields, pdfFile);
  }

  updateGenericTask(
    researchId: number,
    taskId: number,
    fields: { title: string; instructionsText: string; timerMinutes: number; allowedFileTypes: GenericTaskFileType[]; allowMultipleFiles: boolean; removePdf?: boolean },
    pdfFile: File | null
  ): Promise<{ ok: true; task: GenericTaskMeta } | { ok: false; error: string }> {
    return this.saveGenericTask(`/api/admin/generic-tasks/${researchId}/${taskId}`, 'PUT', fields, pdfFile);
  }

  deleteGenericTask(researchId: number, taskId: number): Promise<{ ok: true }> {
    return this.req(this.http.delete<{ ok: true }>(`/api/admin/generic-tasks/${researchId}/${taskId}`));
  }

  /** Same fetch+blob+synthetic-<a> mechanics as downloadTaskFile — needs the auth header. */
  async downloadGenericTaskPdf(researchId: number, taskId: number, filename: string): Promise<void> {
    const token = this.auth.token();
    const res = await fetch(`/api/admin/generic-tasks/${researchId}/${taskId}/pdf`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // --- Task-app submission results (2026-09-14) — download-only ---

  getGenericTaskSubmissions(researchId: number): Promise<GenericTaskSubmission[]> {
    return this.req(this.http.get<GenericTaskSubmission[]>(`/api/admin/generic-task-results/${researchId}/submissions`));
  }

  /** Same fetch+blob+synthetic-<a> mechanics as downloadGenericTaskPdf/downloadTaskFile. */
  async downloadGenericTaskSubmissionFile(researchId: number, submissionId: number, fileId: number, filename: string): Promise<void> {
    const token = this.auth.token();
    const res = await fetch(`/api/admin/generic-task-results/${researchId}/submissions/${submissionId}/files/${fileId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** Downloads every participant's submitted files as one .zip. Throws NO_SUBMISSIONS
   *  (surfaced via the thrown Error's message) when nothing has been submitted yet. */
  async downloadGenericTaskSubmissionsZip(researchId: number): Promise<void> {
    const token = this.auth.token();
    const res = await fetch(`/api/admin/generic-task-results/${researchId}/submissions/export-zip`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      if (res.status === 404) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'NOT_FOUND');
      }
      throw new Error(`Export failed: ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zadaci-ispitanika.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  getGenericTaskParticipants(researchId: number): Promise<GenericTaskAssignableParticipant[]> {
    return this.req(this.http.get<GenericTaskAssignableParticipant[]>(`/api/admin/generic-tasks/${researchId}/participants`));
  }

  async updateGenericTaskAssignment(
    researchId: number,
    participantId: string,
    genericTaskId: number | null
  ): Promise<{ ok: true } | { ok: false }> {
    try {
      await this.req(
        this.http.put<{ ok: true }>(
          `/api/admin/generic-tasks/${researchId}/participants/${encodeURIComponent(participantId)}/assignment`,
          { genericTaskId }
        )
      );
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  getAnalysisScript(researchId: number): Promise<AnalysisScriptMeta> {
    return this.req(this.http.get<AnalysisScriptMeta>(`/api/admin/analysis/${researchId}/script`));
  }

  uploadAnalysisScript(researchId: number, file: File): Promise<AnalysisScriptMeta> {
    const formData = new FormData();
    formData.append('script', file, file.name);
    return this.req(this.http.post<AnalysisScriptMeta>(`/api/admin/analysis/${researchId}/script`, formData));
  }

  getAnalysisRuns(researchId: number): Promise<AnalysisRunSummary[]> {
    return this.req(this.http.get<AnalysisRunSummary[]>(`/api/admin/analysis/${researchId}/runs`));
  }

  startAnalysisRun(researchId: number): Promise<{ id: number } | { error: 'ALREADY_RUNNING' | 'NO_SCRIPT' | 'SERVER_ERROR' }> {
    return firstValueFrom(
      this.http.post<{ id: number }>(`/api/admin/analysis/${researchId}/runs`, {}).pipe(
        timeout(REQUEST_TIMEOUT_MS),
        map((res) => res),
        catchError((err) => {
          const code = err?.error?.error;
          if (code === 'ALREADY_RUNNING') return of({ error: 'ALREADY_RUNNING' as const });
          if (code === 'NO_SCRIPT') return of({ error: 'NO_SCRIPT' as const });
          return of({ error: 'SERVER_ERROR' as const });
        })
      )
    );
  }

  getAnalysisRun(researchId: number, runId: number): Promise<AnalysisRunDetail> {
    return this.req(this.http.get<AnalysisRunDetail>(`/api/admin/analysis/${researchId}/runs/${runId}`));
  }

  getAnalysisPlotUrl(researchId: number, runId: number, plotId: number): string {
    return `/api/admin/analysis/${researchId}/runs/${runId}/plots/${plotId}`;
  }

  /** Plots are served behind auth, so an <img [src]> can't hit the endpoint directly — fetch
   *  with the Bearer header and turn the response into a displayable object URL instead. */
  async fetchAnalysisPlotObjectUrl(researchId: number, runId: number, plotId: number): Promise<string> {
    const token = this.auth.token();
    const res = await fetch(this.getAnalysisPlotUrl(researchId, runId, plotId), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Plot fetch failed: ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  getConsentConfig(researchId: number): Promise<ConsentConfig> {
    return this.req(this.http.get<ConsentConfig>(`/api/admin/consent-sections/${researchId}`));
  }

  updateConsentConfig(researchId: number, body: ConsentConfig): Promise<{ ok: true }> {
    return this.req(this.http.put<{ ok: true }>(`/api/admin/consent-sections/${researchId}`, body));
  }

  getDemographicQuestions(researchId: number): Promise<{ questions: DemographicQuestion[] }> {
    return this.req(this.http.get<{ questions: DemographicQuestion[] }>(`/api/admin/demographic-questions/${researchId}`));
  }

  updateDemographicQuestions(researchId: number, questions: DemographicQuestion[]): Promise<{ ok: true }> {
    return this.req(this.http.put<{ ok: true }>(`/api/admin/demographic-questions/${researchId}`, { questions }));
  }

  getDemographicResults(researchId: number): Promise<DemographicResultsRaw> {
    return this.req(this.http.get<DemographicResultsRaw>(`/api/admin/demographic-results/${researchId}`));
  }

  getDemographicAggregate(researchId: number): Promise<DemographicResultsAggregate> {
    return this.req(this.http.get<DemographicResultsAggregate>(`/api/admin/demographic-results/${researchId}?mode=aggregate`));
  }

  /** Same authenticated fetch+blob+synthesized-<a> mechanics as exportCsv()/downloadTaskFile() —
   *  a plain <a href> can't carry the Bearer token requireAuth needs. */
  async exportDemographicResults(researchId: number): Promise<void> {
    const token = this.auth.token();
    const res = await fetch(`/api/admin/demographic-results/${researchId}/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'demographic-results.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Consent Form delivery (Part C3 of the 2026-09-08 follow-up round) — Mode 1 (generic link).
  // 2026-09-08 follow-up: now research-scoped (`slug` alongside the composed `url`).
  // 2026-09-09: `active` — whether the link is currently open to participants (see
  // setConsentPortalActive below).
  getConsentPortalLink(researchId: number): Promise<{ url: string; slug: string | null; active: boolean }> {
    return this.req(this.http.get<{ url: string; slug: string | null; active: boolean }>(`/api/admin/consent-form/${researchId}/portal-link`));
  }

  // 2026-09-09 — Activate/Deactivate toggle for the slug-scoped portal link. A fresh link starts
  // inactive; a researcher must flip this on before consent-andrejkatin lets any participant
  // through it.
  setConsentPortalActive(researchId: number, active: boolean): Promise<{ ok: true; active: boolean }> {
    return this.req(this.http.put<{ ok: true; active: boolean }>(`/api/admin/consent-form/${researchId}/portal-active`, { active }));
  }

  async updateResearchSlug(
    researchId: number,
    slug: string
  ): Promise<{ ok: true; slug: string } | { ok: false; error: 'INVALID_SLUG' | 'SLUG_TAKEN' | 'SERVER_ERROR' }> {
    try {
      const res = await this.req(
        this.http.put<{ ok: true; slug: string }>(`/api/admin/consent-form/${researchId}/slug`, { slug })
      );
      return res;
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'INVALID_SLUG' || code === 'SLUG_TAKEN') return { ok: false, error: code };
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  // Mode 2 (mailing list) — CSV upload, one email per resolved row.
  async uploadMailingList(
    researchId: number,
    file: File
  ): Promise<{ ok: true; sent: number; errors: MailingListRowError[] } | { ok: false; error: string }> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    try {
      const res = await this.req(
        this.http.post<{ sent: number; errors: MailingListRowError[] }>(`/api/admin/consent-form/${researchId}/mailing-list`, formData)
      );
      return { ok: true, sent: res.sent, errors: res.errors };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  getParticipants(researchId: number | null): Promise<ParticipantRow[]> {
    const qs = researchId != null ? `?researchId=${researchId}` : '';
    return this.req(this.http.get<ParticipantRow[]>(`/api/admin/participants${qs}`));
  }

  importParticipants(body: {
    researchId: number;
    participants: {
      participantId: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      language: 'sr' | 'en' | null;
      genericTask: string | null;
    }[];
    tasks: { participantId: string; session: 'AI' | 'REPORT'; taskLabel: string }[];
  }): Promise<ImportResult> {
    return this.req(this.http.post<ImportResult>('/api/admin/participants/import', body));
  }

  getResults(
    instrument: Instrument,
    researchId: number | null,
    mode: 'raw' | 'aggregate',
    participantId?: string
  ): Promise<Record<string, unknown>[] | AggregateResult> {
    const params = new URLSearchParams();
    if (researchId != null) params.set('researchId', String(researchId));
    if (participantId) params.set('participantId', participantId);
    params.set('mode', mode);
    return this.req(
      this.http.get<Record<string, unknown>[] | AggregateResult>(`/api/admin/results/${instrument}?${params}`)
    );
  }

  getEegMeta(participantId: string): Promise<EegMeta> {
    return this.req(this.http.get<EegMeta>(`/api/admin/eeg/${encodeURIComponent(participantId)}`));
  }

  getEegPreview(participantId: string, limit = 200): Promise<EegPreview> {
    return this.req(
      this.http.get<EegPreview>(`/api/admin/eeg/${encodeURIComponent(participantId)}/preview?limit=${limit}`)
    );
  }

  getEegInterpretation(participantId: string): Promise<EegInterpretation> {
    return this.req(
      this.http.get<EegInterpretation>(`/api/admin/eeg/${encodeURIComponent(participantId)}/interpretation`)
    );
  }

  uploadEeg(participantId: string, file: File): Promise<{ ok: true; rowCount: number; columns: string[] }> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.req(
      this.http.post<{ ok: true; rowCount: number; columns: string[] }>(
        `/api/admin/eeg/${encodeURIComponent(participantId)}`,
        formData
      )
    );
  }

  deleteEeg(participantId: string): Promise<{ ok: true }> {
    return this.req(this.http.delete<{ ok: true }>(`/api/admin/eeg/${encodeURIComponent(participantId)}`));
  }

  getActivityLogs(participantId: string): Promise<ActivityLogMeta[]> {
    return this.req(
      this.http.get<ActivityLogMeta[]>(`/api/admin/activity-log/${encodeURIComponent(participantId)}`)
    );
  }

  getActivityLog(participantId: string, sessionId: number): Promise<ActivityLogDetail> {
    return this.req(
      this.http.get<ActivityLogDetail>(
        `/api/admin/activity-log/${encodeURIComponent(participantId)}/${sessionId}`
      )
    );
  }

  /** Downloads the stored activity-log CSV exactly as the review app wrote it — same
   *  fetch+blob+synthetic-<a> mechanics as downloadEeg(), for the same auth-header reason. */
  async downloadActivityLog(participantId: string, sessionId: number, filename: string): Promise<void> {
    const token = this.auth.token();
    const res = await fetch(
      `/api/admin/activity-log/${encodeURIComponent(participantId)}/${sessionId}/download`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} }
    );
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** Downloads the raw EEG CSV — can't use a plain <a href> since it needs the auth header. */
  async downloadEeg(participantId: string): Promise<void> {
    const token = this.auth.token();
    const res = await fetch(`/api/admin/eeg/${encodeURIComponent(participantId)}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${participantId}-eeg.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** Downloads a CSV export — can't use a plain <a href> since it needs the auth header. */
  async exportCsv(instrument: Instrument, researchId: number | null): Promise<void> {
    const params = new URLSearchParams();
    if (researchId != null) params.set('researchId', String(researchId));
    const token = this.auth.token();

    const res = await fetch(`/api/admin/results/${instrument}/export?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${instrument}-results.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  getStudyConfig(researchId: number): Promise<StudyConfig> {
    return this.req(this.http.get<StudyConfig>(`/api/admin/study-config/${researchId}`));
  }

  async updateStudyConfig(
    researchId: number,
    body: Omit<StudyConfig, 'rei40Variants' | 'rei40VariantLocked'>
  ): Promise<{ ok: true } | { ok: false; error: UpdateStudyConfigErrorCode }> {
    try {
      await this.req(this.http.put<{ ok: true }>(`/api/admin/study-config/${researchId}`, body));
      return { ok: true };
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'REI40_VARIANT_LOCKED') return { ok: false, error: code };
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  /** Re-issues both REI-40/Big Five links for a participant (e.g. after the original ones
   *  expired) and emails the new ones. Requires the participant to have already consented. */
  async regenerateLinks(participantId: string): Promise<{ ok: true } | { ok: false; error: RegenerateLinksErrorCode }> {
    try {
      await this.req(
        this.http.post<{ ok: true }>(`/api/admin/participants/${encodeURIComponent(participantId)}/regenerate-links`, {})
      );
      return { ok: true };
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'NOT_FOUND' || code === 'NOT_CONSENTED' || code === 'NO_EMAIL') {
        return { ok: false, error: code };
      }
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  /** Mints (or refreshes) a CONSENT_ENTRY magic link for a participant and emails it — the
   *  one-click "send consent email" action on the Participant Detail page's Timeline. */
  async sendConsentEmail(participantId: string): Promise<{ ok: true } | { ok: false; error: SendConsentEmailErrorCode }> {
    try {
      await this.req(
        this.http.post<{ ok: true }>(`/api/admin/participants/${encodeURIComponent(participantId)}/send-consent-email`, {})
      );
      return { ok: true };
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'NOT_FOUND' || code === 'CONSENT_NOT_USED' || code === 'NO_EMAIL') {
        return { ok: false, error: code };
      }
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  getParticipantOverview(participantId: string): Promise<ParticipantOverview> {
    return this.req(this.http.get<ParticipantOverview>(`/api/admin/participants/${encodeURIComponent(participantId)}/overview`));
  }

  generateLink(participantId: string, type: LinkType): Promise<ParticipantLink> {
    return this.req(
      this.http.post<ParticipantLink>(`/api/admin/participants/${encodeURIComponent(participantId)}/links/${type}`, {})
    );
  }

  setBaseline(participantId: string, done: boolean): Promise<{ baselineDoneAt: string | null }> {
    const url = `/api/admin/participants/${encodeURIComponent(participantId)}/baseline`;
    return this.req(
      done ? this.http.post<{ baselineDoneAt: string | null }>(url, {}) : this.http.delete<{ baselineDoneAt: string | null }>(url)
    );
  }

  getExperimentalSessions(researchId: number | null): Promise<ExperimentalSessionSummary[]> {
    const qs = researchId != null ? `?researchId=${researchId}` : '';
    return this.req(this.http.get<ExperimentalSessionSummary[]>(`/api/admin/experimental-sessions${qs}`));
  }

  createExperimentalSession(body: {
    researchId: number;
    sessionDate: string;
    label: string | null;
    notes: string | null;
  }): Promise<{ id: number }> {
    return this.req(this.http.post<{ id: number }>('/api/admin/experimental-sessions', body));
  }

  getExperimentalSession(id: number): Promise<ExperimentalSessionDetail> {
    return this.req(this.http.get<ExperimentalSessionDetail>(`/api/admin/experimental-sessions/${id}`));
  }

  deleteExperimentalSession(id: number): Promise<{ ok: true }> {
    return this.req(this.http.delete<{ ok: true }>(`/api/admin/experimental-sessions/${id}`));
  }

  getCalendarStatus(): Promise<CalendarStatus> {
    return this.req(this.http.get<CalendarStatus>('/api/admin/calendar/status'));
  }

  disconnectCalendar(): Promise<{ ok: true }> {
    return this.req(this.http.post<{ ok: true }>('/api/admin/calendar/disconnect', {}));
  }

  // Not a req()/XHR call — connecting is a real full-page navigation to Google's consent screen,
  // so the JWT has to travel as a query param (a top-level navigation can't set a header). See
  // server/calendar/routes.mjs's GET /connect.
  buildCalendarConnectUrl(): string {
    return `/api/admin/calendar/connect?token=${encodeURIComponent(this.auth.token() ?? '')}`;
  }

  getGoogleFormsStatus(): Promise<GoogleFormsStatus> {
    return this.req(this.http.get<GoogleFormsStatus>('/api/admin/google-forms/status'));
  }

  disconnectGoogleForms(): Promise<{ ok: true }> {
    return this.req(this.http.post<{ ok: true }>('/api/admin/google-forms/disconnect', {}));
  }

  buildGoogleFormsConnectUrl(): string {
    return `/api/admin/google-forms/connect?token=${encodeURIComponent(this.auth.token() ?? '')}`;
  }

  getFormQuestions(researchId: number): Promise<{ questions: FormQuestion[] }> {
    return this.req(this.http.get<{ questions: FormQuestion[] }>(`/api/admin/task-config/${researchId}/questions`));
  }

  async updateFormQuestions(researchId: number, questions: FormQuestion[]): Promise<{ ok: true } | { ok: false }> {
    try {
      await this.req(this.http.put<{ ok: true }>(`/api/admin/task-config/${researchId}/questions`, { questions }));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async readFormStructure(researchId: number): Promise<{ ok: true; questions: FormQuestion[] } | { ok: false; error: string }> {
    try {
      const res = await this.req(
        this.http.post<{ questions: FormQuestion[] }>(`/api/admin/task-config/${researchId}/read-structure`, {})
      );
      return { ok: true, questions: res.questions };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  async getDescriptiveStats(researchId: number): Promise<{ ok: true; stats: DescriptiveStatsResult } | { ok: false; error: string }> {
    try {
      const stats = await this.req(this.http.get<DescriptiveStatsResult>(`/api/admin/task-files/${researchId}/descriptive-stats`));
      return { ok: true, stats };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  getParticipantSurveyAnswers(
    researchId: number,
    participantId: string
  ): Promise<{ matched: boolean; answers: ParticipantSurveyAnswer[] | null }> {
    return this.req(
      this.http.get<{ matched: boolean; answers: ParticipantSurveyAnswer[] | null }>(
        `/api/admin/task-files/${researchId}/participant-answers/${encodeURIComponent(participantId)}`
      )
    );
  }

  updateExperimentalSession(
    id: number,
    body: { sessionDate: string; label: string | null; notes: string | null }
  ): Promise<{ ok: true }> {
    return this.req(this.http.put<{ ok: true }>(`/api/admin/experimental-sessions/${id}`, body));
  }

  async assignParticipantSession(
    id: number,
    participantId: string,
    sessionId: number,
    time: string
  ): Promise<{ ok: true } | { ok: false; error: 'ALREADY_ASSIGNED' | 'SERVER_ERROR' }> {
    try {
      await this.req(
        this.http.post<{ ok: true }>(`/api/admin/experimental-sessions/${id}/assign`, { participantId, sessionId, time })
      );
      return { ok: true };
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'ALREADY_ASSIGNED') return { ok: false, error: code };
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  unassignParticipantSession(id: number, participantId: string, sessionId: number): Promise<{ ok: true }> {
    return this.req(
      this.http.post<{ ok: true }>(`/api/admin/experimental-sessions/${id}/unassign`, { participantId, sessionId })
    );
  }

  updateParticipantSessionNotes(participantId: string, sessionId: number, notes: string | null): Promise<{ ok: true }> {
    return this.req(
      this.http.put<{ ok: true }>('/api/admin/experimental-sessions/participant-session-notes', {
        participantId,
        sessionId,
        notes,
      })
    );
  }

  updateParticipantSessionTags(participantId: string, sessionId: number, tags: string[]): Promise<{ ok: true }> {
    return this.req(
      this.http.put<{ ok: true }>('/api/admin/experimental-sessions/participant-session-tags', {
        participantId,
        sessionId,
        tags,
      })
    );
  }
}
