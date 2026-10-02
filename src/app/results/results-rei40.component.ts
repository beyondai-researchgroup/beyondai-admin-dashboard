import { Component, inject, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AdminApiService, AggregateResult } from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { RawTableComponent, TableColumn } from './raw-table/raw-table.component';
import { AggregateSummaryComponent, SummaryDimension } from './aggregate-summary/aggregate-summary.component';
import { AnswerDetailModalComponent, AnswerDetailInstrument } from './answer-detail-modal/answer-detail-modal.component';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

export const COLUMNS: TableColumn[] = [
  { key: 'ParticipantId', label: 'ID' },
  { key: 'Language', label: 'Lang' },
  // 'short' rows leave the 4 facet columns NULL (RawTableComponent renders null as '—', not a
  // misleading 0) — a 2-3 item facet score isn't meaningful, see rei40-short-items.ts. Variant is
  // shown so that's legible in the raw table rather than implicit.
  { key: 'Variant', label: 'Variant' },
  { key: 'RationalAbility', label: 'Rational Ability' },
  { key: 'RationalEngagement', label: 'Rational Engagement' },
  { key: 'ExperientialAbility', label: 'Experiential Ability' },
  { key: 'ExperientialEngagement', label: 'Experiential Engagement' },
  { key: 'Rationality', label: 'Rationality' },
  { key: 'Experientiality', label: 'Experientiality' },
  { key: 'CompletedAt', label: 'Completed', type: 'date' },
];

export const DIMENSIONS: SummaryDimension[] = [
  { key: 'RationalAbility', label: 'Rational Ability' },
  { key: 'RationalEngagement', label: 'Rational Engagement' },
  { key: 'ExperientialAbility', label: 'Experiential Ability' },
  { key: 'ExperientialEngagement', label: 'Experiential Engagement' },
  { key: 'Rationality', label: 'Rationality' },
  { key: 'Experientiality', label: 'Experientiality' },
];

@Component({
  selector: 'app-results-rei40',
  standalone: true,
  imports: [TranslateModule, RawTableComponent, AggregateSummaryComponent, AnswerDetailModalComponent, LoadingSpinnerComponent],
  templateUrl: './results-instrument.component.html',
})
export class ResultsRei40Component {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);

  readonly title = 'REI-40';
  readonly columns = COLUMNS;
  readonly dimensions = DIMENSIONS;
  readonly rows = signal<Record<string, unknown>[]>([]);
  readonly aggregate = signal<AggregateResult | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);

  readonly instrument: AnswerDetailInstrument = 'rei40';
  readonly rowActionLabel = 'RESULTS.VIEW_ANSWERS';
  readonly selectedAnswerRow = signal<Record<string, unknown> | null>(null);
  onRowAction(row: Record<string, unknown>): void {
    this.selectedAnswerRow.set(row);
  }

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((researchId) => {
      this.load(researchId);
    });
  }

  private async load(researchId: number | null): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const [raw, agg] = await Promise.all([
        this.api.getResults('rei40', researchId, 'raw'),
        this.api.getResults('rei40', researchId, 'aggregate'),
      ]);
      this.rows.set(raw as Record<string, unknown>[]);
      this.aggregate.set(agg as AggregateResult);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  export(): void {
    this.api.exportCsv('rei40', this.scope.selectedResearchId());
  }
}
