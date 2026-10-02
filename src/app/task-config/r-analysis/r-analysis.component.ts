import { DatePipe } from '@angular/common';
import { Component, ElementRef, OnDestroy, ViewChild, effect, inject, input, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';
import {
  AdminApiService,
  AnalysisRunDetail,
  AnalysisRunSummary,
  AnalysisScriptMeta,
} from '../../services/admin-api.service';
import { RScriptEditorComponent } from '../r-script-editor/r-script-editor.component';

const POLL_INTERVAL_MS = 2000;

/**
 * The Google Forms task type's opt-in "R analysis" step (Task Configuration Phase 3,
 * 2026-08-19) — upload one .R script (most-recent-wins), trigger sandboxed Docker runs against
 * the research's uploaded survey-result files, and view/download each run's plots + interpreted
 * text results. Collapsed behind a toggle by default (`expanded`) — no separate DB "enabled"
 * flag, since an uploaded script is itself the signal a researcher opted in; nothing here runs
 * automatically. See docker/r-runner/ + docs/task-r-analysis-setup.md for the sandbox itself.
 */
@Component({
  selector: 'app-r-analysis',
  standalone: true,
  imports: [TranslateModule, DatePipe, RScriptEditorComponent, LoadingSpinnerComponent],
  templateUrl: './r-analysis.component.html',
  styleUrl: './r-analysis.component.scss',
})
export class RAnalysisComponent implements OnDestroy {
  private api = inject(AdminApiService);

  readonly researchId = input.required<number>();

  @ViewChild('scriptInput') scriptInputRef?: ElementRef<HTMLInputElement>;

  readonly expanded = signal(false);

  readonly script = signal<AnalysisScriptMeta | null>(null);
  readonly scriptLoading = signal(false);
  readonly uploadingScript = signal(false);
  readonly scriptUploadError = signal(false);

  // In-browser R script editor (Part H of the platform re-architecture, 2026-09-07) — upload
  // auto-populates this; Run re-uploads whatever's currently in the editor first, so it always
  // executes what's actually visible, not necessarily the originally-uploaded bytes.
  readonly editorContent = signal('');

  readonly runs = signal<AnalysisRunSummary[]>([]);
  readonly runsLoading = signal(false);
  readonly starting = signal(false);
  readonly startError = signal<'ALREADY_RUNNING' | 'NO_SCRIPT' | 'SERVER_ERROR' | null>(null);

  readonly selectedRunId = signal<number | null>(null);
  readonly selectedRun = signal<AnalysisRunDetail | null>(null);
  readonly selectedRunLoading = signal(false);
  readonly plotUrls = signal<Record<number, string>>({});
  readonly copied = signal(false);

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private loadedResearchId: number | null = null;

  constructor() {
    // allowSignalWrites — see task-file-list.component.ts's identical comment; same
    // NG0600-causes-load()-to-abort-before-clearing-`loading` bug, same fix.
    effect(() => {
      const id = this.researchId();
      if (this.expanded() && id != null && id !== this.loadedResearchId) {
        this.loadedResearchId = id;
        this.loadScript(id);
        this.loadRuns(id);
      }
    }, { allowSignalWrites: true });
  }

  ngOnDestroy(): void {
    this.stopPolling();
    for (const url of Object.values(this.plotUrls())) URL.revokeObjectURL(url);
  }

  toggleExpanded(): void {
    this.expanded.set(!this.expanded());
    if (!this.expanded()) this.stopPolling();
  }

  private async loadScript(researchId: number): Promise<void> {
    this.scriptLoading.set(true);
    try {
      this.script.set(await this.api.getAnalysisScript(researchId));
    } finally {
      this.scriptLoading.set(false);
    }
  }

  private async loadRuns(researchId: number): Promise<void> {
    this.runsLoading.set(true);
    try {
      const runs = await this.api.getAnalysisRuns(researchId);
      this.runs.set(runs);
      this.managePolling(researchId);
    } finally {
      this.runsLoading.set(false);
    }
  }

  private managePolling(researchId: number): void {
    const anyActive = this.runs().some((r) => r.status === 'PENDING' || r.status === 'RUNNING');
    if (anyActive && !this.pollHandle) {
      this.pollHandle = setInterval(() => {
        this.loadRuns(researchId);
        if (this.selectedRunId() != null) this.loadSelectedRun(researchId, this.selectedRunId()!);
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

  async onScriptSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.uploadingScript.set(true);
    this.scriptUploadError.set(false);
    try {
      this.editorContent.set(await file.text());
      this.script.set(await this.api.uploadAnalysisScript(this.researchId(), file));
    } catch {
      this.scriptUploadError.set(true);
    } finally {
      this.uploadingScript.set(false);
      if (this.scriptInputRef) this.scriptInputRef.nativeElement.value = '';
    }
  }

  async startRun(): Promise<void> {
    if (this.starting()) return;
    this.starting.set(true);
    this.startError.set(null);
    try {
      // Re-upload whatever's currently in the editor first, so a run always executes the edited
      // content rather than the originally-uploaded bytes — a no-op round trip if nothing changed
      // since the last upload/run, harmless either way.
      const edited = this.editorContent();
      if (edited.trim()) {
        const filename = this.script()?.originalFilename ?? 'script.R';
        const file = new File([edited], filename, { type: 'text/plain' });
        this.script.set(await this.api.uploadAnalysisScript(this.researchId(), file));
      }

      const result = await this.api.startAnalysisRun(this.researchId());
      if ('error' in result) {
        this.startError.set(result.error);
      } else {
        await this.loadRuns(this.researchId());
        this.selectRun(result.id);
      }
    } finally {
      this.starting.set(false);
    }
  }

  async selectRun(runId: number): Promise<void> {
    this.selectedRunId.set(runId);
    await this.loadSelectedRun(this.researchId(), runId);
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
      // Clipboard API can be blocked (permissions/insecure context) — no dedicated error UI,
      // same low-stakes-failure handling as elsewhere in this app (e.g. downloadTaskFile).
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
