import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import {
  AdminApiService,
  QuestionnaireItem,
  QuestionnaireItemType,
  QuestionnaireSummary,
} from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';
import { SelectComponent, SelectOption } from '../shared/select/select.component';

/** An item as edited on screen: the saved fields plus a local key for @for tracking. */
interface ItemVm extends QuestionnaireItem {
  localKey: number;
}

const ITEM_TYPES: QuestionnaireItemType[] = ['LIKERT', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'TEXT', 'NUMBER'];

/**
 * Researcher-authored questionnaires (2026-10): a researcher builds their own instrument — Likert
 * scales (with sub-scales and reverse-scored items), single/multiple choice, free text, numbers —
 * and then places it in the protocol as a step. Items and choice options carry stable keys, so
 * editing never detaches answers already given; once anybody has answered, the structure is locked
 * (wording can still be corrected) — enforced by the API, mirrored here.
 */
@Component({
  selector: 'app-questionnaires',
  standalone: true,
  imports: [FormsModule, TranslateModule, DragDropModule, LoadingSpinnerComponent, SelectComponent],
  templateUrl: './questionnaires.component.html',
  styleUrl: './questionnaires.component.scss',
})
export class QuestionnairesComponent {
  private api = inject(AdminApiService);
  private translate = inject(TranslateService);
  readonly scope = inject(ScopeService);
  private readonly lang = signal(this.translate.currentLang || 'sr');

  readonly list = signal<QuestionnaireSummary[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal(false);

  /** null = list view; otherwise the editor ('new' for a questionnaire that isn't saved yet). */
  readonly editingId = signal<number | 'new' | null>(null);
  readonly titleSr = signal('');
  readonly titleEn = signal('');
  readonly items = signal<ItemVm[]>([]);
  readonly responseCount = signal(0);
  readonly usedInSteps = signal(0);
  readonly editorLoading = signal(false);

  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly errorKey = signal<string | null>(null);

  /** Structure is locked once anybody has answered. */
  readonly locked = computed(() => this.responseCount() > 0);

  readonly typeOptions = computed<SelectOption[]>(() => {
    this.lang();
    return ITEM_TYPES.map((t) => ({ value: t, label: this.translate.instant('QUESTIONNAIRES.TYPE_' + t) }));
  });

  private nextKey = 1;

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      this.editingId.set(null);
      if (id != null) this.loadList(id);
    });
  }

  async loadList(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      this.list.set((await this.api.getQuestionnaires(researchId)).questionnaires);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private blankItem(type: QuestionnaireItemType): ItemVm {
    return {
      localKey: this.nextKey++,
      itemType: type,
      promptSr: '',
      promptEn: '',
      options: type === 'SINGLE_CHOICE' || type === 'MULTI_CHOICE'
        ? [{ labelSr: '', labelEn: '', isOther: false }, { labelSr: '', labelEn: '', isOther: false }]
        : [],
      scalePoints: type === 'LIKERT' ? 5 : null,
      scaleLabels: null,
      subscale: null,
      reverseScored: false,
      required: type !== 'HEADING',
    };
  }

  newQuestionnaire(): void {
    this.titleSr.set('');
    this.titleEn.set('');
    this.items.set([this.blankItem('LIKERT')]);
    this.responseCount.set(0);
    this.usedInSteps.set(0);
    this.saved.set(false);
    this.errorKey.set(null);
    this.editingId.set('new');
  }

  async edit(id: number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null) return;
    this.editorLoading.set(true);
    this.saved.set(false);
    this.errorKey.set(null);
    this.editingId.set(id);
    try {
      const q = await this.api.getQuestionnaire(researchId, id);
      this.titleSr.set(q.titleSr);
      this.titleEn.set(q.titleEn);
      this.responseCount.set(q.responseCount);
      this.usedInSteps.set(q.usedInSteps);
      this.items.set(q.items.map((i) => ({
        ...i,
        options: i.options.map((o) => ({ ...o })),
        scaleLabels: i.scaleLabels ? { ...i.scaleLabels } : null,
        localKey: this.nextKey++,
      })));
    } catch {
      this.editingId.set(null);
      this.loadError.set(true);
    } finally {
      this.editorLoading.set(false);
    }
  }

  backToList(): void {
    this.editingId.set(null);
    const id = this.scope.selectedResearchId();
    if (id != null) this.loadList(id);
  }

  // ── item editing ──────────────────────────────────────────────────────────────────────────────

  drop(event: CdkDragDrop<ItemVm[]>): void {
    const arr = [...this.items()];
    moveItemInArray(arr, event.previousIndex, event.currentIndex);
    this.items.set(arr);
    this.saved.set(false);
  }

  addItem(): void {
    this.items.set([...this.items(), this.blankItem('LIKERT')]);
    this.saved.set(false);
  }

  /** A small section title between questions (participants see it, it takes no answer). */
  addHeading(): void {
    this.items.set([...this.items(), this.blankItem('HEADING')]);
    this.saved.set(false);
  }

  removeItem(index: number): void {
    if (!this.canRemoveItem(this.items()[index])) return;
    this.items.set(this.items().filter((_, i) => i !== index));
    this.saved.set(false);
  }

  canRemoveItem(item: ItemVm): boolean {
    return item.itemType === 'HEADING' || !(this.locked() && item.itemKey);
  }

  /** A saved item of an answered questionnaire keeps its type and scale. */
  isStructureLocked(item: ItemVm): boolean {
    return this.locked() && !!item.itemKey;
  }

  patch(index: number, changes: Partial<ItemVm>): void {
    const arr = [...this.items()];
    arr[index] = { ...arr[index], ...changes };
    this.items.set(arr);
    this.saved.set(false);
  }

  onTypeChange(index: number, value: string | number): void {
    const type = value as QuestionnaireItemType;
    const cur = this.items()[index];
    if (cur.itemType === type) return;
    const fresh = this.blankItem(type);
    this.patch(index, {
      itemType: type,
      options: fresh.options,
      scalePoints: fresh.scalePoints,
      scaleLabels: null,
      subscale: type === 'LIKERT' ? cur.subscale : null,
      reverseScored: false,
    });
  }

  patchLabel(index: number, key: 'minSr' | 'minEn' | 'maxSr' | 'maxEn', value: string): void {
    const cur = this.items()[index];
    const labels = { ...(cur.scaleLabels ?? {}), [key]: value };
    this.patch(index, { scaleLabels: labels });
  }

  addOption(index: number): void {
    const cur = this.items()[index];
    this.patch(index, { options: [...cur.options, { labelSr: '', labelEn: '', isOther: false }] });
  }

  canRemoveOption(item: ItemVm, optionIndex: number): boolean {
    if (item.options.length <= 2) return false;
    return !(this.locked() && item.itemKey && item.options[optionIndex].key);
  }

  removeOption(index: number, optionIndex: number): void {
    const cur = this.items()[index];
    if (!this.canRemoveOption(cur, optionIndex)) return;
    this.patch(index, { options: cur.options.filter((_, i) => i !== optionIndex) });
  }

  patchOption(index: number, optionIndex: number, changes: Partial<{ labelSr: string; labelEn: string; isOther: boolean }>): void {
    const cur = this.items()[index];
    this.patch(index, { options: cur.options.map((o, i) => (i === optionIndex ? { ...o, ...changes } : o)) });
  }

  // ── preview (what a participant would see, built from the current unsaved edits) ─────────────────

  readonly previewOpen = signal(false);
  readonly previewLang = signal<'sr' | 'en'>('sr');
  /** Picks made inside the preview only, so the buttons feel real; never sent anywhere. */
  readonly previewPicks = signal<Record<number, number | number[]>>({});

  openPreview(): void {
    this.previewLang.set((this.translate.currentLang || 'sr') === 'en' ? 'en' : 'sr');
    this.previewPicks.set({});
    this.previewOpen.set(true);
  }

  closePreview(): void {
    this.previewOpen.set(false);
  }

  previewTitle(): string {
    return (this.previewLang() === 'sr' ? this.titleSr() : this.titleEn()).trim();
  }

  pText(item: { promptSr: string; promptEn: string }): string {
    return (this.previewLang() === 'sr' ? item.promptSr : item.promptEn).trim();
  }

  pOption(o: { labelSr: string; labelEn: string }): string {
    return (this.previewLang() === 'sr' ? o.labelSr : o.labelEn).trim();
  }

  pPoints(item: ItemVm): number[] {
    const n = Number.isInteger(item.scalePoints) && item.scalePoints! >= 2 && item.scalePoints! <= 10 ? item.scalePoints! : 5;
    return Array.from({ length: n }, (_, i) => i + 1);
  }

  pEnd(item: ItemVm, side: 'min' | 'max'): string {
    const l = item.scaleLabels;
    if (!l) return '';
    const v = this.previewLang() === 'sr' ? (side === 'min' ? l.minSr : l.maxSr) : (side === 'min' ? l.minEn : l.maxEn);
    return (v ?? '').trim();
  }

  pickOne(localKey: number, value: number): void {
    this.previewPicks.update((m) => ({ ...m, [localKey]: value }));
  }

  pickMulti(localKey: number, value: number): void {
    this.previewPicks.update((m) => {
      const cur = Array.isArray(m[localKey]) ? (m[localKey] as number[]) : [];
      return { ...m, [localKey]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
    });
  }

  /** True while an option marked "Polje za upis" is picked: the participant would then get a text field. */
  pOtherOpen(item: ItemVm): boolean {
    const p = this.previewPicks()[item.localKey];
    const picked = Array.isArray(p) ? p : p === undefined ? [] : [p];
    return picked.some((i) => item.options[i]?.isOther === true);
  }

  isPicked(localKey: number, value: number): boolean {
    const p = this.previewPicks()[localKey];
    return Array.isArray(p) ? p.includes(value) : p === value;
  }

  isChoice(item: ItemVm): boolean {
    return item.itemType === 'SINGLE_CHOICE' || item.itemType === 'MULTI_CHOICE';
  }

  // ── save ──────────────────────────────────────────────────────────────────────────────────────

  private validate(): string | null {
    if (!this.titleSr().trim() || !this.titleEn().trim()) return 'QUESTIONNAIRES.ERR_TITLE';
    if (!this.items().length) return 'QUESTIONNAIRES.ERR_NO_ITEMS';
    for (const it of this.items()) {
      if (!it.promptSr.trim() || !it.promptEn.trim()) return 'QUESTIONNAIRES.ERR_PROMPT';
      if (it.itemType === 'LIKERT' && !(Number.isInteger(it.scalePoints) && it.scalePoints! >= 2 && it.scalePoints! <= 10)) return 'QUESTIONNAIRES.ERR_SCALE';
      if (this.isChoice(it) && it.options.some((o) => !o.labelSr.trim() || !o.labelEn.trim())) return 'QUESTIONNAIRES.ERR_OPTION';
    }
    return null;
  }

  async submit(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    const id = this.editingId();
    if (this.saving() || researchId == null || id == null) return;
    this.saved.set(false);
    const problem = this.validate();
    if (problem) {
      this.errorKey.set(problem);
      return;
    }
    this.saving.set(true);
    this.errorKey.set(null);

    const body = {
      titleSr: this.titleSr().trim(),
      titleEn: this.titleEn().trim(),
      items: this.items().map((i): QuestionnaireItem => ({
        itemKey: i.itemKey,
        itemType: i.itemType,
        promptSr: i.promptSr.trim(),
        promptEn: i.promptEn.trim(),
        options: this.isChoice(i) ? i.options.map((o) => ({ key: o.key, labelSr: o.labelSr.trim(), labelEn: o.labelEn.trim(), isOther: o.isOther })) : [],
        scalePoints: i.itemType === 'LIKERT' ? i.scalePoints : null,
        scaleLabels: i.itemType === 'LIKERT' && i.scaleLabels ? i.scaleLabels : null,
        subscale: i.itemType === 'LIKERT' && i.subscale?.trim() ? i.subscale.trim() : null,
        reverseScored: i.itemType === 'LIKERT' && i.reverseScored,
        required: i.required,
      })),
    };

    if (id === 'new') {
      const r = await this.api.createQuestionnaire(researchId, body);
      this.saving.set(false);
      if (r.ok) {
        this.saved.set(true);
        await this.edit(r.id);
        this.saved.set(true);
      } else {
        this.errorKey.set('QUESTIONNAIRES.ERR_SAVE');
      }
      return;
    }

    const r = await this.api.updateQuestionnaire(researchId, id, body);
    this.saving.set(false);
    if (r.ok) {
      await this.edit(id);
      this.saved.set(true);
    } else if (r.error === 'ITEM_HAS_ANSWERS' || r.error === 'OPTION_HAS_ANSWERS' || r.error === 'SCALE_LOCKED') {
      this.errorKey.set('QUESTIONNAIRES.ERR_ANSWERED');
    } else {
      this.errorKey.set('QUESTIONNAIRES.ERR_SAVE');
    }
  }

  async duplicate(id: number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null) return;
    const r = await this.api.duplicateQuestionnaire(researchId, id);
    if (r.ok) await this.edit(r.id);
  }

  async remove(q: QuestionnaireSummary): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null) return;
    if (!confirm(this.translate.instant('QUESTIONNAIRES.CONFIRM_DELETE', { title: this.titleOf(q) }))) return;
    const r = await this.api.deleteQuestionnaire(researchId, q.id);
    if (r.ok) {
      await this.loadList(researchId);
    } else {
      this.listErrorKey.set(r.error === 'QUESTIONNAIRE_IN_USE' ? 'QUESTIONNAIRES.ERR_IN_USE' : r.error === 'QUESTIONNAIRE_HAS_ANSWERS' ? 'QUESTIONNAIRES.ERR_DELETE_ANSWERED' : 'QUESTIONNAIRES.ERR_SAVE');
    }
  }

  readonly listErrorKey = signal<string | null>(null);

  titleOf(q: { titleSr: string; titleEn: string }): string {
    return (this.translate.currentLang || 'sr') === 'sr' ? q.titleSr : q.titleEn;
  }
}
