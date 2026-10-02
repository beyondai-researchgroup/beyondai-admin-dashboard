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
  { key: 'Openness', label: 'Openness' },
  { key: 'Conscientiousness', label: 'Conscientiousness' },
  { key: 'Extraversion', label: 'Extraversion' },
  { key: 'Agreeableness', label: 'Agreeableness' },
  { key: 'Neuroticism', label: 'Neuroticism' },
  { key: 'CompletedAt', label: 'Completed', type: 'date' },
];

export const DIMENSIONS: SummaryDimension[] = [
  { key: 'Openness', label: 'Openness' },
  { key: 'Conscientiousness', label: 'Conscientiousness' },
  { key: 'Extraversion', label: 'Extraversion' },
  { key: 'Agreeableness', label: 'Agreeableness' },
  { key: 'Neuroticism', label: 'Neuroticism' },
];

@Component({
  selector: 'app-results-bigfive',
  standalone: true,
  imports: [TranslateModule, RawTableComponent, AggregateSummaryComponent, AnswerDetailModalComponent, LoadingSpinnerComponent],
  templateUrl: './results-instrument.component.html',
})
export class ResultsBigFiveComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);

  readonly title = 'Big Five';
  readonly columns = COLUMNS;
  readonly dimensions = DIMENSIONS;
  readonly rows = signal<Record<string, unknown>[]>([]);
  readonly aggregate = signal<AggregateResult | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);

  readonly instrument: AnswerDetailInstrument = 'bigfive';
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
        this.api.getResults('bigfive', researchId, 'raw'),
        this.api.getResults('bigfive', researchId, 'aggregate'),
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
    this.api.exportCsv('bigfive', this.scope.selectedResearchId());
  }
}
