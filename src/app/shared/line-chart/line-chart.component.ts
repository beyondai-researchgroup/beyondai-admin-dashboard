import { AfterViewInit, Component, ElementRef, NgZone, OnChanges, OnDestroy, ViewChild, input } from '@angular/core';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

export interface LineChartDataset {
  label: string;
  data: (number | null)[];
  color: string;
}

/**
 * Multi-series line chart, a thin sibling of BarChartComponent (same theming/lifecycle approach)
 * — used both for a single raw EEG channel preview (one dataset) and the composite-index time
 * series (three datasets: Engagement/Cognitive Load/Frontal Asymmetry). Chart.js already has
 * every chart type registered globally by bar-chart.component.ts's own
 * `Chart.register(...registerables)`, so this needs no new dependency.
 */
@Component({
  selector: 'app-line-chart',
  standalone: true,
  template: `<canvas #canvas></canvas>`,
  styles: `
    :host { display: block; width: 100%; height: 100%; }
    canvas { display: block; }
  `,
})
export class LineChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly labels = input.required<string[]>();
  readonly datasets = input.required<LineChartDataset[]>();

  private chart: Chart | null = null;

  constructor(private zone: NgZone) {}

  ngAfterViewInit(): void {
    this.render();
  }

  ngOnChanges(): void {
    if (this.chart) this.render();
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  private render(): void {
    if (!this.canvasRef) return;

    const styles = getComputedStyle(document.documentElement);
    const textColor = styles.getPropertyValue('--color-chart-text').trim() || '#8ff5c2';
    const strongTextColor = styles.getPropertyValue('--color-chart-text-strong').trim() || '#d4fbe8';
    const gridColor = styles.getPropertyValue('--color-border').trim() || '#1e2d3d';
    const surfaceColor = styles.getPropertyValue('--color-surface').trim() || '#121922';
    const fontFamily = (styles.getPropertyValue('--font-body').trim() || 'Inter').replace(/['"]/g, '');

    const datasets = this.datasets().map((d) => ({
      label: d.label,
      data: d.data,
      borderColor: d.color,
      backgroundColor: d.color,
      pointRadius: 0,
      borderWidth: 1.5,
      tension: 0.15,
      spanGaps: true,
    }));

    this.zone.runOutsideAngular(() => {
      // Same destroy-and-recreate approach as BarChartComponent — guarantees theme colors never
      // go stale after a dark/light toggle.
      this.chart?.destroy();

      this.chart = new Chart(this.canvasRef.nativeElement, {
        type: 'line',
        data: { labels: this.labels(), datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: {
              display: datasets.length > 1,
              position: 'bottom',
              labels: { color: textColor, font: { family: fontFamily, size: 12 }, boxWidth: 10, usePointStyle: true, padding: 14 },
            },
            tooltip: {
              backgroundColor: surfaceColor,
              titleColor: strongTextColor,
              bodyColor: textColor,
              borderColor: gridColor,
              borderWidth: 1,
              padding: 10,
              cornerRadius: 8,
            },
          },
          scales: {
            x: {
              grid: { color: gridColor },
              border: { display: false },
              ticks: { color: textColor, font: { family: fontFamily, size: 10 }, maxTicksLimit: 10 },
            },
            y: {
              grid: { color: gridColor },
              border: { display: false },
              ticks: { color: textColor, font: { family: fontFamily, size: 11 } },
            },
          },
        },
      });
    });
  }
}
