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
  { key: 'SessionId', label: 'Session' },
  { key: 'Language', label: 'Lang' },
  { key: 'MentalDemand', label: 'Mental' },
  { key: 'PhysicalDemand', label: 'Physical' },
  { key: 'TemporalDemand', label: 'Temporal' },
  { key: 'Performance', label: 'Performance' },
  { key: 'Effort', label: 'Effort' },
  { key: 'Frustration', label: 'Frustration' },
  { key: 'RawTLX', label: 'Raw TLX' },
  { key: 'WeightedTLX', label: 'Weighted TLX' },
  { key: 'CompletedAt', label: 'Completed', type: 'date' },
];

export const DIMENSIONS: SummaryDimension[] = [
  { key: 'MentalDemand', label: 'Mental Demand' },
  { key: 'PhysicalDemand', label: 'Physical Demand' },
  { key: 'TemporalDemand', label: 'Temporal Demand' },
  { key: 'Performance', label: 'Performance' },
  { key: 'Effort', label: 'Effort' },
  { key: 'Frustration', label: 'Frustration' },
  { key: 'RawTLX', label: 'Raw TLX' },
  { key: 'WeightedTLX', label: 'Weighted TLX' },
];

@Component({
  selector: 'app-results-tlx',
  standalone: true,
  imports: [TranslateModule, RawTableComponent, AggregateSummaryComponent, AnswerDetailModalComponent, LoadingSpinnerComponent],
  templateUrl: './results-instrument.component.html',
})
export class ResultsTlxComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);

  readonly title = 'NASA-TLX';
  readonly columns = COLUMNS;
  readonly dimensions = DIMENSIONS;
  readonly rows = signal<Record<string, unknown>[]>([]);
  readonly aggregate = signal<AggregateResult | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);

  // NASA-TLX has no per-item raw-answer drill-down (out of scope — only REI-40/Big Five were
  // asked for). These stubs exist only because results-instrument.component.html is shared
  // across all three instrument pages; rowActionLabel staying null means app-raw-table never
  // renders the action column, so this is fully inert here.
  readonly instrument: AnswerDetailInstrument = 'rei40';
  readonly rowActionLabel: string | null = null;
  readonly selectedAnswerRow = signal<Record<string, unknown> | null>(null);
  onRowAction(_row: Record<string, unknown>): void {}

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
        this.api.getResults('tlx', researchId, 'raw'),
        this.api.getResults('tlx', researchId, 'aggregate'),
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
    this.api.exportCsv('tlx', this.scope.selectedResearchId());
  }
}
