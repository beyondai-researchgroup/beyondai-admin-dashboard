import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { ResearchDesignStore } from './research-design-store.service';
import { AdminApiService } from '../services/admin-api.service';
import { TranslateService } from '@ngx-translate/core';

const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * Study tasks (e.g. Task A and Task B): a second factor next to the groups. When the research draws participants at
 * random, the tasks are shared out inside every group (so each group is split between the tasks in the ratio given
 * by the weights). Which sheet template or text a task means is decided where the templates are built.
 */
@Component({
  selector: 'app-tasks-section',
  standalone: true,
  imports: [FormsModule, TranslateModule],
  templateUrl: './tasks-section.component.html',
  styleUrl: './research-design-sections.scss',
})
export class TasksSectionComponent {
  readonly store = inject(ResearchDesignStore);
  private api = inject(AdminApiService);
  private translate = inject(TranslateService);

  /** Index of the task whose PDF is being uploaded or removed, and the last PDF problem (by task index). */
  readonly pdfBusy = signal<number | null>(null);
  readonly pdfError = signal<{ index: number; key: string } | null>(null);

  async onPdf(i: number, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const researchId = this.store.researchId();
    const task = this.store.tasks()[i];
    if (!file || researchId == null || task?.id == null) return;
    this.pdfError.set(null);
    if (file.size > MAX_PDF_BYTES) { this.pdfError.set({ index: i, key: 'PDF_TOO_LARGE' }); return; }
    this.pdfBusy.set(i);
    const r = await this.api.uploadTaskPdf(researchId, task.id, file);
    this.pdfBusy.set(null);
    if (r.ok) this.store.patchTask(i, { hasPdf: true, pdfName: r.pdfName, pdfSize: r.pdfSize });
    else this.pdfError.set({ index: i, key: r.error === 'NOT_A_PDF' || r.error === 'PDF_TOO_LARGE' ? r.error : 'PDF_UPLOAD' });
  }

  async viewPdf(i: number): Promise<void> {
    const researchId = this.store.researchId();
    const task = this.store.tasks()[i];
    if (researchId == null || task?.id == null) return;
    if (!(await this.api.openTaskPdf(researchId, task.id))) this.pdfError.set({ index: i, key: 'PDF_UPLOAD' });
  }

  async removePdf(i: number): Promise<void> {
    const researchId = this.store.researchId();
    const task = this.store.tasks()[i];
    if (researchId == null || task?.id == null) return;
    if (!confirm((task.pdfName ?? '') + '\n\n' + this.translate.instant('RESEARCH_DESIGN.TASK_PDF_REMOVE_CONFIRM'))) return;
    this.pdfBusy.set(i);
    const ok = await this.api.deleteTaskPdf(researchId, task.id);
    this.pdfBusy.set(null);
    if (ok) this.store.patchTask(i, { hasPdf: false, pdfName: null, pdfSize: null });
    else this.pdfError.set({ index: i, key: 'PDF_UPLOAD' });
  }

  sizeLabel(bytes: number | null | undefined): string {
    if (!bytes) return '';
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  /** A task that already has participants cannot be removed (the server refuses it too). */
  canRemove(i: number): boolean {
    return !(this.store.tasks()[i].participantCount ?? 0);
  }
}
