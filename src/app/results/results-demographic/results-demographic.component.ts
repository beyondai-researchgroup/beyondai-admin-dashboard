import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';
import { AdminApiService, DemographicQuestion, DemographicResultsAggregate, DemographicResultsRaw } from '../../services/admin-api.service';
import { ScopeService } from '../../services/scope.service';

/**
 * Read-only Demographic Questionnaire results page (2026-10-01) — raw per-participant response
 * list + a per-question frequency breakdown (computed server-side in JS from the stored Answers
 * JSONB, same lightweight approach the old, fully removed Custom Instrument Builder used for its
 * own aggregate view), plus a CSV export button. Scoped to the sidebar's selected research like
 * every other results page.
 */
@Component({
  selector: 'app-results-demographic',
  standalone: true,
  imports: [TranslateModule, DatePipe, LoadingSpinnerComponent],
  templateUrl: './results-demographic.component.html',
  styleUrl: './results-demographic.component.scss',
})
export class ResultsDemographicComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);

  readonly mode = signal<'raw' | 'aggregate'>('raw');

  readonly raw = signal<DemographicResultsRaw | null>(null);
  readonly aggregate = signal<DemographicResultsAggregate | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal(false);

  readonly exporting = signal(false);
  readonly exportError = signal<string | null>(null);

  private researchId: number | null = null;

  readonly questions = computed<DemographicQuestion[]>(() => this.raw()?.questions ?? []);

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      this.researchId = id;
      if (id != null) this.loadBoth(id);
    });
  }

  private async loadBoth(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const [raw, aggregate] = await Promise.all([
        this.api.getDemographicResults(researchId),
        this.api.getDemographicAggregate(researchId),
      ]);
      this.raw.set(raw);
      this.aggregate.set(aggregate);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  setMode(mode: 'raw' | 'aggregate'): void {
    this.mode.set(mode);
  }

  /** Resolves a stored answer for one question on one response row into a human-readable
   *  display string (an option's own SR label, plus the "Other" free text when applicable, or
   *  the raw TEXT answer). */
  displayAnswer(question: DemographicQuestion, answers: Record<string, { value: string; otherText?: string }>): string {
    const a = answers?.[String(question.id)];
    if (!a) return '-';
    if (question.type === 'TEXT') return a.value || '-';
    const opt = question.options.find((o) => String(o.id) === String(a.value));
    if (!opt) return '-';
    return opt.isOtherSpecify && a.otherText ? `${opt.labelSr} - ${a.otherText}` : opt.labelSr;
  }

  async exportCsv(): Promise<void> {
    if (this.researchId == null || this.exporting()) return;
    this.exporting.set(true);
    this.exportError.set(null);
    try {
      await this.api.exportDemographicResults(this.researchId);
    } catch (err: any) {
      this.exportError.set(err?.message ?? 'EXPORT_FAILED');
    } finally {
      this.exporting.set(false);
    }
  }
}
