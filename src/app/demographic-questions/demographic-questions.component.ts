import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { AdminApiService, DemographicQuestion, DemographicQuestionOption } from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';
import { SelectComponent, SelectOption } from '../shared/select/select.component';

/** Demographic Questionnaire (2026-10-01): lets a researcher define their own research's
 *  demographic question set — add/remove/reorder questions (drag-to-reorder via @angular/cdk,
 *  same pattern as the Consent Form page), each bilingual (SR/EN). A SINGLE_CHOICE question gets
 *  its own nested, independently reorderable options list, where one option can be flagged
 *  "Other, please specify" (reveals a free-text field for the participant). Whole-tree
 *  delete-then-reinsert on save, same as Consent Form's own PUT. */
@Component({
  selector: 'app-demographic-questions',
  standalone: true,
  imports: [FormsModule, TranslateModule, DragDropModule, LoadingSpinnerComponent, SelectComponent],
  templateUrl: './demographic-questions.component.html',
  styleUrl: './demographic-questions.component.scss',
})
export class DemographicQuestionsComponent {
  private api = inject(AdminApiService);
  private translate = inject(TranslateService);
  readonly scope = inject(ScopeService);

  readonly questions = signal<DemographicQuestion[]>([]);

  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal(false);
  readonly saved = signal(false);

  readonly questionTypeOptions: SelectOption[] = [
    { value: 'TEXT', label: this.translate.instant('DEMOGRAPHIC_QUESTIONS.TYPE_TEXT') },
    { value: 'SINGLE_CHOICE', label: this.translate.instant('DEMOGRAPHIC_QUESTIONS.TYPE_SINGLE_CHOICE') },
  ];

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
      const cfg = await this.api.getDemographicQuestions(researchId);
      this.questions.set(cfg.questions);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  drop(event: CdkDragDrop<DemographicQuestion[]>): void {
    const arr = [...this.questions()];
    moveItemInArray(arr, event.previousIndex, event.currentIndex);
    this.questions.set(arr);
  }

  dropOption(questionIndex: number, event: CdkDragDrop<DemographicQuestionOption[]>): void {
    const questions = [...this.questions()];
    const options = [...questions[questionIndex].options];
    moveItemInArray(options, event.previousIndex, event.currentIndex);
    questions[questionIndex] = { ...questions[questionIndex], options };
    this.questions.set(questions);
  }

  updateQuestion(index: number, field: 'promptSr' | 'promptEn', value: string): void {
    const arr = [...this.questions()];
    arr[index] = { ...arr[index], [field]: value };
    this.questions.set(arr);
  }

  onQuestionTypeChange(index: number, newType: string): void {
    const arr = [...this.questions()];
    const q = arr[index];
    if (newType === 'SINGLE_CHOICE' && q.type !== 'SINGLE_CHOICE') {
      arr[index] = { ...q, type: 'SINGLE_CHOICE', options: [
        { labelSr: '', labelEn: '', isOtherSpecify: false },
        { labelSr: '', labelEn: '', isOtherSpecify: false },
      ] };
    } else if (newType === 'TEXT' && q.type !== 'TEXT') {
      arr[index] = { ...q, type: 'TEXT', options: [] };
    }
    this.questions.set(arr);
  }

  addQuestion(): void {
    this.questions.set([
      ...this.questions(),
      { type: 'SINGLE_CHOICE', promptSr: '', promptEn: '', options: [
        { labelSr: '', labelEn: '', isOtherSpecify: false },
        { labelSr: '', labelEn: '', isOtherSpecify: false },
      ] },
    ]);
  }

  removeQuestion(index: number): void {
    this.questions.set(this.questions().filter((_, i) => i !== index));
  }

  addOption(questionIndex: number): void {
    const arr = [...this.questions()];
    arr[questionIndex] = { ...arr[questionIndex], options: [...arr[questionIndex].options, { labelSr: '', labelEn: '', isOtherSpecify: false }] };
    this.questions.set(arr);
  }

  removeOption(questionIndex: number, optionIndex: number): void {
    const arr = [...this.questions()];
    arr[questionIndex] = { ...arr[questionIndex], options: arr[questionIndex].options.filter((_, i) => i !== optionIndex) };
    this.questions.set(arr);
  }

  updateOption(questionIndex: number, optionIndex: number, field: 'labelSr' | 'labelEn' | 'isOtherSpecify', value: string | boolean): void {
    const arr = [...this.questions()];
    const options = [...arr[questionIndex].options];
    options[optionIndex] = { ...options[optionIndex], [field]: value };
    arr[questionIndex] = { ...arr[questionIndex], options };
    this.questions.set(arr);
  }

  async submit(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (this.saving() || researchId == null || !this.questions().length) return;

    this.saving.set(true);
    this.saveError.set(false);
    this.saved.set(false);

    const result = await this.api
      .updateDemographicQuestions(
        researchId,
        this.questions().map((q) => ({
          type: q.type,
          promptSr: q.promptSr.trim(),
          promptEn: q.promptEn.trim(),
          options: q.type === 'SINGLE_CHOICE'
            ? q.options.map((o) => ({ labelSr: o.labelSr.trim(), labelEn: o.labelEn.trim(), isOtherSpecify: o.isOtherSpecify }))
            : [],
        }))
      )
      .then(
        () => ({ ok: true as const }),
        () => ({ ok: false as const })
      );

    this.saving.set(false);
    if (result.ok) {
      this.saved.set(true);
      await this.load(researchId);
    } else {
      this.saveError.set(true);
    }
  }
}
