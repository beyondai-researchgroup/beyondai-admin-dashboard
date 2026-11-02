import { Component, computed, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AdminApiService, ImportResult, TaskType } from '../services/admin-api.service';
import { ExcelImportService, ParsedImportFile } from '../services/excel-import.service';
import { ScopeService } from '../services/scope.service';
import { StudyConfigStoreService } from '../services/study-config-store.service';

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
  readonly studyConfigStore = inject(StudyConfigStoreService);

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

  /** The automatic group + task draw done right after the import (null when none ran or it failed). */
  readonly autoDraw = computed(() => {
    const a = this.importResult()?.autoAssignment;
    return a && 'seed' in a ? a : null;
  });
  readonly autoDrawFailed = computed(() => {
    const a = this.importResult()?.autoAssignment;
    return !!a && 'error' in a;
  });

  readonly isGeneric = computed(() => this.studyConfigStore.isProtocol()
    ? this.studyConfigStore.protocolTaskKind() === 'GENERIC_TASK'
    : this.taskType() === 'GENERIC');

  async downloadTemplate(): Promise<void> {
    const lang = this.translate.currentLang === 'en' ? 'en' : 'sr';
    const taskLabels = this.isPrReview() ? await this.getResearchTaskLabels() : [];
    const genericTaskTitles = this.isGeneric() ? await this.getResearchGenericTaskTitles() : [];
    // A protocol research is participants-only (its steps come from the protocol), so it gets the same
    // template as a Google-Forms research: no Tasks sheet, no per-participant generic task column.
    const templateType: TaskType = this.studyConfigStore.isProtocol() ? (this.isGeneric() ? 'GENERIC' : 'GOOGLE_FORMS') : this.taskType();
    const groupNames = await this.getResearchGroupNames();
    const prTaskLabels = await this.getProtocolPrTaskLabels();
    const researchTaskNames = await this.getResearchTaskNames();
    await this.excel.downloadTemplate(lang, templateType, taskLabels, genericTaskTitles, groupNames, prTaskLabels, researchTaskNames);
  }

  // A protocol research whose experiment step is Code Review names each participant's PR in the Participants sheet.
  private async getProtocolPrTaskLabels(): Promise<string[]> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || !this.studyConfigStore.isProtocol() || this.studyConfigStore.protocolTaskKind() !== 'CODE_REVIEW') return [];
    return this.getResearchTaskLabels();
  }

  // The Participants sheet's Group column (dropdown + cross-check) lists this research's groups,
  // fetched fresh each time like the task lists above. Only a PROTOCOL research can have groups.
  private async getResearchGroupNames(): Promise<string[]> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || !this.studyConfigStore.isProtocol()) return [];
    try {
      const doc = await this.api.getResearchDesign(researchId);
      return doc.groups.map((g) => g.name);
    } catch {
      return [];
    }
  }

  // The study tasks (A / B ...) of the design, for the ResearchTask column. Two or more only: one task splits nobody.
  private async getResearchTaskNames(): Promise<string[]> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || !this.studyConfigStore.isProtocol()) return [];
    try {
      const doc = await this.api.getResearchDesign(researchId);
      return doc.tasks.length >= 2 ? doc.tasks.map((t) => t.name) : [];
    } catch {
      return [];
    }
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
      const groupNames = await this.getResearchGroupNames();
      const prTaskLabels = await this.getProtocolPrTaskLabels();
      const researchTaskNames = await this.getResearchTaskNames();
      // Empty means "couldn't resolve this research's task list" (no research selected, or
      // it genuinely has none yet) — pass undefined rather than an empty Set so parseFile skips
      // the cross-check instead of rejecting every single label as invalid. Same reasoning for
      // generic task titles.
      this.parseResult.set(
        await this.excel.parseFile(
          file,
          taskLabels.length ? new Set(taskLabels) : undefined,
          genericTaskTitles.length ? new Set(genericTaskTitles) : undefined,
          groupNames.length ? new Set(groupNames.map((n) => n.toLowerCase())) : undefined,
          prTaskLabels.length ? new Set(prTaskLabels) : undefined,
          researchTaskNames.length ? new Set(researchTaskNames.map((n) => n.toLowerCase())) : undefined
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
