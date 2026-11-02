import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';
import { SelectComponent, SelectOption } from '../../shared/select/select.component';
import {
  AdminApiService,
  QuestionnaireAggregateItem,
  QuestionnaireResultsAggregate,
  QuestionnaireResultsItem,
  QuestionnaireResultsListItem,
  QuestionnaireResultsRaw,
} from '../../services/admin-api.service';
import { ScopeService } from '../../services/scope.service';

/**
 * Results of the researcher-authored questionnaires of a PROTOCOL research (2026-10): the raw
 * per-participant answers, a per-item breakdown with subscale scores (reverse scoring applied), and a
 * CSV export. One questionnaire can be a repeated measure (several protocol steps), so the page can be
 * narrowed to a single step. Answers are keyed by the item's stable key on the server.
 */
@Component({
  selector: 'app-results-questionnaires',
  standalone: true,
  imports: [TranslateModule, DatePipe, LoadingSpinnerComponent, SelectComponent],
  templateUrl: './results-questionnaires.component.html',
  styleUrl: './results-questionnaires.component.scss',
})
export class ResultsQuestionnairesComponent {
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private translate = inject(TranslateService);

  readonly mode = signal<'raw' | 'aggregate'>('raw');
  readonly list = signal<QuestionnaireResultsListItem[]>([]);
  readonly questionnaireId = signal<number | null>(null);
  readonly stepId = signal<number | null>(null);

  readonly raw = signal<QuestionnaireResultsRaw | null>(null);
  readonly aggregate = signal<QuestionnaireResultsAggregate | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly exporting = signal(false);
  readonly exportError = signal(false);

  private researchId: number | null = null;

  private lang(): 'sr' | 'en' {
    return (this.translate.currentLang || 'sr') === 'en' ? 'en' : 'sr';
  }

  readonly questionnaireOptions = computed<SelectOption[]>(() =>
    this.list().map((q) => ({ value: q.id, label: `${this.lang() === 'en' ? q.titleEn : q.titleSr} (${q.responseCount})` })),
  );

  readonly stepOptions = computed<SelectOption[]>(() => {
    const steps = this.raw()?.steps ?? [];
    return [
      { value: 0, label: this.translate.instant('RESULTS_QUESTIONNAIRES.ALL_STEPS') },
      ...steps.map((s) => ({ value: s.stepId, label: this.lang() === 'en' ? s.titleEn : s.titleSr })),
    ];
  });

  /** The step filter only matters when the questionnaire is used by more than one step. */
  readonly showStepFilter = computed(() => (this.raw()?.steps.length ?? 0) > 1);

  /** A Group column only appears when at least one response belongs to a participant that has a group. */
  hasGroupColumn(r: { responses: { groupName?: string | null }[] }): boolean {
    return r.responses.some((x) => !!x.groupName);
  }

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      this.researchId = id;
      if (id != null) this.loadList(id);
    });
  }

  private async loadList(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const { questionnaires } = await this.api.getQuestionnaireResultsList(researchId);
      this.list.set(questionnaires);
      this.stepId.set(null);
      const first = questionnaires[0]?.id ?? null;
      this.questionnaireId.set(first);
      if (first != null) await this.loadResults(); else { this.raw.set(null); this.aggregate.set(null); }
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadResults(): Promise<void> {
    const qid = this.questionnaireId();
    if (this.researchId == null || qid == null) return;
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const [raw, aggregate] = await Promise.all([
        this.api.getQuestionnaireResults(this.researchId, qid, this.stepId()),
        this.api.getQuestionnaireAggregate(this.researchId, qid, this.stepId()),
      ]);
      this.raw.set(raw);
      this.aggregate.set(aggregate);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  onQuestionnaireChange(value: string | number): void {
    this.questionnaireId.set(Number(value));
    this.stepId.set(null);
    this.loadResults();
  }

  onStepChange(value: string | number): void {
    const id = Number(value);
    this.stepId.set(id > 0 ? id : null);
    this.loadResults();
  }

  setMode(mode: 'raw' | 'aggregate'): void {
    this.mode.set(mode);
  }

  prompt(item: { promptSr: string; promptEn: string }): string {
    return this.lang() === 'en' ? item.promptEn : item.promptSr;
  }

  label(o: { labelSr: string; labelEn: string }): string {
    return this.lang() === 'en' ? o.labelEn : o.labelSr;
  }

  stepTitle(r: { stepTitleSr: string | null; stepTitleEn: string | null }): string {
    return (this.lang() === 'en' ? r.stepTitleEn : r.stepTitleSr) ?? '';
  }

  /** A stored answer as the researcher reads it: option labels for choices, the plain value otherwise. */
  displayAnswer(item: QuestionnaireResultsItem, answers: QuestionnaireResultsRaw['responses'][number]['answers']): string {
    const a = answers?.[item.itemKey];
    if (a == null) return '-';
    if (item.type === 'SINGLE_CHOICE' || item.type === 'MULTI_CHOICE') {
      const picked = Array.isArray(a.value) ? a.value : [a.value];
      const text = picked.map((k) => item.options.find((o) => o.key === k)).filter((o) => !!o).map((o) => this.label(o!)).join('; ');
      return a.otherText ? `${text} - ${a.otherText}` : text || '-';
    }
    return String(a.value ?? '-');
  }

  /** Share of the answers that fell on one scale point, for the distribution bars. */
  share(item: QuestionnaireAggregateItem, count: number): number {
    return item.n ? Math.round((count / item.n) * 100) : 0;
  }

  async exportCsv(): Promise<void> {
    const qid = this.questionnaireId();
    if (this.researchId == null || qid == null || this.exporting()) return;
    this.exporting.set(true);
    this.exportError.set(false);
    try {
      await this.api.exportQuestionnaireResults(this.researchId, qid, this.stepId());
    } catch {
      this.exportError.set(true);
    } finally {
      this.exporting.set(false);
    }
  }
}
