import { Component, HostListener, computed, inject, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { DescriptiveStatsColumn } from '../../services/admin-api.service';
import { ThemeService } from '../../services/theme.service';
import { BarChartComponent, BarChartDataset } from '../../shared/bar-chart/bar-chart.component';

/**
 * Detail view for one descriptive-stats question/column — opened by clicking its row in
 * DescriptiveStatsComponent's master table (2026-09-08 follow-up: the old grid-of-cards view
 * "ne znači ništa" on its own; every question is now one table row with a click-through detail).
 * One consistent chart shape per question type, as requested: NUMBER/LIKERT/CHOICE all render
 * their value→count `frequencies` as the same bar chart (only the value axis differs — 1..5 for
 * a Likert scale, arbitrary category names for CHOICE); TEXT has nothing to chart, so its detail
 * is the list of actual responses instead.
 */
@Component({
  selector: 'app-question-detail-modal',
  standalone: true,
  imports: [TranslateModule, DecimalPipe, BarChartComponent],
  templateUrl: './question-detail-modal.component.html',
  styleUrl: './question-detail-modal.component.scss',
})
export class QuestionDetailModalComponent {
  private themeService = inject(ThemeService);

  readonly column = input.required<DescriptiveStatsColumn>();
  readonly close = output<void>();

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close.emit();
  }

  private accentColor = computed(() => this.readCssVar('--color-accent', '#00ff88'));

  readonly hasStats = computed(() => this.column().mean != null);
  readonly hasChart = computed(() => (this.column().frequencies?.length ?? 0) > 0);

  readonly chartLabels = computed(() => this.column().frequencies?.map((f) => f.value) ?? []);
  readonly chartDatasets = computed<BarChartDataset[]>(() => [
    { label: this.column().label, data: this.column().frequencies?.map((f) => f.count) ?? [], color: this.accentColor() },
  ]);

  private readCssVar(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    this.themeService.theme();
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }
}
