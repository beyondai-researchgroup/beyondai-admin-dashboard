import { DatePipe } from '@angular/common';
import { Component, ElementRef, ViewChild, effect, inject, input, output, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { AdminApiService, TaskFileMeta, TaskFileUploadRejection } from '../../services/admin-api.service';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';

/**
 * Reusable multi-file upload/list/download/delete widget for a research's task materials.
 * Shared by the Google Forms (mandatory survey-results upload) and Generic (attachment upload)
 * task-type layouts (Task Configuration Phase 2, 2026-08-19) — same
 * multer/BYTEA/`fetch`+`blob`-download backend as EEG's single-file upload, just multi-file and
 * with no owner-per-participant uniqueness constraint.
 *
 * 2026-09-08 follow-up: gained an optional `csvOnly` mode (used by GoogleFormsTaskComponent only
 * — GenericTaskComponent's attachments stay unrestricted) that both narrows the native file
 * picker (`accept=".csv"`) and rejects a non-.csv selection client-side before ever uploading;
 * the server independently enforces the same rule (plus a form-structure-mismatch check) for a
 * Google-Forms-typed research regardless of what this component does, so a direct API call can't
 * bypass it. Also gained drag-and-drop as a second way to add files, alongside the existing
 * click-to-browse button.
 */
@Component({
  selector: 'app-task-file-list',
  standalone: true,
  imports: [TranslateModule, DatePipe, LoadingSpinnerComponent],
  templateUrl: './task-file-list.component.html',
  styleUrl: './task-file-list.component.scss',
})
export class TaskFileListComponent {
  private api = inject(AdminApiService);

  readonly researchId = input.required<number>();
  readonly csvOnly = input(false);

  @ViewChild('fileInput') fileInputRef?: ElementRef<HTMLInputElement>;

  readonly files = signal<TaskFileMeta[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly uploading = signal(false);
  readonly uploadError = signal<string | null>(null);
  readonly uploadRejections = signal<TaskFileUploadRejection[]>([]);
  readonly deletingId = signal<number | null>(null);
  readonly dragging = signal(false);

  // Lets a host page (e.g. GoogleFormsTaskComponent) know the current file count without
  // duplicating fetch logic — used to gate Descriptive Statistics until at least one CSV exists
  // (2026-09-08 follow-up: showing that section before any file is uploaded was confusing).
  readonly filesChange = output<TaskFileMeta[]>();

  constructor() {
    // allowSignalWrites — see form-structure.component.ts's identical comment; same
    // NG0600-causes-load()-to-abort-before-clearing-`loading` bug, same fix.
    effect(() => {
      const id = this.researchId();
      if (id != null) this.load(id);
    }, { allowSignalWrites: true });
  }

  private async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const files = await this.api.getTaskFiles(researchId);
      this.files.set(files);
      this.filesChange.emit(files);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async onFilesSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const fileList = input.files;
    if (fileList && fileList.length) await this.uploadFiles(Array.from(fileList));
    if (this.fileInputRef) this.fileInputRef.nativeElement.value = '';
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (!this.uploading()) this.dragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragging.set(false);
    const fileList = event.dataTransfer?.files;
    if (fileList && fileList.length && !this.uploading()) await this.uploadFiles(Array.from(fileList));
  }

  private async uploadFiles(selected: File[]): Promise<void> {
    this.uploadError.set(null);
    this.uploadRejections.set([]);

    if (this.csvOnly()) {
      const nonCsv = selected.filter((f) => !/\.csv$/i.test(f.name));
      if (nonCsv.length) {
        this.uploadError.set('NOT_CSV');
        this.uploadRejections.set(nonCsv.map((f) => ({ filename: f.name, reason: 'NOT_CSV' as const })));
        return;
      }
    }

    this.uploading.set(true);
    try {
      const result = await this.api.uploadTaskFiles(this.researchId(), selected);
      if (result.ok) {
        await this.load(this.researchId());
      } else {
        this.uploadError.set(result.error);
        this.uploadRejections.set(result.details ?? []);
      }
    } finally {
      this.uploading.set(false);
    }
  }

  async download(file: TaskFileMeta): Promise<void> {
    try {
      await this.api.downloadTaskFile(this.researchId(), file.id, file.originalFilename);
    } catch {
      // Download failures are surfaced as a browser-level failed-navigation-ish no-op today —
      // consistent with EEG's downloadEeg, which has no dedicated error UI either.
    }
  }

  async remove(file: TaskFileMeta): Promise<void> {
    if (this.deletingId() != null) return;
    this.deletingId.set(file.id);
    try {
      await this.api.deleteTaskFile(this.researchId(), file.id);
      await this.load(this.researchId());
    } finally {
      this.deletingId.set(null);
    }
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
