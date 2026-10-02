import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  AdminApiService,
  GENERIC_TASK_FILE_TYPES,
  GenericTaskAssignableParticipant,
  GenericTaskFileType,
  GenericTaskMeta,
} from '../../services/admin-api.service';
import { ScopeService } from '../../services/scope.service';
import { TaskFileListComponent } from '../task-file-list/task-file-list.component';
import { HelpIconComponent } from '../../shared/help-icon/help-icon.component';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';
import { SelectComponent, SelectOption } from '../../shared/select/select.component';

// Sentinel used only in the assignment dropdown's own value space — a string so it can never
// collide with a real GenericTask.Id (SERIAL, starts at 1). Mapped to genericTaskId: null right
// before the API call.
const UNASSIGNED = 'none';

/**
 * Generic/Custom task layout (Task Configuration Phase 2, 2026-08-19; extended 2026-09-11 with
 * multi-task + per-participant assignment). Three independent pieces on this page:
 *   1. The original free-text instructions + shared TaskFileListComponent — unchanged, still
 *      useful as research-wide reference material every participant's task might share.
 *   2. A list of distinct GenericTask rows (title + instructions text and/or a PDF, at least one
 *      of the two required), managed via an inline list/builder mode-switch.
 *   3. An assignment table — one row per participant, each with a dropdown that auto-saves on
 *      change (mirrors TaskConfigComponent's own TaskType dropdown convention — a single-field
 *      pick needs no separate confirm button).
 * Purely administrative per the user's explicit scope decision (2026-09-11): no participant-facing
 * app shows any of this — a participant receives their assigned task outside the platform.
 */
@Component({
  selector: 'app-generic-task',
  standalone: true,
  imports: [FormsModule, TranslateModule, TaskFileListComponent, HelpIconComponent, LoadingSpinnerComponent, SelectComponent],
  templateUrl: './generic-task.component.html',
  styleUrl: './generic-task.component.scss',
})
export class GenericTaskComponent {
  private api = inject(AdminApiService);
  readonly scope = inject(ScopeService);
  private translate = inject(TranslateService);
  private readonly lang = signal(this.translate.currentLang || 'sr');

  // --- Research-wide instructions + files (unchanged from before this round) ---
  readonly taskInstructions = signal('');
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal(false);
  readonly saved = signal(false);

  // --- Task list + inline builder ---
  readonly tasks = signal<GenericTaskMeta[]>([]);
  readonly tasksLoading = signal(false);
  readonly tasksLoadError = signal(false);

  readonly builderMode = signal<'list' | 'create' | 'edit'>('list');
  readonly editingTaskId = signal<number | null>(null);
  readonly builderTitle = signal('');
  readonly builderInstructions = signal('');
  readonly builderPdfFile = signal<File | null>(null);
  readonly builderExistingPdfFilename = signal<string | null>(null);
  readonly builderRemovePdf = signal(false);
  readonly builderSaving = signal(false);
  readonly builderSaveError = signal<string | null>(null);
  readonly deletingTaskId = signal<number | null>(null);

  // Task-app timer/file-type config (2026-09-14) — every task has a required countdown; allowed
  // file types are a fixed checkbox set (see GENERIC_TASK_FILE_TYPES), empty = any type accepted.
  readonly fileTypeOptions = GENERIC_TASK_FILE_TYPES;
  readonly builderTimerMinutes = signal(30);
  readonly builderAllowedFileTypes = signal<GenericTaskFileType[]>([]);
  readonly builderAllowMultipleFiles = signal(false);

  // --- Assignment table ---
  readonly participants = signal<GenericTaskAssignableParticipant[]>([]);
  readonly participantsLoading = signal(false);
  readonly participantsLoadError = signal(false);
  readonly assignmentSavingId = signal<string | null>(null);
  readonly assignmentErrorId = signal<string | null>(null);

  readonly taskOptions = computed<SelectOption[]>(() => [
    { value: UNASSIGNED, label: this.t('TASK_CONFIG.GENERIC_TASK_UNASSIGNED') },
    ...this.tasks().map((t) => ({ value: t.id, label: t.title })),
  ]);

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));

    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      if (id != null) {
        this.load(id);
        this.loadTasks(id);
        this.loadParticipants(id);
      }
    });
  }

  private async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    this.saved.set(false);
    this.saveError.set(false);
    try {
      const cfg = await this.api.getTaskConfig(researchId);
      this.taskInstructions.set(cfg.taskInstructions ?? '');
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
      await this.api.updateTaskDetails(researchId, { taskInstructions: this.taskInstructions().trim() || null });
      this.saved.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  // --- Task list + builder ---

  private async loadTasks(researchId: number): Promise<void> {
    this.tasksLoading.set(true);
    this.tasksLoadError.set(false);
    try {
      this.tasks.set(await this.api.getGenericTasks(researchId));
    } catch {
      this.tasksLoadError.set(true);
    } finally {
      this.tasksLoading.set(false);
    }
  }

  startCreate(): void {
    this.editingTaskId.set(null);
    this.builderTitle.set('');
    this.builderInstructions.set('');
    this.builderPdfFile.set(null);
    this.builderExistingPdfFilename.set(null);
    this.builderRemovePdf.set(false);
    this.builderTimerMinutes.set(30);
    this.builderAllowedFileTypes.set([]);
    this.builderAllowMultipleFiles.set(false);
    this.builderSaveError.set(null);
    this.builderMode.set('create');
  }

  async startEdit(task: GenericTaskMeta): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null) return;
    this.builderSaveError.set(null);
    try {
      const detail = await this.api.getGenericTask(researchId, task.id);
      this.editingTaskId.set(task.id);
      this.builderTitle.set(detail.title);
      this.builderInstructions.set(detail.instructionsText ?? '');
      this.builderPdfFile.set(null);
      this.builderExistingPdfFilename.set(detail.pdfFilename);
      this.builderRemovePdf.set(false);
      this.builderTimerMinutes.set(detail.timerMinutes);
      this.builderAllowedFileTypes.set(detail.allowedFileTypes);
      this.builderAllowMultipleFiles.set(detail.allowMultipleFiles);
      this.builderMode.set('edit');
    } catch {
      this.builderSaveError.set('LOAD_FAILED');
    }
  }

  toggleBuilderFileType(type: GenericTaskFileType): void {
    this.builderAllowedFileTypes.update((list) =>
      list.includes(type) ? list.filter((t) => t !== type) : [...list, type]
    );
  }

  cancelBuilder(): void {
    this.builderMode.set('list');
  }

  onPdfSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.builderPdfFile.set(file);
    if (file) this.builderRemovePdf.set(false);
  }

  markRemovePdf(): void {
    this.builderRemovePdf.set(true);
    this.builderPdfFile.set(null);
  }

  async saveTask(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    const title = this.builderTitle().trim();
    const instructionsText = this.builderInstructions().trim();
    if (researchId == null || this.builderSaving() || !title) return;
    if (
      !instructionsText &&
      !this.builderPdfFile() &&
      !(this.builderMode() === 'edit' && this.builderExistingPdfFilename() && !this.builderRemovePdf())
    ) {
      this.builderSaveError.set('AT_LEAST_ONE_REQUIRED');
      return;
    }
    const timerMinutes = this.builderTimerMinutes();
    if (!Number.isInteger(timerMinutes) || timerMinutes < 1 || timerMinutes > 180) {
      this.builderSaveError.set('INVALID_TIMER');
      return;
    }

    this.builderSaving.set(true);
    this.builderSaveError.set(null);
    const taskId = this.editingTaskId();
    const fields = {
      title,
      instructionsText,
      timerMinutes,
      allowedFileTypes: this.builderAllowedFileTypes(),
      allowMultipleFiles: this.builderAllowMultipleFiles(),
    };
    const result =
      this.builderMode() === 'edit' && taskId != null
        ? await this.api.updateGenericTask(researchId, taskId, { ...fields, removePdf: this.builderRemovePdf() }, this.builderPdfFile())
        : await this.api.createGenericTask(researchId, fields, this.builderPdfFile());
    this.builderSaving.set(false);
    if (result.ok) {
      this.builderMode.set('list');
      await this.loadTasks(researchId);
    } else {
      this.builderSaveError.set(result.error);
    }
  }

  async deleteTask(task: GenericTaskMeta): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.deletingTaskId() != null) return;
    if (!confirm(this.t('TASK_CONFIG.GENERIC_TASK_DELETE_CONFIRM'))) return;

    this.deletingTaskId.set(task.id);
    try {
      await this.api.deleteGenericTask(researchId, task.id);
      await this.loadTasks(researchId);
      await this.loadParticipants(researchId);
    } finally {
      this.deletingTaskId.set(null);
    }
  }

  async downloadPdf(task: GenericTaskMeta): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || !task.pdfFilename) return;
    await this.api.downloadGenericTaskPdf(researchId, task.id, task.pdfFilename);
  }

  // --- Assignment table ---

  private async loadParticipants(researchId: number): Promise<void> {
    this.participantsLoading.set(true);
    this.participantsLoadError.set(false);
    try {
      this.participants.set(await this.api.getGenericTaskParticipants(researchId));
    } catch {
      this.participantsLoadError.set(true);
    } finally {
      this.participantsLoading.set(false);
    }
  }

  async onAssignmentChange(participantId: string, value: string | number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null) return;
    const genericTaskId = value === UNASSIGNED ? null : Number(value);

    this.assignmentSavingId.set(participantId);
    this.assignmentErrorId.set(null);
    const result = await this.api.updateGenericTaskAssignment(researchId, participantId, genericTaskId);
    this.assignmentSavingId.set(null);
    if (result.ok) {
      this.participants.update((list) =>
        list.map((p) => (p.participantId === participantId ? { ...p, genericTaskId } : p))
      );
    } else {
      this.assignmentErrorId.set(participantId);
    }
  }

  private t(key: string): string {
    this.lang();
    return this.translate.instant(key);
  }
}
