import { Component, computed, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  AdminApiService,
  AggregateResult,
  DescriptiveStatsColumn,
  DescriptiveStatsResult,
  ParticipantRow,
} from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { StudyConfigStoreService } from '../services/study-config-store.service';
import { ThemeService } from '../services/theme.service';
import { BarChartComponent, BarChartDataset } from '../shared/bar-chart/bar-chart.component';
import { ChartModalComponent } from '../shared/chart-modal/chart-modal.component';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

const MAX_FEATURED_SURVEY_CHARTS = 3;

// 'survey:<columnKey>' for a featured Google-Forms question chart (2026-09-08 follow-up) — the
// prefix keeps it disjoint from the two fixed keys without needing a second discriminated field.
type ChartKey = 'sessions' | 'completion' | `survey:${string}`;

interface ExpandedChart {
  key: ChartKey;
  title: string;
  subtitle: string;
  labels: string[];
  datasets: BarChartDataset[];
}

const SESSION_NAMES = ['Intro', 'AI', 'Report'];

/**
 * The landing page is deliberately instrument-agnostic — it never names NASA-TLX/REI-40/Big Five.
 * It only shows aggregated counts and general session-progress/completion charts; per-instrument
 * detail lives on a participant's own detail page instead (see ParticipantDetailComponent).
 */
@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [TranslateModule, RouterLink, BarChartComponent, ChartModalComponent, LoadingSpinnerComponent],
  templateUrl: './overview.component.html',
})
export class OverviewComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private studyConfigStore = inject(StudyConfigStoreService);
  private translate = inject(TranslateService);
  private themeService = inject(ThemeService);

  readonly loading = signal(false);
  readonly error = signal(false);
  readonly expandedChart = signal<ExpandedChart | null>(null);

  readonly participants = signal<ParticipantRow[]>([]);
  private readonly tlx = signal<AggregateResult | null>(null);
  private readonly rei40 = signal<AggregateResult | null>(null);
  private readonly bigfive = signal<AggregateResult | null>(null);
  // Google Forms survey-results summary (2026-09-08 follow-up) — `null` covers both "not a
  // Google-Forms-typed research" and "no CSV uploaded yet" (getDescriptiveStats' NO_CSV_FILE
  // error resolves here the same way a network error would: no data to show, no crash).
  private readonly surveyStats = signal<DescriptiveStatsResult | null>(null);

  // ngx-translate's `| translate` pipe is reactive to language switches (it subscribes to
  // onLangChange internally), but `TranslateService.instant()` is a one-off snapshot with no
  // such hook — reading it inside a computed() never re-runs on its own when the language
  // changes. This signal exists purely so every computed() below that needs translate.instant()
  // has something to depend on that DOES change when the language does.
  private readonly lang = signal(this.translate.currentLang || 'sr');

  readonly participantsCount = computed(() => this.participants().length);
  readonly sessionsTotal = computed(() => this.participantsCount() * 3);
  readonly sessionsDone = computed(() =>
    this.participants().reduce((sum, p) => sum + p.sessions.filter((s) => s.isFinished).length, 0)
  );

  // Sum of every instrument's result count — a single generic "results collected" number,
  // without naming which instruments they came from.
  readonly resultsTotal = computed(
    () => (this.tlx()?.count ?? 0) + (this.rei40()?.count ?? 0) + (this.bigfive()?.count ?? 0)
  );

  // Gating — this page used to unconditionally show Intro/AI/Report session charts and fetch
  // TLX/REI-40/Big Five data for every research, regardless of what that research actually uses.
  // Driven by StudyConfigStoreService — the same signal that already gates the Results menu AND
  // actually determines whether this data can exist.
  readonly showResultsStat = computed(() => this.studyConfigStore.usesTlx() || this.studyConfigStore.usesPsychTests());

  // The fixed Intro/AI/Report session structure (and this stat/these charts' "3 sessions per
  // participant" assumption) only applies to a PR-review research — code-review-ai's own flow
  // doesn't run at all for any other task type. A freshly created research with no participants
  // imported yet has zero ParticipantSession rows — the chart would render as an empty all-zero
  // breakdown, so this also requires participantsCount() > 0. It reappears the moment
  // participants are actually imported.
  readonly showSessionCharts = computed(
    () => this.studyConfigStore.taskType() === 'PR_REVIEW' && this.participantsCount() > 0
  );
  readonly showSessionsStat = this.showSessionCharts;

  readonly sessionBreakdown = computed(() =>
    SESSION_NAMES.map((name) => {
      const rows = this.participants().flatMap((p) => p.sessions.filter((s) => s.sessionName === name));
      return { name, finished: rows.filter((s) => s.isFinished).length, total: rows.length };
    })
  );

  readonly activeSessionChartLabels = computed(() => this.sessionBreakdown().map((s) => s.name));
  readonly activeSessionChartDatasets = computed<BarChartDataset[]>(() => [
    {
      label: this.t('OVERVIEW.SESSION_FINISHED'),
      data: this.sessionBreakdown().map((s) => s.finished),
      color: this.accentColor(),
    },
    {
      label: this.t('OVERVIEW.SESSION_REMAINING'),
      data: this.sessionBreakdown().map((s) => s.total - s.finished),
      color: this.mutedColor(),
    },
  ]);

  // Not started (0/3 finished) / in progress (1-2/3) / completed all (3/3) — a general
  // per-participant completion breakdown, independent of which instrument is involved.
  readonly completionBreakdown = computed(() => {
    let notStarted = 0;
    let inProgress = 0;
    let completed = 0;
    for (const p of this.participants()) {
      const done = p.sessions.filter((s) => s.isFinished).length;
      if (done === 0) notStarted++;
      else if (done >= p.sessions.length && p.sessions.length > 0) completed++;
      else inProgress++;
    }
    return { notStarted, inProgress, completed };
  });

  readonly completionChartLabels = computed(() => [
    this.t('OVERVIEW.COMPLETION_LABEL.NOT_STARTED'),
    this.t('OVERVIEW.COMPLETION_LABEL.IN_PROGRESS'),
    this.t('OVERVIEW.COMPLETION_LABEL.COMPLETED'),
  ]);
  readonly activeCompletionChartDatasets = computed<BarChartDataset[]>(() => {
    const b = this.completionBreakdown();
    return [{ label: this.t('OVERVIEW.CHART_COMPLETION_TITLE'), data: [b.notStarted, b.inProgress, b.completed], color: this.accent2Color() }];
  });

  readonly showSessionChartGrid = this.showSessionCharts;

  // Survey-results card (2026-09-08 follow-up) — shown only once a Google-Forms-typed research
  // actually has an uploaded CSV to summarize; a fresh research with the task type set but
  // nothing imported yet stays exactly as empty-section-free as the PR-review chart already is.
  readonly showSurveyCard = computed(() => this.surveyStats() != null);

  // First few chartable (LIKERT/CHOICE/best-effort-numeric — anything with a `frequencies`
  // breakdown) questions, in their original column order — a deliberately small "at a glance"
  // sample; the full per-question table lives on Task Configuration's Google Forms tab.
  readonly featuredSurveyColumns = computed<DescriptiveStatsColumn[]>(() =>
    (this.surveyStats()?.columns ?? []).filter((c) => (c.frequencies?.length ?? 0) > 0).slice(0, MAX_FEATURED_SURVEY_CHARTS)
  );
  readonly hasMoreSurveyColumns = computed(() => (this.surveyStats()?.columns.length ?? 0) > this.featuredSurveyColumns().length);

  readonly surveyResponsesCount = computed(() => this.surveyStats()?.rowCount ?? 0);
  readonly surveyResponsesSubLabel = computed(() => this.t('OVERVIEW.STAT_SURVEY_RESPONSES_SUB', { filename: this.surveyStats()?.sourceFilename ?? '' }));

  // 2026-09-08 follow-up — only present once a research has designated a participant-ID column
  // on Task Configuration's "Struktura ankete"; `null` otherwise (not "0 of 0").
  readonly surveyParticipantMatchLabel = computed(() => {
    const pm = this.surveyStats()?.participantMatch;
    if (!pm) return null;
    return this.t('OVERVIEW.SURVEY_PARTICIPANT_MATCH', { matched: pm.matchedCount, total: pm.totalParticipants });
  });

  surveyChartTitle(col: DescriptiveStatsColumn): string {
    return col.label;
  }

  surveyChartLabels(col: DescriptiveStatsColumn): string[] {
    return col.frequencies?.map((f) => f.value) ?? [];
  }

  surveyChartDatasets(col: DescriptiveStatsColumn): BarChartDataset[] {
    return [{ label: col.label, data: col.frequencies?.map((f) => f.count) ?? [], color: this.accentColor() }];
  }

  surveyChartKey(col: DescriptiveStatsColumn): ChartKey {
    return `survey:${col.columnKey}`;
  }

  // Angular template expressions can't nest a pipe inside a method-call argument, so the
  // translated title/subtitle for each chart (used both for card display and the expand-modal
  // open call) are resolved here instead.
  readonly sessionChartTitle = computed(() => this.t('OVERVIEW.CHART_SESSIONS_TITLE'));
  readonly sessionChartSubtitle = computed(() => this.t('OVERVIEW.CHART_SESSIONS_SUBTITLE'));
  readonly completionChartTitle = computed(() => this.t('OVERVIEW.CHART_COMPLETION_TITLE'));
  readonly completionChartSubtitle = computed(() => this.t('OVERVIEW.CHART_COMPLETION_SUBTITLE'));

  // Chart.js can't resolve CSS custom properties itself (canvas fillStyle needs a resolved
  // color), so these read the live values via getComputedStyle — re-reading whenever the theme
  // signal flips keeps the charts in sync with a dark/light toggle.
  private accentColor = computed(() => this.readCssVar('--color-accent', '#00ff88'));
  private accent2Color = computed(() => this.readCssVar('--color-accent-dim', '#00cc6a'));
  private mutedColor = computed(() => this.readCssVar('--color-border-strong', '#2d3f52'));

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe(async (researchId) => {
      // Await the store first — load() below reads its signals synchronously to decide which
      // instrument fetches to skip, so it must see this research's config, not the previous
      // research's still-cached values from before the switch.
      if (researchId != null) await this.studyConfigStore.load(researchId);
      this.load(researchId);
    });
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));

    // If a chart's modal is open when the language changes, refresh its snapshotted
    // title/labels/legend too — otherwise it'd keep showing whatever language was active when
    // it was opened until closed and reopened.
    this.translate.onLangChange.subscribe(() => {
      const current = this.expandedChart();
      if (current) this.openChart(current.key);
    });
  }

  private async load(researchId: number | null): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const usesTlx = this.studyConfigStore.usesTlx();
      const usesPsychTests = this.studyConfigStore.usesPsychTests();
      const isGoogleForms = this.studyConfigStore.taskType() === 'GOOGLE_FORMS';
      const [participants, tlx, rei40, bigfive, surveyStats] = await Promise.all([
        this.api.getParticipants(researchId),
        usesTlx ? this.api.getResults('tlx', researchId, 'aggregate') : Promise.resolve(null),
        usesPsychTests ? this.api.getResults('rei40', researchId, 'aggregate') : Promise.resolve(null),
        usesPsychTests ? this.api.getResults('bigfive', researchId, 'aggregate') : Promise.resolve(null),
        isGoogleForms && researchId != null ? this.api.getDescriptiveStats(researchId) : Promise.resolve(null),
      ]);
      this.participants.set(participants);
      this.tlx.set(tlx as AggregateResult | null);
      this.rei40.set(rei40 as AggregateResult | null);
      this.bigfive.set(bigfive as AggregateResult | null);
      this.surveyStats.set(surveyStats && surveyStats.ok && surveyStats.stats.rowCount > 0 ? surveyStats.stats : null);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private readCssVar(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    this.themeService.theme(); // register as a dependency so this re-reads on theme toggle
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  /** translate.instant(), but registers `lang` as a computed() dependency so callers re-run on
   *  a language switch — instant() alone has no such hook. */
  private t(key: string, params?: object): string {
    this.lang();
    return this.translate.instant(key, params);
  }

  private buildExpandedChart(key: ChartKey): ExpandedChart | null {
    switch (key) {
      case 'sessions':
        return {
          key,
          title: this.sessionChartTitle(),
          subtitle: this.sessionChartSubtitle(),
          labels: this.activeSessionChartLabels(),
          datasets: this.activeSessionChartDatasets(),
        };
      case 'completion':
        return {
          key,
          title: this.completionChartTitle(),
          subtitle: this.completionChartSubtitle(),
          labels: this.completionChartLabels(),
          datasets: this.activeCompletionChartDatasets(),
        };
      default: {
        // 'survey:<columnKey>' — look the column back up rather than threading it through the
        // click handler, so re-opening on a language switch (see the onLangChange subscription
        // below) re-resolves the current label from `featuredSurveyColumns()` automatically.
        const columnKey = key.slice('survey:'.length);
        const col = this.featuredSurveyColumns().find((c) => c.columnKey === columnKey);
        if (!col) return null;
        return {
          key,
          title: this.surveyChartTitle(col),
          subtitle: this.t('OVERVIEW.CHART_SURVEY_SUBTITLE'),
          labels: this.surveyChartLabels(col),
          datasets: this.surveyChartDatasets(col),
        };
      }
    }
  }

  openChart(key: ChartKey): void {
    const chart = this.buildExpandedChart(key);
    if (chart) this.expandedChart.set(chart);
  }

  closeChart(): void {
    this.expandedChart.set(null);
  }
}
