import { Component, HostListener, input, output } from '@angular/core';
import { BarChartComponent, BarChartDataset } from '../bar-chart/bar-chart.component';

/** Full-size overlay for a chart, opened by clicking its card — the small dashboard cards are
 *  too cramped to read comfortably, this gives the same chart a lot more room. */
@Component({
  selector: 'app-chart-modal',
  standalone: true,
  imports: [BarChartComponent],
  templateUrl: './chart-modal.component.html',
  styleUrl: './chart-modal.component.scss',
})
export class ChartModalComponent {
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly labels = input.required<string[]>();
  readonly datasets = input.required<BarChartDataset[]>();

  readonly closed = output<void>();

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }

  onBackdropClick(): void {
    this.closed.emit();
  }
}
