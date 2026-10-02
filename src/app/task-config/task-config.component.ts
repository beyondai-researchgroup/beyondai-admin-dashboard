import { Component, computed, inject, signal } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AdminApiService, TaskType } from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { SelectComponent, SelectOption } from '../shared/select/select.component';
import { PrReviewTaskComponent } from './pr-review-task/pr-review-task.component';
import { GoogleFormsTaskComponent } from './google-forms-task/google-forms-task.component';
import { GenericTaskComponent } from './generic-task/generic-task.component';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

/**
 * "Task Configuration" (Phase 1 of the task-type project, 2026-08-19) — replaces the old
 * standalone "PR Configuration" page. A research now picks a Task Type here; the layout below
 * the picker switches to whichever child component matches (`PrReviewTaskComponent` is the old
 * PR Config page's content, unchanged; `GoogleFormsTaskComponent`/`GenericTaskComponent` are
 * stubs today, filled in by later phases). Adding a future 4th task type is: one more entry in
 * the backend's `TASK_TYPES` allowlist, one more small component, one more `@case` here.
 */
@Component({
  selector: 'app-task-config',
  standalone: true,
  imports: [TranslateModule, SelectComponent, PrReviewTaskComponent, GoogleFormsTaskComponent, GenericTaskComponent, LoadingSpinnerComponent],
  templateUrl: './task-config.component.html',
  styleUrl: './task-config.component.scss',
})
export class TaskConfigComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private translate = inject(TranslateService);
  private readonly lang = signal(this.translate.currentLang || 'sr');

  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal(false);

  readonly taskType = signal<TaskType>('PR_REVIEW');
  readonly taskTypes = signal<TaskType[]>(['PR_REVIEW', 'GOOGLE_FORMS', 'GENERIC']);

  readonly taskTypeOptions = computed<SelectOption[]>(() =>
    this.taskTypes().map((t) => ({ value: t, label: this.optionLabel(t) }))
  );

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      if (id != null) this.load(id);
    });
  }

  private async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const cfg = await this.api.getTaskConfig(researchId);
      this.taskType.set(cfg.taskType);
      this.taskTypes.set(cfg.taskTypes);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async onTaskTypeChange(value: string | number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.saving()) return;

    const newType = String(value) as TaskType;
    const previous = this.taskType();
    // Optimistic — switches the layout immediately, rolls back on failure.
    this.taskType.set(newType);
    this.saving.set(true);
    this.saveError.set(false);

    try {
      await this.api.updateTaskType(researchId, newType);
    } catch {
      this.taskType.set(previous);
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  private optionLabel(t: TaskType): string {
    this.lang();
    if (t === 'PR_REVIEW') return this.translate.instant('TASK_CONFIG.TASK_TYPE_OPTION_PR_REVIEW');
    if (t === 'GOOGLE_FORMS') return this.translate.instant('TASK_CONFIG.TASK_TYPE_OPTION_GOOGLE_FORMS');
    if (t === 'GENERIC') return this.translate.instant('TASK_CONFIG.TASK_TYPE_OPTION_GENERIC');
    return t;
  }
}
