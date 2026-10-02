import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ActivityLogDetail, ActivityLogMeta, AdminApiService, EegBandSeries, EegInterpretation, EegMeta, LinkType, ParticipantOverview, ParticipantOverviewScheduledSession, ParticipantRow, ParticipantSurveyAnswer } from '../services/admin-api.service';
import { ThemeService } from '../services/theme.service';
import { BarChartComponent, BarChartDataset } from '../shared/bar-chart/bar-chart.component';
import { LineChartComponent, LineChartDataset } from '../shared/line-chart/line-chart.component';
import { RawTableComponent, TableColumn } from '../results/raw-table/raw-table.component';
import { COLUMNS as TLX_COLUMNS } from '../results/results-tlx.component';
import { COLUMNS as REI40_COLUMNS } from '../results/results-rei40.component';
import { COLUMNS as BIGFIVE_COLUMNS } from '../results/results-bigfive.component';
import { AnswerDetailModalComponent, AnswerDetailInstrument } from '../results/answer-detail-modal/answer-detail-modal.component';
import { PostSessionAnswersModalComponent } from '../results/post-session-answers-modal/post-session-answers-modal.component';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

const TLX_KEYS = ['MentalDemand', 'PhysicalDemand', 'TemporalDemand', 'Performance', 'Effort', 'Frustration', 'RawTLX', 'WeightedTLX'];
const TLX_LABEL_KEYS = ['MENTAL', 'PHYSICAL', 'TEMPORAL', 'PERFORMANCE', 'EFFORT', 'FRUSTRATION', 'RAW', 'WEIGHTED'];

const REI40_KEYS = ['RationalAbility', 'RationalEngagement', 'ExperientialAbility', 'ExperientialEngagement', 'Rationality', 'Experientiality'];
const REI40_LABELS_FIXED = ['RA', 'RE', 'EA', 'EE'];

const BIGFIVE_KEYS = ['Openness', 'Conscientiousness', 'Extraversion', 'Agreeableness', 'Neuroticism'];
const BIGFIVE_LABELS = ['O', 'C', 'E', 'A', 'N'];

/** Strip the ParticipantId column when displaying results scoped to a single participant — it's
 *  redundant once you're already on that participant's own page. */
function withoutParticipantIdColumn(columns: TableColumn[]): TableColumn[] {
  return columns.filter((c) => c.key !== 'ParticipantId');
}

/**
 * Per-participant results page, reached by clicking a row in the Participants list. This is
 * where instrument-specific detail lives (NASA-TLX/REI-40/Big Five) now that the Overview
 * landing page only shows generic, instrument-agnostic aggregates.
 */
@Component({
  selector: 'app-participant-detail',
  standalone: true,
  imports: [TranslateModule, RouterLink, DatePipe, DecimalPipe, BarChartComponent, LineChartComponent, RawTableComponent, AnswerDetailModalComponent, PostSessionAnswersModalComponent, LoadingSpinnerComponent],
  templateUrl: './participant-detail.component.html',
  styleUrl: './participant-detail.component.scss',
})
export class ParticipantDetailComponent {
  private route = inject(ActivatedRoute);
  private api = inject(AdminApiService);
  private translate = inject(TranslateService);
  private themeService = inject(ThemeService);

  readonly participantId = this.route.snapshot.paramMap.get('id') ?? '';

  readonly loading = signal(true);
  readonly notFound = signal(false);
  readonly participant = signal<ParticipantRow | null>(null);

  // "Regenerate links" (Phase E of the consent/token project): re-issues both REI-40/Big Five
  // access tokens and re-sends the email — for a participant whose original 24h links lapsed.
  readonly regenerating = signal(false);
  readonly regenerateResult = signal<'ok' | 'NOT_FOUND' | 'NOT_CONSENTED' | 'NO_EMAIL' | 'NO_LINKS_TO_ISSUE' | 'SERVER_ERROR' | null>(null);

  async regenerateLinks(): Promise<void> {
    if (this.regenerating()) return;
    this.regenerating.set(true);
    this.regenerateResult.set(null);
    try {
      const result = await this.api.regenerateLinks(this.participantId);
      this.regenerateResult.set(result.ok ? 'ok' : result.error);
    } finally {
      this.regenerating.set(false);
    }
  }

  // "Send consent email" (2026-10-01 follow-up) — a one-click researcher action that mints a
  // CONSENT_ENTRY magic link and emails it directly, replacing the old copy/paste-only "Generate"
  // button next to the CONSENT_ENTRY row in the Links table for this specific case. Re-sendable
  // even after consent was already given (e.g. the participant lost the email).
  readonly sendingConsentEmail = signal(false);
  readonly sendConsentEmailResult = signal<'ok' | 'NOT_FOUND' | 'CONSENT_NOT_USED' | 'NO_EMAIL' | 'SERVER_ERROR' | null>(null);

  async sendConsentEmail(): Promise<void> {
    if (this.sendingConsentEmail()) return;
    this.sendingConsentEmail.set(true);
    this.sendConsentEmailResult.set(null);
    try {
      const result = await this.api.sendConsentEmail(this.participantId);
      this.sendConsentEmailResult.set(result.ok ? 'ok' : result.error);
      if (result.ok) await this.loadOverview();
    } finally {
      this.sendingConsentEmail.set(false);
    }
  }

  /** Finds the Timeline's 'consent' step — used to decide whether to show the "send consent
   *  email" button at all (hidden when the research doesn't use a consent form) and whether it's
   *  already been given (changes the button's label to a "resend" variant). */
  consentStep(ov: ParticipantOverview) {
    return ov.timeline.find((s) => s.step === 'consent') ?? null;
  }

  // Timeline + personal links (2026-09-30 follow-up) — a real-data-driven 6-step progress view
  // plus every link ever issued to this participant, replacing the plain "regenerate links by
  // email" button as the primary way a researcher checks/shares a participant's access.
  private readonly allLinkTypes: LinkType[] = ['CODE_REVIEW', 'CONSENT_ENTRY', 'REI40', 'BIGFIVE', 'DEMOGRAPHIC'];
  // Bug fix (2026-10-02): REI40/BIGFIVE/DEMOGRAPHIC are only ever filtered out of this list once
  // the research's own toggles are known (load()) — hides the "Generate" button for a link type
  // the research doesn't actually use, so a researcher can no longer mint a real DEMOGRAPHIC (or
  // REI40/BIGFIVE) link into a questionnaire with zero configured questions. Backend-side
  // (POST /:participantId/links/:type) now also rejects this directly — this is defense in depth,
  // not the only guard.
  readonly usesPsychTests = signal(true);
  readonly usesDemographics = signal(false);
  readonly linkTypes = computed<LinkType[]>(() =>
    this.allLinkTypes.filter((t) => {
      if ((t === 'REI40' || t === 'BIGFIVE') && !this.usesPsychTests()) return false;
      if (t === 'DEMOGRAPHIC' && !this.usesDemographics()) return false;
      return true;
    })
  );

  completedAt(overview: ParticipantOverview, type: LinkType): string | null {
    return overview.linkCompletions?.[type] ?? null;
  }

  findLink(links: ParticipantOverview['links'], type: LinkType) {
    return links.find((l) => l.type === type) ?? null;
  }

  // Surfaces the scheduled date/time next to the matching experimental-session timeline step
  // regardless of its done/current/pending status — the overview endpoint already computed this
  // (ov.scheduling), it just had no template consumer before (2026-10-01 follow-up). Also carries
  // the ExperimentalSession's own id/label (for a direct link to its detail page) and its Google
  // Calendar sync status, mirroring what the Experimental Session detail page already shows per
  // row — the same information, reachable from both directions (same day's follow-up).
  scheduledInfoFor(stepKey: string, ov: ParticipantOverview): ParticipantOverviewScheduledSession | null {
    const entry =
      stepKey === 'experimentalSession1' ? ov.scheduling.experimentalSession1 :
      stepKey === 'experimentalSession2' ? ov.scheduling.experimentalSession2 :
      null;
    if (!entry || !entry.date) return null;
    return entry;
  }

  readonly overview = signal<ParticipantOverview | null>(null);
  readonly overviewLoading = signal(false);
  readonly generatingLinkType = signal<LinkType | null>(null);
  readonly settingBaseline = signal(false);
  readonly copiedLinkType = signal<LinkType | null>(null);

  private async loadOverview(): Promise<void> {
    this.overviewLoading.set(true);
    try {
      this.overview.set(await this.api.getParticipantOverview(this.participantId));
    } catch {
      this.overview.set(null);
    } finally {
      this.overviewLoading.set(false);
    }
  }

  async generateLink(type: LinkType): Promise<void> {
    if (this.generatingLinkType() !== null) return;
    this.generatingLinkType.set(type);
    try {
      await this.api.generateLink(this.participantId, type);
      await this.loadOverview();
    } finally {
      this.generatingLinkType.set(null);
    }
  }

  async copyLink(link: { type: LinkType; url: string }): Promise<void> {
    try {
      await navigator.clipboard.writeText(link.url);
      this.copiedLinkType.set(link.type);
      setTimeout(() => this.copiedLinkType.set(null), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the link is still visible
      // on screen to select/copy by hand, so this is a soft convenience, not worth an error banner.
    }
  }

  async toggleBaseline(): Promise<void> {
    if (this.settingBaseline()) return;
    const currentlyDone = !!this.overview()?.baselineDoneAt;
    this.settingBaseline.set(true);
    try {
      await this.api.setBaseline(this.participantId, !currentlyDone);
      await this.loadOverview();
    } finally {
      this.settingBaseline.set(false);
    }
  }

  readonly tlxRows = signal<Record<string, unknown>[]>([]);
  readonly rei40Rows = signal<Record<string, unknown>[]>([]);
  readonly bigfiveRows = signal<Record<string, unknown>[]>([]);

  readonly selectedAnswerRow = signal<{ instrument: AnswerDetailInstrument; row: Record<string, unknown> } | null>(null);
  // Post-session questionnaire (2026-10-01) — "Dopunski podaci" action on the TLX raw table,
  // same mechanism as selectedAnswerRow above but reading PostSessionAnswers instead of Answers.
  readonly selectedPostSessionRow = signal<Record<string, unknown> | null>(null);

  // Survey answers (2026-09-08 follow-up) — this participant's own row from the research's
  // uploaded results CSV, matched via the researcher-designated ID column on Task Configuration's
  // "Struktura ankete". showSurveySection gates the whole section (GOOGLE_FORMS research only);
  // surveyMatched distinguishes "no CSV row for this participant" from "section not applicable".
  readonly showSurveySection = signal(false);
  readonly surveyMatched = signal(false);
  readonly surveyAnswers = signal<ParticipantSurveyAnswer[]>([]);

  // EEG: only rendered when the participant's research is configured for it. Unlike TLX, the
  // device records once per participant across the whole study (continuous, with manual pauses
  // between sessions) — not session-scoped, same cadence class as REI-40/Big Five.
  readonly usesEeg = signal(false);
  readonly eegDeviceType = signal<string | null>(null);
  // Only the recognized device (server/eeg/insight5.mjs's exact 29-column header) gets parsed
  // into composite indices/band charts — any other configured device is upload/download-only,
  // matching the backend gate on /interpretation and the upload-time format validation.
  readonly eegIsInsight5 = computed(() => this.eegDeviceType() === 'Emotiv Insight 5');
  readonly eegMeta = signal<EegMeta | null>(null);
  readonly eegUploading = signal(false);
  readonly eegError = signal(false);
  readonly eegFormatError = signal(false);

  // Insight-5-specific interpretation (band-power-derived composite indices + marker-based
  // session comparison) — only populated when the stored CSV matches that exact format; a
  // different device's CSV falls back to the generic channel-preview chart above instead.
  readonly eegInterpretation = signal<EegInterpretation | null>(null);

  // X-axis for both the composite-index chart and the band chart: ordinal second in the
  // experiment (elapsed seconds since the recording's first row), computed server-side off the
  // already-parsed timeMs — not re-derived from the timestamp string here, since that turned out
  // unreliable across browsers/formats. Both charts share this (same downsampleSeries() series).
  readonly eegIndexLabels = computed(() => {
    const interp = this.eegInterpretation();
    if (!interp?.recognized) return [];
    return interp.series.elapsedSeconds.map((s) => (s ?? 0).toString());
  });
  readonly eegIndexDatasets = computed<LineChartDataset[]>(() => {
    const interp = this.eegInterpretation();
    if (!interp?.recognized) return [];
    const palette = this.sessionPalette();
    return [
      { label: this.t('PARTICIPANT_DETAIL.EEG_INDEX.ENGAGEMENT'), data: interp.series.engagement, color: palette[0] },
      { label: this.t('PARTICIPANT_DETAIL.EEG_INDEX.COGNITIVE_LOAD'), data: interp.series.cognitiveLoad, color: palette[1] },
      { label: this.t('PARTICIPANT_DETAIL.EEG_INDEX.FRONTAL_ASYMMETRY'), data: interp.series.frontalAsymmetry, color: palette[2] },
    ];
  });

  readonly eegSegments = computed(() => {
    const interp = this.eegInterpretation();
    return interp?.recognized ? interp.segments : [];
  });
  readonly eegSegmentLabels = computed(() => this.eegSegments().map((s) => this.segmentDisplayLabel(s.label)));
  private eegSegmentBarDataset(index: 'engagement' | 'cognitiveLoad' | 'frontalAsymmetry'): BarChartDataset[] {
    return [{ label: index, data: this.eegSegments().map((s) => s.avgIndices[index] ?? 0), color: this.accentColor() }];
  }
  readonly eegEngagementBarDatasets = computed(() => this.eegSegmentBarDataset('engagement'));
  readonly eegCognitiveLoadBarDatasets = computed(() => this.eegSegmentBarDataset('cognitiveLoad'));
  readonly eegFrontalAsymmetryBarDatasets = computed(() => this.eegSegmentBarDataset('frontalAsymmetry'));

  readonly eegMarkers = computed(() => {
    const interp = this.eegInterpretation();
    return interp?.recognized ? interp.markers : [];
  });

  // Device-reported Cortex contact-quality (0-100%) — shown as plain stat tiles, not a chart:
  // a single scalar per segment (and one whole-recording figure) doesn't warrant a 6th line
  // series, it's a reliability indicator for the derived indices above it.
  readonly eegOverallSignalQuality = computed(() => {
    const interp = this.eegInterpretation();
    return interp?.recognized ? interp.avgSignalQuality : null;
  });

  readonly tlxColumns = withoutParticipantIdColumn(TLX_COLUMNS);
  readonly rei40Columns = withoutParticipantIdColumn(REI40_COLUMNS);
  readonly bigfiveColumns = withoutParticipantIdColumn(BIGFIVE_COLUMNS);

  private readonly lang = signal(this.translate.currentLang || 'sr');

  private accentColor = computed(() => this.readCssVar('--color-accent', '#00ff88'));
  private accent2Color = computed(() => this.readCssVar('--color-accent-dim', '#00cc6a'));
  private accent3Color = computed(() => this.readCssVar('--color-border-strong', '#2d3f52'));
  private readonly sessionPalette = computed(() => [this.accentColor(), this.accent2Color(), this.accent3Color()]);

  // Fixed categorical palette for the 5 EEG bands (distinct identities, not a scale — never
  // re-cycled/reassigned). Validated against this app's chart surfaces via the dataviz skill.
  private thetaColor = computed(() => this.readCssVar('--color-band-theta', '#3987e5'));
  private alphaColor = computed(() => this.readCssVar('--color-band-alpha', '#d95926'));
  private betaLColor = computed(() => this.readCssVar('--color-band-betal', '#199e70'));
  private betaHColor = computed(() => this.readCssVar('--color-band-betah', '#c98500'));
  private gammaColor = computed(() => this.readCssVar('--color-band-gamma', '#d55181'));
  private readonly bandPalette = computed(() => [
    this.thetaColor(), this.alphaColor(), this.betaLColor(), this.betaHColor(), this.gammaColor(),
  ]);

  // Band-power charts: 5 small multiples instead of one shared-axis chart — band magnitudes
  // differ a lot by nature (theta/alpha are typically much larger than gamma), so overlaying them
  // on one Y-axis flattened the smaller bands to a near-invisible line. Each band now gets its
  // own chart with its own auto-scaled Y-axis. Each band's value at a point in time is its
  // average across all 5 channels, over the whole experiment. Shares eegIndexLabels' timestamps
  // (same downsampleSeries call) — same factored-helper pattern as eegSegmentBarDataset below.
  private eegBandDataset(band: keyof EegBandSeries): LineChartDataset[] {
    const interp = this.eegInterpretation();
    if (!interp?.recognized) return [];
    const bandLabelKey = { theta: 'THETA', alpha: 'ALPHA', betaL: 'BETA_L', betaH: 'BETA_H', gamma: 'GAMMA' } as const;
    const bandColor = { theta: this.thetaColor(), alpha: this.alphaColor(), betaL: this.betaLColor(), betaH: this.betaHColor(), gamma: this.gammaColor() };
    return [
      { label: this.t(`PARTICIPANT_DETAIL.EEG_BAND.${bandLabelKey[band]}`), data: interp.series.bands[band], color: bandColor[band] },
    ];
  }
  readonly eegThetaDataset = computed(() => this.eegBandDataset('theta'));
  readonly eegAlphaDataset = computed(() => this.eegBandDataset('alpha'));
  readonly eegBetaLDataset = computed(() => this.eegBandDataset('betaL'));
  readonly eegBetaHDataset = computed(() => this.eegBandDataset('betaH'));
  readonly eegGammaDataset = computed(() => this.eegBandDataset('gamma'));

  readonly tlxLabels = computed(() => TLX_LABEL_KEYS.map((k) => this.t(`DIMENSIONS.TLX.${k}`)));
  readonly tlxDatasets = computed<BarChartDataset[]>(() => {
    const palette = this.sessionPalette();
    return this.tlxRows().map((row, i) => ({
      label: this.sessionLabel(row['SessionId']),
      data: TLX_KEYS.map((k) => Number(row[k] ?? 0)),
      color: palette[i % palette.length],
    }));
  });

  // Short-form rows (Rei40Result.Variant === 'short') leave the 4 facet columns NULL — 2-3 items
  // isn't a meaningful facet score (see rei40-short-items.ts) — so charting REI40_KEYS as-is would
  // render them as misleading 0 bars. Branch to a 2-bar Rationality/Experientiality-only chart for
  // those rows instead of defaulting nulls to 0.
  private readonly rei40IsShortForm = computed(() => this.rei40Rows()[0]?.['Variant'] === 'short');
  readonly rei40Labels = computed(() =>
    this.rei40IsShortForm()
      ? [this.t('DIMENSIONS.REI40.RATIONALITY'), this.t('DIMENSIONS.REI40.EXPERIENTIALITY')]
      : [...REI40_LABELS_FIXED, this.t('DIMENSIONS.REI40.RATIONALITY'), this.t('DIMENSIONS.REI40.EXPERIENTIALITY')]
  );
  readonly rei40Datasets = computed<BarChartDataset[]>(() => {
    const row = this.rei40Rows()[0];
    if (!row) return [];
    const keys = this.rei40IsShortForm() ? ['Rationality', 'Experientiality'] : REI40_KEYS;
    return [{ label: 'REI-40', data: keys.map((k) => Number(row[k] ?? 0)), color: this.accentColor() }];
  });

  readonly bigfiveLabels = BIGFIVE_LABELS;
  readonly bigfiveDatasets = computed<BarChartDataset[]>(() => {
    const row = this.bigfiveRows()[0];
    if (!row) return [];
    return [{ label: 'Big Five', data: BIGFIVE_KEYS.map((k) => Number(row[k] ?? 0)), color: this.accentColor() }];
  });

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.notFound.set(false);
    try {
      // null researchId: superadmin sees all, a scoped researcher's own research is
      // resolved server-side regardless — either way this correctly finds a participant that
      // belongs to them without depending on whichever research happens to be picked in the
      // sidebar right now.
      const [participants, tlx, rei40, bigfive] = await Promise.all([
        this.api.getParticipants(null),
        this.api.getResults('tlx', null, 'raw', this.participantId),
        this.api.getResults('rei40', null, 'raw', this.participantId),
        this.api.getResults('bigfive', null, 'raw', this.participantId),
      ]);
      const found = participants.find((p) => p.participantId === this.participantId) ?? null;
      if (!found) {
        this.notFound.set(true);
        return;
      }
      this.participant.set(found);
      this.tlxRows.set((tlx as Record<string, unknown>[]).sort((a, b) => Number(a['SessionId']) - Number(b['SessionId'])));
      this.rei40Rows.set(rei40 as Record<string, unknown>[]);
      this.bigfiveRows.set(bigfive as Record<string, unknown>[]);

      await this.loadOverview();
      await this.loadActivityLogs();

      const research = await this.api.getResearch(found.researchId);
      this.usesEeg.set(research.usesEeg);
      this.eegDeviceType.set(research.eegDeviceType);
      if (research.usesEeg) {
        await this.loadEeg();
      }

      // Bug fix (2026-10-02) — see linkTypes' own doc comment above.
      const studyConfig = await this.api.getStudyConfig(found.researchId);
      this.usesPsychTests.set(studyConfig.usesPsychTests);
      this.usesDemographics.set(studyConfig.usesDemographics);

      // Survey-answers section (2026-09-08 follow-up) — only meaningful for a Google-Forms-typed
      // research; TaskType isn't part of getResearch()'s own response, hence the extra call.
      const taskCfg = await this.api.getTaskConfig(found.researchId);
      this.showSurveySection.set(taskCfg.taskType === 'GOOGLE_FORMS');
      this.showActivityLogSection.set(taskCfg.taskType === 'PR_REVIEW');
      if (taskCfg.taskType === 'GOOGLE_FORMS') {
        const survey = await this.api.getParticipantSurveyAnswers(found.researchId, this.participantId);
        this.surveyMatched.set(survey.matched);
        this.surveyAnswers.set(survey.answers ?? []);
      }
    } catch {
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  // ── Activity log ────────────────────────────────────────────────────────────
  // Per-review-session CSV written by code-review-ai's ActivityLogService and persisted to the
  // shared DB when the session ends. Rendered here as a plain table. 2026-10-01 follow-up: the
  // toggle is now always 3 fixed buttons (Intro/AI/Report, by SessionId — Hybrid is test-
  // participant-only and deliberately excluded) instead of one button per log that happens to
  // exist, so a researcher always sees all three session slots and a clear "no log yet" message
  // for whichever one hasn't run — matching this page's other gated-but-fixed sections (EEG,
  // survey answers). Gated on TaskType === 'PR_REVIEW' (the only research type that can ever
  // produce one), same pattern showSurveySection already uses for GOOGLE_FORMS.

  readonly activityLogSessions: { sessionId: number; labelKey: string }[] = [
    { sessionId: 1, labelKey: 'INTRO' },
    { sessionId: 2, labelKey: 'AI' },
    { sessionId: 3, labelKey: 'REPORT' },
  ];

  readonly showActivityLogSection = signal(false);
  readonly activityLogs = signal<ActivityLogMeta[]>([]);
  readonly selectedActivityLogSessionId = signal<number>(1);
  readonly activityLog = signal<ActivityLogDetail | null>(null);
  readonly activityLogLoading = signal(false);
  readonly activityLogDownloading = signal(false);

  readonly activityLogColumns = computed<TableColumn[]>(() =>
    (this.activityLog()?.columns ?? []).map((key) => ({
      key,
      // The CSV header doubles as the display label — these are researcher-facing field names
      // from a fixed 7-column schema, not translated UI chrome.
      label: key,
      // ActivityLogService writes both timestamps in ISO 8601 ("O" format), which is exactly
      // what RawTableComponent's 'date' rendering expects.
      type: key === 'StartedAt' || key === 'EndedAt' ? ('date' as const) : undefined,
    }))
  );

  private async loadActivityLogs(): Promise<void> {
    try {
      const logs = await this.api.getActivityLogs(this.participantId);
      this.activityLogs.set(logs);
    } catch {
      // Best-effort, exactly like every other optional section here — a participant with no
      // activity log at all simply shows "no log yet" for every session, it isn't an error worth
      // failing the page over.
      this.activityLogs.set([]);
    }
    await this.selectActivityLog(this.selectedActivityLogSessionId());
  }

  async selectActivityLog(sessionId: number): Promise<void> {
    this.selectedActivityLogSessionId.set(sessionId);

    // No point calling the API for a session that isn't even in the metadata list — that's
    // exactly the "no log for this session yet" case the toggle needs to show directly.
    if (!this.activityLogs().some((l) => l.sessionId === sessionId)) {
      this.activityLog.set(null);
      return;
    }

    this.activityLogLoading.set(true);
    try {
      this.activityLog.set(await this.api.getActivityLog(this.participantId, sessionId));
    } catch {
      this.activityLog.set(null);
    } finally {
      this.activityLogLoading.set(false);
    }
  }

  async downloadActivityLog(): Promise<void> {
    const log = this.activityLog();
    if (!log) return;
    this.activityLogDownloading.set(true);
    try {
      await this.api.downloadActivityLog(this.participantId, log.sessionId, log.originalFilename);
    } finally {
      this.activityLogDownloading.set(false);
    }
  }

  private async loadEeg(): Promise<void> {
    const meta = await this.api.getEegMeta(this.participantId);
    this.eegMeta.set(meta);
    // Skip the interpretation call entirely for a non-recognized device — there's nothing for
    // the backend to parse, and this keeps the "other device = upload/download only" behavior
    // from making a request whose answer is always {recognized: false}.
    if (meta.exists && this.eegIsInsight5()) {
      this.eegInterpretation.set(await this.api.getEegInterpretation(this.participantId));
    } else {
      this.eegInterpretation.set(null);
    }
  }

  private segmentDisplayLabel(label: string): string {
    switch (label) {
      case 'Uvod': return this.t('PARTICIPANT_DETAIL.EEG_SEGMENT_LABEL.INTRO');
      case 'AI': return this.t('PARTICIPANT_DETAIL.EEG_SEGMENT_LABEL.AI');
      case 'Report': return this.t('PARTICIPANT_DETAIL.EEG_SEGMENT_LABEL.REPORT');
      default: return label;
    }
  }

  async onEegFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.eegUploading.set(true);
    this.eegError.set(false);
    this.eegFormatError.set(false);
    try {
      await this.api.uploadEeg(this.participantId, file);
      await this.loadEeg();
    } catch (err) {
      // The backend rejects a mismatched CSV for the recognized device with a distinct error
      // code (server/eeg/routes.mjs) — surfaced separately so the message is specific ("wrong
      // format") instead of the generic upload-failed banner.
      if (err instanceof HttpErrorResponse && err.error?.error === 'INVALID_FORMAT') {
        this.eegFormatError.set(true);
      } else {
        this.eegError.set(true);
      }
    } finally {
      this.eegUploading.set(false);
      input.value = '';
    }
  }

  downloadEeg(): void {
    this.api.downloadEeg(this.participantId).catch(() => this.eegError.set(true));
  }

  private sessionLabel(sessionId: unknown): string {
    const session = this.participant()?.sessions.find((s) => s.sessionId === Number(sessionId));
    return session ? this.t('PARTICIPANT_DETAIL.SESSION_LABEL', { name: session.sessionName }) : String(sessionId);
  }

  private readCssVar(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    this.themeService.theme();
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  private t(key: string, params?: object): string {
    this.lang();
    return this.translate.instant(key, params);
  }
}
