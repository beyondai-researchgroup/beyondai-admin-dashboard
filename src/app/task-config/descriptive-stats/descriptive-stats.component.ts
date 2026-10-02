import { Component, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AdminApiService, DescriptiveStatsColumn, DescriptiveStatsResult } from '../../services/admin-api.service';
import { HelpIconComponent } from '../../shared/help-icon/help-icon.component';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';
import { QuestionDetailModalComponent } from '../question-detail-modal/question-detail-modal.component';

/**
 * Automatic descriptive statistics for the research's most-recently-uploaded survey-results CSV
 * (Part G of the platform re-architecture, 2026-09-07) — no R script needed (that's the separate,
 * opt-in RAnalysisComponent below this one); this always runs, purely computed server-side.
 *
 * 2026-09-08 follow-up: replaced the old grid-of-summary-cards layout (reported as "ne znači
 * ništa" — the numbers alone weren't legible without a chart) with a master-detail table — one
 * row per question, a quick summary + counts in the row, click-through to
 * QuestionDetailModalComponent for the full breakdown + a distribution chart.
 */
@Component({
  selector: 'app-descriptive-stats',
  standalone: true,
  imports: [TranslateModule, DecimalPipe, HelpIconComponent, LoadingSpinnerComponent, QuestionDetailModalComponent],
  templateUrl: './descriptive-stats.component.html',
  styleUrl: './descriptive-stats.component.scss',
})
export class DescriptiveStatsComponent {
  private api = inject(AdminApiService);
  private translate = inject(TranslateService);

  readonly researchId = input.required<number>();

  readonly loading = signal(true);
  readonly stats = signal<DescriptiveStatsResult | null>(null);
  readonly error = signal<string | null>(null);
  readonly selected = signal<DescriptiveStatsColumn | null>(null);

  constructor() {
    // allowSignalWrites: load() sets `loading`/`stats`/`error` signals — without this, Angular
    // throws NG0600 the instant load() sets its very first signal (synchronously, before its
    // first `await`), which silently aborts load() before it ever reaches the API call or the
    // `finally` that would clear `loading` — the exact cause of the "spinner never stops" bug
    // found live via a real browser console (2026-09-08), not visible from tsc/ng build alone.
    effect(() => {
      const id = this.researchId();
      this.load(id);
    }, { allowSignalWrites: true });
  }

  async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.stats.set(null);
    const result = await this.api.getDescriptiveStats(researchId);
    this.loading.set(false);
    if (result.ok) {
      this.stats.set(result.stats);
    } else {
      this.error.set(result.error);
    }
  }

  openDetail(col: DescriptiveStatsColumn): void {
    this.selected.set(col);
  }

  closeDetail(): void {
    this.selected.set(null);
  }

  // One-line row summary — the master table's "at a glance" column; the modal (opened on row
  // click) has the full stats + chart. Kept deliberately terse (a number/short phrase, not a
  // sentence) since it sits in a table cell.
  quickSummary(col: DescriptiveStatsColumn): string {
    if (col.questionType === 'CHOICE') {
      const top = col.frequencies?.[0];
      return top ? `${top.value} (${top.count})` : '—';
    }
    if (col.mean != null) {
      const stddev = col.stddev != null ? this.translate.instant('TASK_CONFIG.DESCRIPTIVE_STATS.SUMMARY_MEAN_STDDEV', { mean: col.mean.toFixed(2), stddev: col.stddev.toFixed(2) }) : col.mean.toFixed(2);
      return stddev;
    }
    return '—';
  }
}
