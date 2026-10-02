import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AdminApiService } from '../../services/admin-api.service';
import { ScopeService } from '../../services/scope.service';
import { TaskFileListComponent } from '../task-file-list/task-file-list.component';
import { RAnalysisComponent } from '../r-analysis/r-analysis.component';
import { FormStructureComponent } from '../form-structure/form-structure.component';
import { DescriptiveStatsComponent } from '../descriptive-stats/descriptive-stats.component';
import { HelpIconComponent } from '../../shared/help-icon/help-icon.component';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';

/**
 * Google Forms task layout (Task Configuration Phase 2, 2026-08-19) — a saved reference link +
 * the mandatory multi-file survey-results upload (`TaskFileListComponent`, shared with the
 * Generic layout). Part G of the platform re-architecture (2026-09-07) adds: the form's question
 * structure (`FormStructureComponent` — read via the researcher's connected Google account, or
 * built by hand), automatic descriptive statistics off the uploaded CSV
 * (`DescriptiveStatsComponent`), on top of the pre-existing opt-in sandboxed R-analysis step.
 */
@Component({
  selector: 'app-google-forms-task',
  standalone: true,
  imports: [FormsModule, TranslateModule, TaskFileListComponent, RAnalysisComponent, FormStructureComponent, DescriptiveStatsComponent, HelpIconComponent, LoadingSpinnerComponent],
  templateUrl: './google-forms-task.component.html',
})
export class GoogleFormsTaskComponent {
  private api = inject(AdminApiService);
  readonly scope = inject(ScopeService);

  readonly googleFormsUrl = signal('');
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal(false);
  readonly saved = signal(false);

  // The SAVED link, distinct from `googleFormsUrl` (which also tracks the live, possibly
  // unsaved, text field) — gates "Struktura ankete" so it only appears once a link has actually
  // been saved, not the instant something is typed (2026-09-08 follow-up request). Likewise
  // `hasFiles` gates "Opisna statistika", since there's nothing to compute stats from before at
  // least one result file exists — fed by TaskFileListComponent's own (filesChange) output
  // rather than a second fetch here.
  readonly hasSavedGoogleFormsUrl = signal(false);
  readonly hasFiles = signal(false);

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      if (id != null) this.load(id);
    });
  }

  private async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    this.saved.set(false);
    this.saveError.set(false);
    try {
      const cfg = await this.api.getTaskConfig(researchId);
      this.googleFormsUrl.set(cfg.googleFormsUrl ?? '');
      this.hasSavedGoogleFormsUrl.set(!!cfg.googleFormsUrl?.trim());
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async submit(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.saving()) return;

    this.saving.set(true);
    this.saveError.set(false);
    this.saved.set(false);
    try {
      const trimmed = this.googleFormsUrl().trim();
      await this.api.updateTaskDetails(researchId, { googleFormsUrl: trimmed || null });
      this.hasSavedGoogleFormsUrl.set(!!trimmed);
      this.saved.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }
}
