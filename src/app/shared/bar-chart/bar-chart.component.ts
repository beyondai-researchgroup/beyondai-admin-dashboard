import { AfterViewInit, Component, ElementRef, NgZone, OnChanges, OnDestroy, ViewChild, input } from '@angular/core';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

export interface BarChartDataset {
  label: string;
  data: number[];
  color: string;
}

/**
 * Thin Chart.js wrapper (grouped/horizontal bar chart) themed off the app's CSS custom
 * properties, so it automatically matches the current dark/light theme. Chart.js runs its own
 * rAF-driven render loop, so construction/updates happen outside the Angular zone to avoid
 * spurious change-detection churn.
 */
@Component({
  selector: 'app-bar-chart',
  standalone: true,
  template: `<canvas #canvas></canvas>`,
  // Chart.js's `responsive: true` sizes the canvas off its parent element's measured box — but
  // a custom element defaults to `display: inline`, which never actually fills the container
  // it's placed in (a fixed-height card, a modal panel, ...). Without this the canvas ends up
  // some small/default size regardless of what the surrounding layout allocates, which is why
  // the small dashboard cards showed dead space and the expand-modal never actually scaled up.
  styles: `
    :host { display: block; width: 100%; height: 100%; }
    canvas { display: block; }
  `,
})
export class BarChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly labels = input.required<string[]>();
  readonly datasets = input.required<BarChartDataset[]>();
  readonly horizontal = input(false);

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
      backgroundColor: d.color,
      borderRadius: 6,
      maxBarThickness: 32,
      borderSkipped: false as const,
    }));

    this.zone.runOutsideAngular(() => {
      // Always destroy and recreate rather than mutating data + calling .update(): tick/legend/
      // tooltip colors live in `options`, which an in-place update never touches — that left a
      // theme's colors baked in at first creation and never refreshed on a later theme toggle.
      // Recreating is cheap for charts this size and guarantees every color is always current.
      this.chart?.destroy();

      this.chart = new Chart(this.canvasRef.nativeElement, {
        type: 'bar',
        data: { labels: this.labels(), datasets },
        options: {
          indexAxis: this.horizontal() ? 'y' : 'x',
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 400 },
          plugins: {
            legend: {
              display: this.datasets().length > 1,
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
              displayColors: this.datasets().length > 1,
            },
          },
          scales: {
            x: {
              grid: { color: gridColor, display: !this.horizontal() },
              border: { display: false },
              ticks: { color: textColor, font: { family: fontFamily, size: 11 } },
            },
            y: {
              grid: { color: gridColor, display: this.horizontal() },
              border: { display: false },
              ticks: { color: textColor, font: { family: fontFamily, size: 11 } },
              beginAtZero: true,
            },
          },
        },
      });
    });
  }
}
