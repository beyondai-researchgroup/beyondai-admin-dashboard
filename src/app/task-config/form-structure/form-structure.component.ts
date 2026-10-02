import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';
import {
  AdminApiService,
  FormQuestion,
  FormQuestionType,
} from '../../services/admin-api.service';
import { SelectComponent, SelectOption } from '../../shared/select/select.component';
import { HelpIconComponent } from '../../shared/help-icon/help-icon.component';

/**
 * Google Form question metadata editor (Part G of the platform re-architecture, 2026-09-07) —
 * either auto-filled via the researcher's own connected Google account (real OAuth read of the
 * live form's question structure) or built/edited entirely by hand. Both paths write the same
 * TaskFormQuestion rows, so descriptive-stats.component never needs to branch on where a row
 * came from — only this editor cares (a small "source" badge per row).
 */
@Component({
  selector: 'app-form-structure',
  standalone: true,
  imports: [FormsModule, TranslateModule, SelectComponent, HelpIconComponent, LoadingSpinnerComponent],
  templateUrl: './form-structure.component.html',
  styleUrl: './form-structure.component.scss',
})
export class FormStructureComponent {
  private api = inject(AdminApiService);
  private translate = inject(TranslateService);

  readonly researchId = input.required<number>();

  readonly connected = signal(false);
  readonly connectedLoading = signal(true);

  readonly questions = signal<FormQuestion[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal(false);

  readonly reading = signal(false);
  readonly readError = signal<string | null>(null);

  readonly saving = signal(false);
  readonly saveError = signal(false);
  readonly saved = signal(false);

  private readonly lang = signal(this.translate.currentLang || 'sr');
  readonly typeOptions = computed<SelectOption[]>(() => {
    this.lang();
    return (['NUMBER', 'TEXT', 'LIKERT', 'CHOICE'] as FormQuestionType[]).map((t) => ({
      value: t,
      label: this.translate.instant(`TASK_CONFIG.FORM_STRUCTURE.TYPE_${t}`),
    }));
  });

  // Two independent paths (automatic via OAuth, or manual) — both spelled out step by step in
  // the heading's help popup rather than left as a one-line hint (2026-09-07 follow-up request).
  readonly helpSteps = computed(() => {
    this.lang();
    return [
      'TASK_CONFIG.FORM_STRUCTURE.HELP_STEP1',
      'TASK_CONFIG.FORM_STRUCTURE.HELP_STEP2',
      'TASK_CONFIG.FORM_STRUCTURE.HELP_STEP3',
      'TASK_CONFIG.FORM_STRUCTURE.HELP_STEP4',
      'TASK_CONFIG.FORM_STRUCTURE.HELP_STEP5',
    ].map((k) => this.translate.instant(k));
  });

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    // allowSignalWrites — see descriptive-stats.component.ts's identical comment; same
    // NG0600-causes-load()-to-abort-before-clearing-`loading` bug, same fix.
    effect(() => {
      const id = this.researchId();
      this.load(id);
    }, { allowSignalWrites: true });
    this.api.getGoogleFormsStatus().then((s) => this.connected.set(s.connected)).catch(() => this.connected.set(false)).finally(() => this.connectedLoading.set(false));
  }

  private async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    this.saved.set(false);
    try {
      const res = await this.api.getFormQuestions(researchId);
      this.questions.set(res.questions);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  async readFromGoogle(): Promise<void> {
    const researchId = this.researchId();
    if (this.reading()) return;
    this.reading.set(true);
    this.readError.set(null);
    const result = await this.api.readFormStructure(researchId);
    this.reading.set(false);
    if (result.ok) {
      this.questions.set(result.questions);
    } else {
      this.readError.set(result.error);
    }
  }

  addRow(): void {
    this.questions.set([
      ...this.questions(),
      { columnKey: '', label: '', questionType: 'TEXT', source: 'MANUAL' },
    ]);
  }

  removeRow(index: number): void {
    this.questions.set(this.questions().filter((_, i) => i !== index));
  }

  updateRow(index: number, field: keyof FormQuestion, value: string): void {
    const arr = [...this.questions()];
    arr[index] = { ...arr[index], [field]: value };
    this.questions.set(arr);
  }

  // `columnKey` (matched against the CSV header for descriptive stats) and `label` (display text)
  // used to be two separate inputs, but a survey question has exactly one wording — the Google-read
  // path already always set them identically (both = the form's own question title), and manual
  // entry gains nothing from typing the same text twice. One input now drives both fields at once
  // (2026-09-08 follow-up: "prikazi samo jedan, izvorni tekst forme").
  updateText(index: number, value: string): void {
    const arr = [...this.questions()];
    arr[index] = { ...arr[index], columnKey: value, label: value };
    this.questions.set(arr);
  }

  // Radio-style: at most one question can be the participant-ID column (2026-09-08 follow-up) —
  // selecting one clears the flag on every other row client-side, backed up by the same "at most
  // one" rule server-side (400) and at the DB level (a partial unique index).
  setIdColumn(index: number): void {
    this.questions.set(this.questions().map((q, i) => ({ ...q, isParticipantIdColumn: i === index })));
  }

  clearIdColumn(): void {
    this.questions.set(this.questions().map((q) => ({ ...q, isParticipantIdColumn: false })));
  }

  readonly hasIdColumn = computed(() => this.questions().some((q) => q.isParticipantIdColumn));

  async save(): Promise<void> {
    const researchId = this.researchId();
    if (this.saving()) return;
    this.saving.set(true);
    this.saveError.set(false);
    this.saved.set(false);
    const result = await this.api.updateFormQuestions(researchId, this.questions());
    this.saving.set(false);
    if (result.ok) {
      this.saved.set(true);
    } else {
      this.saveError.set(true);
    }
  }
}
