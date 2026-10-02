import { Component, computed, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AdminApiService, ImportResult, TaskType } from '../services/admin-api.service';
import { ExcelImportService, ParsedImportFile } from '../services/excel-import.service';
import { ScopeService } from '../services/scope.service';

@Component({
  selector: 'app-participant-import',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './participant-import.component.html',
  styleUrl: './participant-import.component.scss',
})
export class ParticipantImportComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private excel = inject(ExcelImportService);
  private translate = inject(TranslateService);

  readonly isDragOver = signal(false);
  readonly selectedFile = signal<File | null>(null);
  readonly parsing = signal(false);
  readonly parseResult = signal<ParsedImportFile | null>(null);

  readonly importing = signal(false);
  readonly importResult = signal<ImportResult | null>(null);
  readonly importError = signal(false);

  // The selected research's Task type — only PR_REVIEW has a Tasks sheet at all (session + PR
  // assignment). Re-fetched whenever the sidebar's selected research changes, same reactive
  // pattern TaskConfigComponent itself uses.
  readonly taskType = signal<TaskType>('PR_REVIEW');
  readonly isPrReview = computed(() => this.taskType() === 'PR_REVIEW');

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe(async (researchId) => {
      if (researchId == null) return;
      try {
        const cfg = await this.api.getTaskConfig(researchId);
        this.taskType.set(cfg.taskType);
      } catch {
        this.taskType.set('PR_REVIEW');
      }
    });
  }

  readonly isGeneric = computed(() => this.taskType() === 'GENERIC');

  async downloadTemplate(): Promise<void> {
    const lang = this.translate.currentLang === 'en' ? 'en' : 'sr';
    const taskLabels = this.isPrReview() ? await this.getResearchTaskLabels() : [];
    const genericTaskTitles = this.isGeneric() ? await this.getResearchGenericTaskTitles() : [];
    await this.excel.downloadTemplate(lang, this.taskType(), taskLabels, genericTaskTitles);
  }

  // Same "fetched fresh each time, not cached" reasoning as getResearchPrNumbers below — a task
  // just added on the Generic Task page should be pickable immediately.
  private async getResearchGenericTaskTitles(): Promise<string[]> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null) return [];
    try {
      const tasks = await this.api.getGenericTasks(researchId);
      return tasks.map((t) => t.title);
    } catch {
      return [];
    }
  }

  // The Tasks sheet's Task dropdown/validation is specific to whichever research is currently
  // selected in the sidebar — fetched fresh each time (both for the template download and for
  // parsing an upload) rather than cached, so a task added moments ago is picked up immediately
  // without needing a page reload. The Intro task's own label is deliberately excluded — it's
  // never a valid Tasks-sheet value (see PR_CONFIG.HINT / the Instructions sheet).
  private async getResearchTaskLabels(): Promise<string[]> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null) return [];
    try {
      const configs = await this.api.getPrConfigs(researchId);
      return configs.filter((c) => !c.isIntro).map((c) => c.label);
    } catch {
      return [];
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) this.loadFile(file);
  }

  onFileSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.loadFile(file);
    (event.target as HTMLInputElement).value = '';
  }

  clearFile(event: Event): void {
    event.stopPropagation();
    this.selectedFile.set(null);
    this.parseResult.set(null);
    this.importResult.set(null);
    this.importError.set(false);
  }

  private async loadFile(file: File): Promise<void> {
    this.selectedFile.set(file);
    this.importResult.set(null);
    this.importError.set(false);
    this.parsing.set(true);
    this.parseResult.set(null);
    try {
      const taskLabels = await this.getResearchTaskLabels();
      const genericTaskTitles = await this.getResearchGenericTaskTitles();
      // Empty means "couldn't resolve this research's task list" (no research selected, or
      // it genuinely has none yet) — pass undefined rather than an empty Set so parseFile skips
      // the cross-check instead of rejecting every single label as invalid. Same reasoning for
      // generic task titles.
      this.parseResult.set(
        await this.excel.parseFile(
          file,
          taskLabels.length ? new Set(taskLabels) : undefined,
          genericTaskTitles.length ? new Set(genericTaskTitles) : undefined
        )
      );
    } catch {
      this.parseResult.set({
        participants: [],
        tasks: [],
        issues: [{ sheet: '-', row: 0, message: this.translate.instant('IMPORT.PARSE_FAILED') }],
        sheetsFound: [],
      });
    } finally {
      this.parsing.set(false);
    }
  }

  async submitImport(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    const parsed = this.parseResult();
    if (!parsed || parsed.issues.length || this.importing() || researchId == null) return;
    if (!parsed.participants.length && !parsed.tasks.length) return;

    this.importing.set(true);
    this.importError.set(false);
    this.importResult.set(null);

    try {
      const result = await this.api.importParticipants({
        researchId,
        participants: parsed.participants,
        tasks: parsed.tasks,
      });
      this.importResult.set(result);
      this.clearFileSilently();
    } catch {
      this.importError.set(true);
    } finally {
      this.importing.set(false);
    }
  }

  private clearFileSilently(): void {
    this.selectedFile.set(null);
    this.parseResult.set(null);
  }
}
