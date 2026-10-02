import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { AdminApiService, ConsentSection } from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { HelpIconComponent } from '../shared/help-icon/help-icon.component';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';
import { ConsentDeliveryComponent } from './delivery/delivery.component';

/** Phase C of platform-ification (2026-08-18): lets a researcher define their own research's
 *  Consent Form instead of everyone sharing one fixed, hardcoded text — predefined sections
 *  seeded from the original text, freely add/remove/reorder/edit per section, drag-to-reorder
 *  via @angular/cdk (same module the Calendar page already uses). The agreement checkbox is
 *  deliberately NOT part of the reorderable list — it's structurally fixed at the end of the
 *  form (consent validity depends on a clear, unmoveable final affirmation), only its text is
 *  editable, rendered as its own field below the section list. */
@Component({
  selector: 'app-consent-form',
  standalone: true,
  imports: [FormsModule, TranslateModule, DragDropModule, HelpIconComponent, LoadingSpinnerComponent, ConsentDeliveryComponent],
  templateUrl: './consent-form.component.html',
  styleUrl: './consent-form.component.scss',
})
export class ConsentFormComponent {
  private api = inject(AdminApiService);
  readonly scope = inject(ScopeService);

  /** Set by StudyBuilderComponent when embedding this page as a wizard step — the wizard owns
   *  its own step heading, so this page's own .page-header would otherwise duplicate it. */
  readonly hideHeader = input(false);

  readonly sections = signal<ConsentSection[]>([]);
  readonly checkboxTextSr = signal('');
  readonly checkboxTextEn = signal('');

  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal(false);
  readonly saved = signal(false);

  // 2026-09-08 follow-up: the page now opens in a read-only preview (mirroring how
  // consent-andrejkatin's own ConsentComponent actually renders this content) with an explicit
  // "Uredi" to reveal today's exact editing UI — "ne znam kako izgleda dok ne kliknem Sačuvaj i
  // odem u drugu aplikaciju" was the reported gap this closes.
  readonly mode = signal<'preview' | 'edit'>('preview');
  // Which of the research's OFFERED languages (Part C1) the preview is currently showing —
  // defaults to whichever is enabled, preferring SR when both are (matches this app's own
  // default UI language convention elsewhere).
  readonly previewLang = signal<'sr' | 'en'>('sr');
  readonly consentLanguageSr = signal(true);
  readonly consentLanguageEn = signal(true);

  readonly previewSections = computed(() =>
    this.sections().map((s) => ({
      title: (this.previewLang() === 'sr' ? s.titleSr : s.titleEn) || null,
      body: this.previewLang() === 'sr' ? s.bodySr : s.bodyEn,
    }))
  );
  readonly previewCheckboxText = computed(() => (this.previewLang() === 'sr' ? this.checkboxTextSr() : this.checkboxTextEn()));

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
    this.mode.set('preview');
    try {
      const [cfg, studyCfg] = await Promise.all([this.api.getConsentConfig(researchId), this.api.getStudyConfig(researchId)]);
      this.sections.set(cfg.sections);
      this.checkboxTextSr.set(cfg.checkboxTextSr);
      this.checkboxTextEn.set(cfg.checkboxTextEn);
      this.consentLanguageSr.set(studyCfg.consentLanguageSr);
      this.consentLanguageEn.set(studyCfg.consentLanguageEn);
      this.previewLang.set(studyCfg.consentLanguageSr ? 'sr' : 'en');
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  setPreviewLang(lang: 'sr' | 'en'): void {
    this.previewLang.set(lang);
  }

  edit(): void {
    this.mode.set('edit');
  }

  backToPreview(): void {
    this.mode.set('preview');
  }

  drop(event: CdkDragDrop<ConsentSection[]>): void {
    const arr = [...this.sections()];
    moveItemInArray(arr, event.previousIndex, event.currentIndex);
    this.sections.set(arr);
  }

  updateSection(index: number, field: keyof ConsentSection, value: string): void {
    const arr = [...this.sections()];
    arr[index] = { ...arr[index], [field]: value };
    this.sections.set(arr);
  }

  addSection(): void {
    this.sections.set([...this.sections(), { titleSr: '', titleEn: '', bodySr: '', bodyEn: '' }]);
  }

  removeSection(index: number): void {
    this.sections.set(this.sections().filter((_, i) => i !== index));
  }

  async submit(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (this.saving() || researchId == null) return;
    if (!this.sections().length) return;

    this.saving.set(true);
    this.saveError.set(false);
    this.saved.set(false);

    const result = await this.api
      .updateConsentConfig(researchId, {
        sections: this.sections().map((s) => ({
          titleSr: s.titleSr?.trim() || null,
          titleEn: s.titleEn?.trim() || null,
          bodySr: s.bodySr,
          bodyEn: s.bodyEn,
        })),
        checkboxTextSr: this.checkboxTextSr(),
        checkboxTextEn: this.checkboxTextEn(),
      })
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
