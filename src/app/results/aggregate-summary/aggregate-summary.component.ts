import { DecimalPipe } from '@angular/common';
import { Component, input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { AggregateResult } from '../../services/admin-api.service';

export interface SummaryDimension {
  key: string;
  label: string;
}

/** Mean ± std-dev summary cards, shared by all three Results views. */
@Component({
  selector: 'app-aggregate-summary',
  standalone: true,
  imports: [DecimalPipe, TranslateModule],
  templateUrl: './aggregate-summary.component.html',
})
export class AggregateSummaryComponent {
  readonly result = input.required<AggregateResult | null>();
  readonly dimensions = input.required<SummaryDimension[]>();
}
