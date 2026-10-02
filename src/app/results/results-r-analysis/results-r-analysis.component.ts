import { DatePipe } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';
import {
  AdminApiService,
  AnalysisRunDetail,
  AnalysisRunSummary,
  AnalysisScriptMeta,
} from '../../services/admin-api.service';
import { ScopeService } from '../../services/scope.service';

const POLL_INTERVAL_MS = 2000;

/**
 * Read-only "R analiza" results page (2026-08-19) — surfaces the Google Forms task type's
 * sandboxed R-analysis output (script metadata, run history, plots + interpreted text of a
 * selected run) under the Results nav group, alongside NASA-TLX/REI-40/Big Five, rather than
 * only inside Task Configuration's own admin form. Upload/run controls stay on Task
 * Configuration's `RAnalysisComponent` — this page is purely a viewer, scoped to the sidebar's
 * selected research like every other results page (`toObservable(scope.selectedResearchId)`).
 * The dashboard shell only links here when a script actually exists for the selected research
 * (see `DashboardShellComponent.loadResultsMenuConfig`) — reachable directly by URL otherwise,
 * in which case an empty-state message is shown instead of erroring.
 */
@Component({
  selector: 'app-results-r-analysis',
  standalone: true,
  imports: [TranslateModule, DatePipe, LoadingSpinnerComponent],
  templateUrl: './results-r-analysis.component.html',
  styleUrl: './results-r-analysis.component.scss',
})
export class ResultsRAnalysisComponent implements OnDestroy {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);

  readonly script = signal<AnalysisScriptMeta | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal(false);

  readonly runs = signal<AnalysisRunSummary[]>([]);

  readonly selectedRunId = signal<number | null>(null);
  readonly selectedRun = signal<AnalysisRunDetail | null>(null);
  readonly selectedRunLoading = signal(false);
  readonly plotUrls = signal<Record<number, string>>({});
  readonly copied = signal(false);

  readonly exporting = signal(false);
  readonly exportError = signal(false);
  // Angular template expressions can't use an inline arrow function (`.some(r => ...)`), so this
  // is resolved here instead of directly in the template.
  readonly hasSuccessfulRun = computed(() => this.runs().some((r) => r.status === 'SUCCESS'));

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private researchId: number | null = null;

  ngOnDestroy(): void {
    this.stopPolling();
    for (const url of Object.values(this.plotUrls())) URL.revokeObjectURL(url);
  }

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      this.stopPolling();
      this.researchId = id;
      this.selectedRunId.set(null);
      this.selectedRun.set(null);
      if (id != null) this.load(id);
    });
  }

  private async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const [script, runs] = await Promise.all([
        this.api.getAnalysisScript(researchId),
        this.api.getAnalysisRuns(researchId),
      ]);
      this.script.set(script);
      this.runs.set(runs);
      this.managePolling(researchId);
      if (runs.length) this.selectRun(runs[0].id);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private managePolling(researchId: number): void {
    const anyActive = this.runs().some((r) => r.status === 'PENDING' || r.status === 'RUNNING');
    if (anyActive && !this.pollHandle) {
      this.pollHandle = setInterval(async () => {
        const runs = await this.api.getAnalysisRuns(researchId);
        this.runs.set(runs);
        if (this.selectedRunId() != null) this.loadSelectedRun(researchId, this.selectedRunId()!);
        this.managePolling(researchId);
      }, POLL_INTERVAL_MS);
    } else if (!anyActive) {
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  async selectRun(runId: number): Promise<void> {
    if (this.researchId == null) return;
    this.selectedRunId.set(runId);
    await this.loadSelectedRun(this.researchId, runId);
  }

  private async loadSelectedRun(researchId: number, runId: number): Promise<void> {
    this.selectedRunLoading.set(true);
    try {
      const detail = await this.api.getAnalysisRun(researchId, runId);
      this.selectedRun.set(detail);

      const currentUrls = this.plotUrls();
      const newUrls: Record<number, string> = {};
      for (const plot of detail.plots) {
        if (currentUrls[plot.id]) {
          newUrls[plot.id] = currentUrls[plot.id];
        } else {
          newUrls[plot.id] = await this.api.fetchAnalysisPlotObjectUrl(researchId, runId, plot.id);
        }
      }
      this.plotUrls.set(newUrls);
    } finally {
      this.selectedRunLoading.set(false);
    }
  }

  async copyResults(): Promise<void> {
    const text = this.selectedRun()?.resultsText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // Clipboard API can be blocked — no dedicated error UI, same low-stakes handling as
      // elsewhere in this app.
    }
  }

  // Unified results-export endpoint (Phase 5 of the modular-platform plan, previously unused by
  // any UI) — downloads the most recent SUCCESSFUL run's results, independent of which run is
  // currently selected above. Distinct from downloadResults(), which downloads the *selected*
  // run's already-loaded text client-side with no extra request.
  async exportLatest(): Promise<void> {
    if (this.researchId == null || this.exporting()) return;
    this.exporting.set(true);
    this.exportError.set(false);
    try {
      await this.api.exportResultsFile(this.researchId, 'R_ANALYSIS');
    } catch {
      this.exportError.set(true);
    } finally {
      this.exporting.set(false);
    }
  }

  downloadResults(): void {
    const text = this.selectedRun()?.resultsText;
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analysis-run-${this.selectedRunId()}-results.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}
