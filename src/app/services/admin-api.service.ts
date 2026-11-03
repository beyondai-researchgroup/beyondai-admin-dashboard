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
  /** 'PROTOCOL' = the researcher-defined step list (every new research); 'CLASSIC' = the original
   *  BeyondAI-style module-switch flow (only the researches that existed before the protocol work). */
  flowMode: 'CLASSIC' | 'PROTOCOL';
  /** false while the study wizard that created this research has not been finished (study wizard, 2026-10). */
  setupComplete?: boolean;
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
  /** Study Builder only — 'PROTOCOL' creates a research driven by a researcher-defined step list
   *  (every legacy module switch is then forced off server-side). Omitted = 'CLASSIC', the original
   *  BeyondAI flow every existing research uses. */
  flowMode?: 'PROTOCOL';
  /** Study wizard only: false = created but not yet fully set up (PROTOCOL researches only). */
  setupComplete?: false;
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

/** Results of the researcher-authored questionnaires of a PROTOCOL research. */
export interface SheetsParticipantRow {
  participantId: string;
  hasEmail: boolean;
  language: string | null;
  link: { url: string; expiresAt: string; expired: boolean } | null;
  groupName?: string | null;
  taskName?: string | null;
  /** The template this participant gets (by group and task); null = none fits ("noTemplate"). */
  workbookId?: number | null;
  workbookLabel?: string | null;
  noTemplate?: boolean;
  /** When the participant confirmed the rules screen (null = not yet, or the table has no rules). */
  rulesAcknowledgedAt?: string | null;
  /** When the participant pressed "Start task" (null = not yet). */
  startedAt?: string | null;
  /** The countdown ran out and nothing was handed in yet. */
  timeUp?: boolean;
  entry: { status: 'DRAFT' | 'SUBMITTED'; updatedAt: string; submittedAt: string | null; timedOut?: boolean; durationMin?: number | null } | null;
}
export interface SheetsTemplateSummary {
  id: number;
  label: string | null;
  title: string;
  version: number;
  sheetCount: number;
  updatedAt: string;
  hasRules: boolean;
  groupId: number | null;
  groupName: string | null;
  taskId: number | null;
  taskName: string | null;
  entryCount: number;
  submittedCount: number;
}
export interface SheetsOverview {
  usesSheets: boolean;
  appUrl: string;
  canWrite: boolean;
  workbook: { title: string; version: number; sheetCount: number; updatedAt: string; hasRules?: boolean } | null;
  /** Every template of the research (one per group x task). */
  workbooks?: SheetsTemplateSummary[];
  /** When the tables open and close (ISO, UTC); null = no limit on that side. */
  window?: { opensAt: string | null; closesAt: string | null };
  /** Minutes a participant has from pressing Start (null = no countdown). */
  timerMinutes?: number | null;
  participants: SheetsParticipantRow[];
}
export interface SheetsEntryView {
  title: string;
  rulesAcknowledgedAt?: string | null;
  /** Handed in because the countdown ran out. */
  timedOut?: boolean;
  durationMin?: number | null;
  status: 'DRAFT' | 'SUBMITTED';
  updatedAt: string;
  submittedAt: string | null;
  sheets: {
    id: string;
    name: string;
    headerRows: number;
    columns: { index: number; title: string; required: boolean }[];
    rows: { row: number; cells: Record<string, string | number> }[];
  }[];
}
export interface QuestionnaireResultsListItem { id: number; titleSr: string; titleEn: string; responseCount: number }
export interface QuestionnaireResultsStep { stepId: number; titleSr: string; titleEn: string }
export interface QuestionnaireResultsItem {
  itemKey: string;
  type: 'LIKERT' | 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'TEXT' | 'NUMBER';
  promptSr: string;
  promptEn: string;
  options: { key: string; labelSr: string; labelEn: string; isOther: boolean }[];
  scalePoints: number | null;
  subscale: string | null;
  reverseScored: boolean;
}
export interface QuestionnaireResultsRaw {
  questionnaire: { id: number; titleSr: string; titleEn: string };
  steps: QuestionnaireResultsStep[];
  subscales: string[];
  items: QuestionnaireResultsItem[];
  responses: {
    participantId: string;
    groupName?: string | null;
    stepId: number;
    stepTitleSr: string | null;
    stepTitleEn: string | null;
    language: string | null;
    answers: Record<string, { value: string | number | string[]; otherText?: string }>;
    submittedAt: string;
    subscaleScores: Record<string, number | null>;
  }[];
}
export interface QuestionnaireAggregateItem {
  itemKey: string;
  type: QuestionnaireResultsItem['type'];
  promptSr: string;
  promptEn: string;
  n: number;
  textAnswers?: string[];
  mean?: number | null;
  sd?: number | null;
  min?: number | null;
  max?: number | null;
  scalePoints?: number;
  reverseScored?: boolean;
  subscale?: string | null;
  distribution?: { point: number; count: number }[];
  rawMean?: number | null;
  scoredMean?: number | null;
  scoredSd?: number | null;
  optionCounts?: { key: string; labelSr: string; labelEn: string; count: number }[];
  otherTexts?: string[];
}
export interface QuestionnaireResultsAggregate {
  questionnaire: { id: number; titleSr: string; titleEn: string };
  steps: QuestionnaireResultsStep[];
  totalResponses: number;
  subscales: { name: string; itemCount: number; n: number; mean: number | null; sd: number | null }[];
  items: QuestionnaireAggregateItem[];
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
  /** Random four-digit code for analysis and papers (null until assigned). */
  participantCode?: string | null;
  sessions: ParticipantSessionRow[];
}

export type LinkType = 'CODE_REVIEW' | 'CONSENT_ENTRY' | 'REI40' | 'BIGFIVE' | 'DEMOGRAPHIC';

export interface ParticipantLink {
  type: LinkType;
  url: string;
  createdAt: string;
  expiresAt: string;
  status: 'valid' | 'expired' | 'completed';
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
  /** When the instrument behind each link type was filled out (null = not yet) — a completed
   *  questionnaire's link no longer opens anything, so the Links table shows it as completed. */
  linkCompletions: Partial<Record<LinkType, string | null>>;
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

/** Who is who right after an import: the people this import created, with their code, group and task. */
export interface ImportOverviewRow {
  participantId: string;
  code: string | null;
  groupName: string | null;
  taskName: string | null;
}

export interface ImportResult {
  participants: { imported: string[]; skippedExisting: string[] };
  /** Four-digit codes given to the people this import created (`error` when they could not all be given). */
  codes?: { assigned: number; error?: string };
  overview?: ImportOverviewRow[];
  /** introAdded: participants who got their Intro session auto-inserted by this import (see
   *  server/participants/routes.mjs's POST /import — Intro is never listed in the Tasks sheet). */
  tasks: { introAdded: string[]; assigned: string[]; errors: ImportTaskError[] };
  /** Group column of the Participants sheet: who was put in a group, and names that matched no group. */
  groups?: { assigned: string[]; unknown: { participantId: string; group: string }[] };
  /** Task column of the Participants sheet (Code Review protocol): who got a PR, and labels that matched none. */
  prTasks?: { assigned: string[]; unknown: { participantId: string; task: string }[] };
  /** ResearchTask column (study task A / B): who got one from the sheet, and names that matched none. */
  researchTasks?: { assigned: string[]; unknown: { participantId: string; task: string }[] };
  /** The automatic group + task draw done right after the import (design says "random assignment"); null when none ran. */
  autoAssignment?: AutoAssignment | null;
}

export interface AssignmentCell {
  groupId: number | null;
  groupName: string | null;
  taskId: number;
  taskName: string;
  added: number;
  total: number;
}

export type AutoAssignment =
  | { error: string }
  | { seed: string; runId: number; count: number; summary: { groupId: number; name: string; added: number; total: number }[]; cells: AssignmentCell[] };

export type Instrument = 'tlx' | 'rei40' | 'bigfive';

/** Per-research instrument configuration — see server/study-config/routes.mjs. */
export type FlowMode = 'CLASSIC' | 'PROTOCOL';

export interface StudyConfig {
  /** Read-only: set once at research creation, never by this page's PUT. */
  flowMode: FlowMode;
  /** Read-only: false until the study wizard that created a PROTOCOL research is finished. */
  setupComplete?: boolean;
  /** Read-only: number of participant groups defined for the research (0 = none). */
  groupCount?: number;
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
  /** Excel-like tables (sheets-andrejkatin, 2026-10) — default false. */
  usesSheets: boolean;
  /** false hides the BeyondAI logo / name from participants of this research (apps and participant emails). */
  showBeyondAiBranding: boolean;
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
  /** Termini (slots) of a PROTOCOL research; 0 for a classic one. */
  slotCount: number;
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
  flowMode: 'CLASSIC' | 'PROTOCOL';
  sessionDate: string;
  label: string | null;
  notes: string | null;
  createdAt: string;
  participantSessions: ExperimentalSessionParticipantRow[];
}

export type SessionSlotKind = 'ONLINE' | 'IN_PERSON';
export type SessionSlotAudience = 'PARTICIPANT' | 'GROUP' | 'ALL';

export interface SessionSlotAttendee {
  guid: string;
  participantId: string;
  hasEmail: boolean;
  groupId: number | null;
  groupName: string | null;
}

export interface SessionSlot {
  id: number;
  experimentalSessionId: number;
  startTime: string;
  durationMinutes: number;
  kind: SessionSlotKind;
  meetingUrl: string | null;
  location: string | null;
  audienceType: SessionSlotAudience;
  groupId: number | null;
  groupName: string | null;
  protocolStepId: number | null;
  stepTitleSr: string | null;
  stepTitleEn: string | null;
  notes: string | null;
  tags: string[];
  googleCalendarEventId: string | null;
  googleCalendarEventUrl: string | null;
  attendees: SessionSlotAttendee[];
}

export interface SessionSlotInput {
  startTime: string;
  durationMinutes: number;
  kind: SessionSlotKind;
  meetingUrl?: string | null;
  location?: string | null;
  notes?: string | null;
}

export interface SessionSlotCreateInput extends SessionSlotInput {
  audienceType: SessionSlotAudience;
  groupId?: number | null;
  participantIds?: string[];
  protocolStepId?: number | null;
  skipConflicts?: boolean;
}

/** A refused slot call: the server's error code, and the participants that block it (ALREADY_SCHEDULED). */
export type SessionSlotResult<T> = ({ ok: true } & T) | { ok: false; error: string; conflicts?: string[] };

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

  getSheetsOverview(researchId: number): Promise<SheetsOverview> {
    return this.req(this.http.get<SheetsOverview>(`/api/admin/sheets/${researchId}`));
  }

  /** Mint a personal link for one participant; with `send` it is also emailed. A failed email resolves with ok:false. */
  async sheetsLink(researchId: number, participantId: string, send: boolean): Promise<{ ok: boolean; url?: string; error?: string }> {
    const token = this.auth.token();
    const res = await fetch(`/api/admin/sheets/${researchId}/participants/${encodeURIComponent(participantId)}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ send }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok && body.ok !== false, url: body.url, error: res.ok ? undefined : body.error };
  }

  sheetsSendAll(researchId: number): Promise<{ ok: true; sent: number; skippedNoEmail: number; skippedSubmitted: number; skippedNoTemplate?: number; failed: string[] }> {
    return this.req(this.http.post<{ ok: true; sent: number; skippedNoEmail: number; skippedSubmitted: number; skippedNoTemplate?: number; failed: string[] }>(`/api/admin/sheets/${researchId}/links`, {}));
  }

  getSheetsEntry(researchId: number, participantId: string): Promise<SheetsEntryView> {
    return this.req(this.http.get<SheetsEntryView>(`/api/admin/sheets/${researchId}/participants/${encodeURIComponent(participantId)}/entry`));
  }

  /** Authenticated fetch+blob download of the Excel export. */
  async saveSheetsWindow(researchId: number, body: { opensAt: string | null; closesAt: string | null; timerMinutes?: number | null }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.req(this.http.put<{ ok: true }>(`/api/admin/sheets/${researchId}/window`, body));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  /** Excel export of all templates of the research, or just one (workbookId). */
  async exportSheets(researchId: number, workbookId?: number): Promise<void> {
    const token = this.auth.token();
    const qs = workbookId != null ? `?workbookId=${workbookId}` : '';
    const res = await fetch(`/api/admin/sheets/${researchId}/export${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sheets-research-${researchId}${workbookId != null ? '-' + workbookId : ''}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  getQuestionnaireResultsList(researchId: number): Promise<{ questionnaires: QuestionnaireResultsListItem[] }> {
    return this.req(this.http.get<{ questionnaires: QuestionnaireResultsListItem[] }>(`/api/admin/questionnaire-results/${researchId}`));
  }

  getQuestionnaireResults(researchId: number, questionnaireId: number, stepId: number | null): Promise<QuestionnaireResultsRaw> {
    const q = stepId != null ? `?stepId=${stepId}` : '';
    return this.req(this.http.get<QuestionnaireResultsRaw>(`/api/admin/questionnaire-results/${researchId}/${questionnaireId}${q}`));
  }

  getQuestionnaireAggregate(researchId: number, questionnaireId: number, stepId: number | null): Promise<QuestionnaireResultsAggregate> {
    const q = stepId != null ? `&stepId=${stepId}` : '';
    return this.req(this.http.get<QuestionnaireResultsAggregate>(`/api/admin/questionnaire-results/${researchId}/${questionnaireId}?mode=aggregate${q}`));
  }

  /** Authenticated fetch+blob download, like exportDemographicResults(). */
  async exportQuestionnaireResults(researchId: number, questionnaireId: number, stepId: number | null): Promise<void> {
    const token = this.auth.token();
    const q = stepId != null ? `?stepId=${stepId}` : '';
    const res = await fetch(`/api/admin/questionnaire-results/${researchId}/${questionnaireId}/export${q}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `questionnaire-${questionnaireId}-results.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
      group?: string | null;
      prTask?: string | null;
      researchTask?: string | null;
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

  /** Gives every participant of the research that has no code a random four-digit one. */
  assignParticipantCodes(researchId: number): Promise<{ ok: true; assigned: number; total: number }> {
    return this.req(this.http.post<{ ok: true; assigned: number; total: number }>('/api/admin/participants/assign-codes', { researchId }));
  }

  /** Saves the key file (participant id, code, group, task) as a CSV. */
  async downloadCodeKey(researchId: number): Promise<void> {
    const token = this.auth.token();
    const res = await fetch(`/api/admin/participants/code-key?researchId=${researchId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `participant-codes-research-${researchId}.csv`;
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
    body: Omit<StudyConfig, 'rei40Variants' | 'rei40VariantLocked' | 'flowMode'>
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

  getSessionSlots(experimentalSessionId: number): Promise<{ slots: SessionSlot[]; calendarConnected: boolean }> {
    return this.req(this.http.get<{ slots: SessionSlot[]; calendarConnected: boolean }>(`/api/admin/session-slots/${experimentalSessionId}`));
  }

  private async slotCall<T>(call: Promise<T>): Promise<SessionSlotResult<T>> {
    try {
      return { ok: true, ...(await call) } as SessionSlotResult<T>;
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR', conflicts: err?.error?.conflicts };
    }
  }

  createSessionSlot(
    experimentalSessionId: number,
    body: SessionSlotCreateInput
  ): Promise<SessionSlotResult<{ id: number; attendeeCount: number; withoutEmail: number; skipped: number; calendarConnected: boolean }>> {
    return this.slotCall(
      this.req(this.http.post<{ id: number; attendeeCount: number; withoutEmail: number; skipped: number; calendarConnected: boolean }>(
        `/api/admin/session-slots/${experimentalSessionId}`, body))
    );
  }

  updateSessionSlot(slotId: number, body: SessionSlotInput): Promise<SessionSlotResult<{}>> {
    return this.slotCall(this.req(this.http.put<{}>(`/api/admin/session-slots/slot/${slotId}`, body)));
  }

  addSessionSlotAttendees(
    slotId: number,
    body: { participantIds?: string[]; syncGroup?: boolean; skipConflicts?: boolean }
  ): Promise<SessionSlotResult<{ added: number; withoutEmail: number; skipped: number }>> {
    return this.slotCall(
      this.req(this.http.post<{ added: number; withoutEmail: number; skipped: number }>(`/api/admin/session-slots/slot/${slotId}/attendees`, body))
    );
  }

  removeSessionSlotAttendee(slotId: number, guid: string): Promise<{ ok: true }> {
    return this.req(this.http.delete<{ ok: true }>(`/api/admin/session-slots/slot/${slotId}/attendees/${guid}`));
  }

  updateSessionSlotNotesTags(slotId: number, notes: string | null, tags: string[]): Promise<{ ok: true }> {
    return this.req(this.http.put<{ ok: true }>(`/api/admin/session-slots/slot/${slotId}/notes-tags`, { notes, tags }));
  }

  deleteSessionSlot(slotId: number): Promise<{ ok: true }> {
    return this.req(this.http.delete<{ ok: true }>(`/api/admin/session-slots/slot/${slotId}`));
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

  // ── Research protocol + researcher-authored questionnaires (2026-10) ──────────────────────────

  getProtocol(researchId: number): Promise<ProtocolConfig> {
    return this.req(this.http.get<ProtocolConfig>(`/api/admin/protocol/${researchId}`));
  }

  async updateProtocol(researchId: number, steps: ProtocolStepInput[]): Promise<ProtocolSaveResult> {
    try {
      await this.req(this.http.put<{ ok: true }>(`/api/admin/protocol/${researchId}`, { steps }));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR', reason: err?.error?.reason, stepType: err?.error?.stepType };
    }
  }

  getQuestionnaires(researchId: number): Promise<{ questionnaires: QuestionnaireSummary[] }> {
    return this.req(this.http.get<{ questionnaires: QuestionnaireSummary[] }>(`/api/admin/questionnaires/${researchId}`));
  }

  getQuestionnaire(researchId: number, id: number): Promise<QuestionnaireDetail> {
    return this.req(this.http.get<QuestionnaireDetail>(`/api/admin/questionnaires/${researchId}/${id}`));
  }

  async createQuestionnaire(
    researchId: number,
    body: QuestionnaireBody
  ): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
    try {
      const r = await this.req(this.http.post<{ id: number }>(`/api/admin/questionnaires/${researchId}`, body));
      return { ok: true, id: r.id };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  async updateQuestionnaire(
    researchId: number,
    id: number,
    body: QuestionnaireBody
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.req(this.http.put<{ ok: true }>(`/api/admin/questionnaires/${researchId}/${id}`, body));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  async duplicateQuestionnaire(researchId: number, id: number): Promise<{ ok: true; id: number } | { ok: false }> {
    try {
      const r = await this.req(this.http.post<{ id: number }>(`/api/admin/questionnaires/${researchId}/${id}/duplicate`, {}));
      return { ok: true, id: r.id };
    } catch {
      return { ok: false };
    }
  }

  async deleteQuestionnaire(researchId: number, id: number): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.req(this.http.delete<{ ok: true }>(`/api/admin/questionnaires/${researchId}/${id}`));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  // ── Participant progress through a protocol (2026-10) ──────────────────────────────────────────

  getProtocolMatrix(researchId: number): Promise<ProtocolMatrix> {
    return this.req(this.http.get<ProtocolMatrix>(`/api/admin/protocol-progress/${researchId}/participants`));
  }

  getProtocolTimeline(researchId: number, participantId: string): Promise<ProtocolTimeline> {
    return this.req(
      this.http.get<ProtocolTimeline>(`/api/admin/protocol-progress/${researchId}/participants/${encodeURIComponent(participantId)}`)
    );
  }

  private async protocolAction(path: string, body: object = {}): Promise<ProtocolEngineResult> {
    try {
      return await this.req(this.http.post<ProtocolEngineResult>(`/api/admin/protocol-progress/${path}`, body));
    } catch (err: any) {
      return { ok: false, reason: err?.error?.error ?? 'SERVER_ERROR', sentStepIds: [], currentStepId: null, finished: false };
    }
  }

  startProtocolParticipant(researchId: number, participantId: string): Promise<ProtocolEngineResult> {
    return this.protocolAction(`${researchId}/participants/${encodeURIComponent(participantId)}/start`);
  }

  sendProtocolStep(researchId: number, participantId: string, stepId: number): Promise<ProtocolEngineResult> {
    return this.protocolAction(`${researchId}/participants/${encodeURIComponent(participantId)}/steps/${stepId}/send`);
  }

  completeProtocolStep(researchId: number, participantId: string, stepId: number): Promise<ProtocolEngineResult> {
    return this.protocolAction(`${researchId}/participants/${encodeURIComponent(participantId)}/steps/${stepId}/complete`);
  }

  skipProtocolStep(researchId: number, participantId: string, stepId: number): Promise<ProtocolEngineResult> {
    return this.protocolAction(`${researchId}/participants/${encodeURIComponent(participantId)}/steps/${stepId}/skip`);
  }

  // ── Research design: study type, variables, groups (2026-10) ───────────────────────────────────

  getResearchDesign(researchId: number): Promise<ResearchDesignDoc> {
    return this.req(this.http.get<ResearchDesignDoc>(`/api/admin/research-design/${researchId}`));
  }

  async saveResearchDesign(
    researchId: number,
    body: Pick<ResearchDesignDoc, 'design' | 'variables' | 'groups' | 'tasks'>,
  ): Promise<{ ok: true; doc: ResearchDesignDoc } | { ok: false; error: string; name?: string }> {
    try {
      return { ok: true, doc: await this.req(this.http.put<ResearchDesignDoc>(`/api/admin/research-design/${researchId}`, body)) };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR', name: err?.error?.name };
    }
  }

  /** Attaches (or replaces) the task's PDF. The task has to be saved already (it needs an id). */
  async uploadTaskPdf(researchId: number, taskId: number, file: File): Promise<{ ok: true; pdfName: string; pdfSize: number } | { ok: false; error: string }> {
    const formData = new FormData();
    formData.append('pdf', file, file.name);
    try {
      const r = await this.req(this.http.put<{ ok: true; pdfName: string; pdfSize: number }>(`/api/admin/research-design/${researchId}/tasks/${taskId}/pdf`, formData));
      return { ok: true, pdfName: r.pdfName, pdfSize: r.pdfSize };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'UPLOAD_FAILED' };
    }
  }

  async deleteTaskPdf(researchId: number, taskId: number): Promise<boolean> {
    try {
      await this.req(this.http.delete<{ ok: true }>(`/api/admin/research-design/${researchId}/tasks/${taskId}/pdf`));
      return true;
    } catch {
      return false;
    }
  }

  /** Opens the task's PDF in a new tab (a plain link cannot carry the auth header, so it is fetched as a blob first). */
  async openTaskPdf(researchId: number, taskId: number): Promise<boolean> {
    const token = this.auth.token();
    const res = await fetch(`/api/admin/research-design/${researchId}/tasks/${taskId}/pdf`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return false;
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  }

  async completeResearchSetup(researchId: number): Promise<boolean> {
    try {
      await this.req(this.http.post<{ ok: true }>(`/api/admin/research-design/${researchId}/complete-setup`, {}));
      return true;
    } catch {
      return false;
    }
  }

  async setParticipantGroup(researchId: number, participantId: string, groupId: number | null): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.req(
        this.http.put<{ ok: true }>(`/api/admin/research-design/${researchId}/participants/${encodeURIComponent(participantId)}/group`, { groupId }),
      );
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  async setParticipantTask(researchId: number, participantId: string, taskId: number | null): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.req(
        this.http.put<{ ok: true }>(`/api/admin/research-design/${researchId}/participants/${encodeURIComponent(participantId)}/task`, { taskId }),
      );
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  async setParticipantPrTask(researchId: number, participantId: string, prConfigId: number | null): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.req(
        this.http.put<{ ok: true }>(`/api/admin/protocol-progress/${researchId}/participants/${encodeURIComponent(participantId)}/pr-task`, { prConfigId }),
      );
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  /** Balanced random assignment of every participant that still needs a group and/or a task. preview=true only computes it;
   *  reset=true also re-draws the ones a previous random run placed (and that have not started). */
  async randomizeGroups(researchId: number, opts: { preview: boolean; seed?: string; reset?: boolean }): Promise<RandomizeResult | { error: string }> {
    try {
      return await this.req(this.http.post<RandomizeResult>(`/api/admin/research-design/${researchId}/randomize`, opts));
    } catch (err: any) {
      return { error: err?.error?.error ?? 'SERVER_ERROR' };
    }
  }

  // ── mail queue (the relay allows about 100 recipients a day, so bulk mails wait here) ──
  getMailOutbox(researchId: number): Promise<MailOutboxStats> {
    return this.req(this.http.get<MailOutboxStats>(`/api/admin/mail-outbox/${researchId}`));
  }

  async drainMailOutbox(researchId: number): Promise<(MailOutboxStats & { sent: number }) | null> {
    try {
      return await this.req(this.http.post<MailOutboxStats & { sent: number }>(`/api/admin/mail-outbox/${researchId}/drain`, {}));
    } catch {
      return null;
    }
  }

  async retryFailedMail(researchId: number): Promise<number | null> {
    try {
      return (await this.req(this.http.post<{ ok: true; requeued: number }>(`/api/admin/mail-outbox/${researchId}/retry-failed`, {}))).requeued;
    } catch {
      return null;
    }
  }

  /** Sends one protocol step (e.g. the participants' tables) to everybody who is ready for it. */
  async sendProtocolStepToAll(researchId: number, stepId: number, opts: { participantIds?: string[]; force?: boolean } = {}): Promise<ProtocolSendAllResult | null> {
    try {
      return await this.req(this.http.post<ProtocolSendAllResult>(`/api/admin/protocol-progress/${researchId}/steps/${stepId}/send-all`, opts));
    } catch {
      return null;
    }
  }

  async startProtocolAll(researchId: number): Promise<ProtocolStartAllResult | null> {
    try {
      return await this.req(this.http.post<ProtocolStartAllResult>(`/api/admin/protocol-progress/${researchId}/start-all`, {}));
    } catch {
      return null;
    }
  }
}

// ── Research design types (2026-10) ───────────────────────────────────────────────────────────

export type DesignApproach = 'EXPERIMENTAL' | 'QUASI_EXPERIMENTAL' | 'CORRELATIONAL' | 'DESCRIPTIVE';
export type DesignSubject = 'BETWEEN' | 'WITHIN' | 'MIXED' | 'SINGLE_GROUP';
export type DesignTime = 'CROSS_SECTIONAL' | 'PRE_POST' | 'REPEATED' | 'CROSSOVER';
export type DesignFactor = 'SINGLE_FACTOR' | 'FACTORIAL';
export type DesignControl = 'NONE' | 'NO_TREATMENT' | 'PLACEBO_ACTIVE' | 'WAITLIST' | 'TREATMENT_AS_USUAL';
export type DesignBlinding = 'NONE' | 'SINGLE' | 'DOUBLE';
export type AssignmentMode = 'MANUAL' | 'RANDOM';
export type VariableRole = 'INDEPENDENT' | 'DEPENDENT' | 'CONTROL' | 'MODERATOR' | 'MEDIATOR' | 'COVARIATE';

export interface ResearchDesignData {
  approach: DesignApproach | null;
  subjectDesign: DesignSubject | null;
  timeDimension: DesignTime | null;
  factorStructure: DesignFactor | null;
  controlCondition: DesignControl | null;
  blinding: DesignBlinding | null;
  assignmentMode: AssignmentMode;
  hypotheses: string | null;
  notes: string | null;
}

export interface ResearchVariableData {
  id?: number;
  role: VariableRole;
  name: string;
  description: string | null;
  levels: string[];
  measurement: string | null;
}

export interface ResearchGroupData {
  id?: number;
  name: string;
  description: string | null;
  weight: number;
  isControl: boolean;
  /** Read-only, returned by the server. */
  participantCount?: number;
}

export interface ResearchTaskData {
  id?: number;
  name: string;
  weight: number;
  /** The written task as a PDF (read-only here, set through uploadTaskPdf / deleteTaskPdf). */
  hasPdf?: boolean;
  pdfName?: string | null;
  pdfSize?: number | null;
  /** Read-only, returned by the server. */
  participantCount?: number;
}

export interface ResearchDesignDoc {
  setupComplete: boolean;
  design: ResearchDesignData;
  variables: ResearchVariableData[];
  groups: ResearchGroupData[];
  /** Study tasks (A / B ...): a second factor, balanced inside each group. */
  tasks: ResearchTaskData[];
  participantCount: number;
  unassignedCount: number;
  unassignedTaskCount: number;
}

export interface MailOutboxStats {
  pending: number;
  failed: number;
  nextAttemptAt: string | null;
  sentLast24h: number;
  dailyLimit: number;
  failedItems?: { id: number; participantId: string | null; to: string; subject: string; error: string | null; attempts: number }[];
}

export interface ProtocolSendAllResult {
  ok: boolean;
  sent: number;
  failed: { participantId: string; reason: string }[];
  skippedNotReady: number;
  skippedAlready: number;
  limited: boolean;
}

export interface RandomizeResult {
  preview: boolean;
  seed: string;
  runId?: number;
  assignments: { participantId: string; groupId: number | null; taskId: number | null }[];
  summary: { groupId: number; name: string; added: number; total: number }[];
  cells: AssignmentCell[];
}

// ── Protocol progress types ───────────────────────────────────────────────────────────────────

export type ProtocolProgressStatus = 'NOT_REACHED' | 'PENDING' | 'SCHEDULED' | 'SENT' | 'COMPLETED' | 'SKIPPED';

export interface ProtocolCell {
  status: ProtocolProgressStatus;
  scheduledFor: string | null;
  sentAt: string | null;
  completedAt: string | null;
}

export interface ProtocolMatrixStep {
  id: number;
  stepType: ProtocolStepType;
  titleSr: string;
  titleEn: string;
  delivery: ProtocolDelivery;
}

export interface ProtocolMatrixParticipant {
  participantId: string;
  participantCode?: string | null;
  hasEmail: boolean;
  language: string | null;
  started: boolean;
  finished: boolean;
  statuses: Record<number, ProtocolCell>;
  groupId: number | null;
  groupName: string | null;
  groupAssignedBy?: 'RESEARCHER' | 'RANDOM' | null;
  /** Study task (A / B ...) of the design. */
  taskId?: number | null;
  taskName?: string | null;
  taskAssignedBy?: 'RESEARCHER' | 'RANDOM' | null;
  /** E-mails of this participant waiting in the queue / that failed for good. */
  mailPending?: number;
  mailFailed?: number;
  /** Code Review step: the pull request this participant reviews. */
  prConfigId?: number | null;
  prLabel?: string | null;
  /** Next session slot (YYYY-MM-DD HH:MM) from today on, if any. */
  nextSlot?: string | null;
}

export interface ProtocolMatrix {
  groups: { id: number; name: string; weight: number; isControl: boolean }[];
  tasks?: { id: number; name: string; weight: number }[];
  prTasks?: { id: number; label: string }[];
  steps: ProtocolMatrixStep[];
  participants: ProtocolMatrixParticipant[];
}

export interface ProtocolTimelineStep {
  id: number;
  stepType: ProtocolStepType;
  titleSr: string;
  titleEn: string;
  delivery: ProtocolDelivery;
  delayDays: number | null;
  status: ProtocolProgressStatus;
  scheduledFor: string | null;
  sentAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  linkUrl: string | null;
  linkExpired: boolean;
}

export interface ProtocolTimeline {
  participantId: string;
  participantCode?: string | null;
  email: string | null;
  language: string | null;
  groupId: number | null;
  groupName: string | null;
  prConfigId?: number | null;
  prLabel?: string | null;
  /** The Code Review sessions created for this participant and whether each is finished. */
  reviewSessions?: { sessionId: number; name: string; finished: boolean; finishedAt: string | null }[];
  /** Appointments (termini) this participant is invited to. */
  slots?: { id: number; date: string; time: string; durationMinutes: number; kind: 'ONLINE' | 'IN_PERSON'; meetingUrl: string | null; location: string | null; stepId: number | null; calendarUrl: string | null }[];
  started: boolean;
  steps: ProtocolTimelineStep[];
}

/** What the engine reports after a researcher action. `reason` e.g. NO_EMAIL, EMAIL_FAILED, SCHEDULED, WAITING_FOR_RESEARCHER. */
export interface ProtocolEngineResult {
  ok: boolean;
  reason: string | null;
  sentStepIds: number[];
  currentStepId: number | null;
  finished: boolean;
}

export interface ProtocolStartAllResult {
  started: number;
  failed: { participantId: string; ok: boolean; reason: string | null }[];
  limited: boolean;
}

// ── Research protocol types ───────────────────────────────────────────────────────────────────

export type ProtocolStepType =
  | 'CONSENT' | 'DEMOGRAPHIC' | 'QUESTIONNAIRE' | 'REI40' | 'BIGFIVE' | 'NASA_TLX'
  | 'EXTERNAL_LINK' | 'MESSAGE' | 'MANUAL' | 'EXPERIMENT';
/** The kind of task an EXPERIMENT step ("experimental session") wraps. SHEETS and CODE_REVIEW are superadmin-only. */
export type ProtocolTaskKind = 'GENERIC_TASK' | 'GOOGLE_FORM' | 'SHEETS' | 'CODE_REVIEW' | 'OTHER';
export type ProtocolDelivery = 'AUTO' | 'AFTER_DELAY' | 'MANUAL';

export type ReviewMode = 'AI' | 'REPORT' | 'HYBRID';

export interface ProtocolStepConfig {
  url?: string;
  taskKind?: ProtocolTaskKind;
  /** Code Review only: the review mode everyone gets unless their group has its own, and an optional practice session first. */
  defaultMode?: ReviewMode;
  modeByGroup?: { groupId: number; mode: ReviewMode }[];
  includeIntro?: boolean;
  bodySr?: string;
  bodyEn?: string;
}

export interface ProtocolStep {
  id: number;
  stepType: ProtocolStepType;
  titleSr: string;
  titleEn: string;
  questionnaireId: number | null;
  config: ProtocolStepConfig;
  delivery: ProtocolDelivery;
  delayDays: number | null;
  emailMessageSr: string | null;
  emailMessageEn: string | null;
  /** Participants who already have progress on this step — the step is then locked. */
  participantsStarted: number;
}

/** What the editor sends back: existing steps carry their id, new ones don't. */
export type ProtocolStepInput = Omit<ProtocolStep, 'id' | 'participantsStarted'> & { id?: number };

export interface ProtocolConfig {
  flowMode: FlowMode;
  steps: ProtocolStep[];
}

export type ProtocolSaveResult =
  | { ok: true }
  | { ok: false; error: string; reason?: string; stepType?: string };

// ── Questionnaire types ───────────────────────────────────────────────────────────────────────

export type QuestionnaireItemType = 'LIKERT' | 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'TEXT' | 'NUMBER';

export interface QuestionnaireOption {
  /** Stable uuid, assigned by the server; absent on a brand-new option. */
  key?: string;
  labelSr: string;
  labelEn: string;
  isOther: boolean;
}

export interface QuestionnaireScaleLabels {
  minSr?: string;
  minEn?: string;
  maxSr?: string;
  maxEn?: string;
}

export interface QuestionnaireItem {
  /** Stable uuid, assigned by the server; absent on a brand-new item. */
  itemKey?: string;
  itemType: QuestionnaireItemType;
  promptSr: string;
  promptEn: string;
  options: QuestionnaireOption[];
  scalePoints: number | null;
  scaleLabels: QuestionnaireScaleLabels | null;
  subscale: string | null;
  reverseScored: boolean;
  required: boolean;
}

export interface QuestionnaireSummary {
  id: number;
  titleSr: string;
  titleEn: string;
  createdAt: string;
  itemCount: number;
  responseCount: number;
  usedInSteps: number;
}

export interface QuestionnaireDetail {
  id: number;
  titleSr: string;
  titleEn: string;
  createdAt: string;
  responseCount: number;
  usedInSteps: number;
  items: QuestionnaireItem[];
}

export interface QuestionnaireBody {
  titleSr: string;
  titleEn: string;
  items: QuestionnaireItem[];
}
