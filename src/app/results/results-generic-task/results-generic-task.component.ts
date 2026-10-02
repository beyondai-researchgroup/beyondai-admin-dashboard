import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';
import { AdminApiService, GenericTaskSubmission } from '../../services/admin-api.service';
import { ScopeService } from '../../services/scope.service';

/**
 * Read-only "Zadaci ispitanika" results page (2026-09-14) — download-only, no interpretation of
 * uploaded files (per the user's explicit scope decision). One row per participant submission
 * (task title, timed-out flag, submitted-at, per-file download links) plus a "download everything
 * as one .zip" button. Scoped to the sidebar's selected research like every other results page.
 */
@Component({
  selector: 'app-results-generic-task',
  standalone: true,
  imports: [TranslateModule, DatePipe, LoadingSpinnerComponent],
  templateUrl: './results-generic-task.component.html',
  styleUrl: './results-generic-task.component.scss',
})
export class ResultsGenericTaskComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);

  readonly submissions = signal<GenericTaskSubmission[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal(false);

  readonly exportingZip = signal(false);
  readonly exportZipError = signal<string | null>(null);

  private researchId: number | null = null;

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      this.researchId = id;
      if (id != null) this.load(id);
    });
  }

  private async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      this.submissions.set(await this.api.getGenericTaskSubmissions(researchId));
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async downloadFile(submissionId: number, fileId: number, filename: string): Promise<void> {
    if (this.researchId == null) return;
    await this.api.downloadGenericTaskSubmissionFile(this.researchId, submissionId, fileId, filename);
  }

  async downloadAllZip(): Promise<void> {
    if (this.researchId == null || this.exportingZip()) return;
    this.exportingZip.set(true);
    this.exportZipError.set(null);
    try {
      await this.api.downloadGenericTaskSubmissionsZip(this.researchId);
    } catch (err: any) {
      this.exportZipError.set(err?.message ?? 'EXPORT_FAILED');
    } finally {
      this.exportingZip.set(false);
    }
  }
}
