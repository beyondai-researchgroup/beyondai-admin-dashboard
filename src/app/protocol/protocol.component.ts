import { Component, HostListener, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import {
  AdminApiService,
  ProtocolDelivery,
  ProtocolStep,
  ProtocolStepInput,
  ProtocolStepType,
  ProtocolTaskKind,
  QuestionnaireSummary,
  ResearchGroupData,
  ReviewMode,
} from '../services/admin-api.service';
import { AuthService } from '../services/auth.service';
import { ScopeService } from '../services/scope.service';
import { StudyConfigStoreService } from '../services/study-config-store.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';
import { SelectComponent, SelectOption } from '../shared/select/select.component';

/** One step as edited on screen: the saved fields plus a local key for @for tracking. */
interface StepVm extends ProtocolStepInput {
  /** Participants with progress on this step (0 for a not-yet-saved step). */
  participantsStarted: number;
  localKey: number;
}

/** Each of these has one result row per participant, so a protocol may contain it only once. */
const SINGLETON_TYPES: ProtocolStepType[] = ['CONSENT', 'DEMOGRAPHIC', 'REI40', 'BIGFIVE', 'NASA_TLX', 'EXPERIMENT'];
const ALL_TYPES: ProtocolStepType[] = [
  'CONSENT', 'DEMOGRAPHIC', 'QUESTIONNAIRE', 'REI40', 'BIGFIVE', 'NASA_TLX', 'EXPERIMENT', 'EXTERNAL_LINK', 'MESSAGE', 'MANUAL',
];

/** Task kinds an experiment step can wrap. SHEETS and CODE_REVIEW are for the platform owner's own researches only.
 *  Mirrors server/protocol/routes.mjs. */
const TASK_KINDS: ProtocolTaskKind[] = ['GENERIC_TASK', 'GOOGLE_FORM', 'SHEETS', 'CODE_REVIEW', 'OTHER'];
const SUPERADMIN_TASK_KINDS: ProtocolTaskKind[] = ['SHEETS', 'CODE_REVIEW'];
const REVIEW_MODES: ReviewMode[] = ['AI', 'REPORT', 'HYBRID'];

/** Pause after the last edit before it is saved. */
const AUTOSAVE_DELAY_MS = 800;

// Default internal step names (the researcher can rename them); fixed per language, not tied to the UI language.
const DEFAULT_TITLE_SR: Record<ProtocolStepType, string> = {
  CONSENT: 'Informisani pristanak',
  DEMOGRAPHIC: 'Demografski upitnik',
  QUESTIONNAIRE: 'Upitnik',
  REI40: 'REI-40',
  BIGFIVE: 'Big Five',
  NASA_TLX: 'NASA-TLX',
  EXTERNAL_LINK: 'Spoljni link',
  MESSAGE: 'Poruka',
  MANUAL: 'Korak uživo',
  EXPERIMENT: 'Eksperimentalna sesija',
};
const DEFAULT_TITLE_EN: Record<ProtocolStepType, string> = {
  CONSENT: 'Informed consent',
  DEMOGRAPHIC: 'Demographic questionnaire',
  QUESTIONNAIRE: 'Questionnaire',
  REI40: 'REI-40',
  BIGFIVE: 'Big Five',
  NASA_TLX: 'NASA-TLX',
  EXTERNAL_LINK: 'External link',
  MESSAGE: 'Message',
  MANUAL: 'In-person step',
  EXPERIMENT: 'Experimental session',
};

/**
 * Research protocol editor (2026-10): the researcher defines, per research, the ordered list of
 * steps a participant goes through. The participant never sees this list — they only receive the
 * next step (a link by email, or a lab visit). Only reachable for researches created in
 * "own protocol" mode (the nav entry only exists for them; the API also refuses a CLASSIC research).
 *
 * Steps that participants already have progress on are locked against removal/retyping, and the
 * order up to the last such step is frozen — enforced by the server, mirrored here so the UI never
 * offers an action it would refuse.
 */
@Component({
  selector: 'app-protocol',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslateModule, DragDropModule, LoadingSpinnerComponent, SelectComponent],
  templateUrl: './protocol.component.html',
  styleUrl: './protocol.component.scss',
})
export class ProtocolComponent implements OnDestroy {
  /** The study wizard embeds this editor under its own step heading, so it hides the page header. */
  readonly hideHeader = input(false);

  private api = inject(AdminApiService);
  private translate = inject(TranslateService);
  private studyConfigStore = inject(StudyConfigStoreService);
  readonly scope = inject(ScopeService);
  private auth = inject(AuthService);
  private readonly lang = signal(this.translate.currentLang || 'sr');
  private readonly isSuperAdmin = computed(() => this.auth.researcher()?.isSuperAdmin === true);

  readonly steps = signal<StepVm[]>([]);
  readonly questionnaires = signal<QuestionnaireSummary[]>([]);
  /** The research's participant groups, for the Code Review per-group review mode. */
  readonly groups = signal<ResearchGroupData[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly notProtocol = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);
  /** Translation key of the validation / server error currently shown (null = none). */
  readonly errorKey = signal<string | null>(null);
  readonly errorDetail = signal<string>('');
  readonly orderHint = signal(false);
  /** Validation problem that stops the latest edit from being saved yet (translation key), null = nothing waiting. */
  readonly incompleteKey = signal<string | null>(null);

  /** Type chosen in the "add step" picker. */
  readonly newType = signal<ProtocolStepType | null>(null);

  private nextKey = 1;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while there are edits the server has not accepted yet. */
  private dirty = false;

  /** Steps [0, frozenCount) have participant progress at or after them: their order is fixed. */
  readonly frozenCount = computed(() => {
    const list = this.steps();
    let last = -1;
    list.forEach((s, i) => { if (s.participantsStarted > 0) last = i; });
    return last + 1;
  });

  readonly availableTypes = computed(() => {
    const used = new Set(this.steps().map((s) => s.stepType));
    return ALL_TYPES.filter((t) => !SINGLETON_TYPES.includes(t) || !used.has(t));
  });

  readonly typeOptions = computed<SelectOption[]>(() => {
    this.lang();
    return this.availableTypes().map((t) => ({ value: t, label: this.translate.instant('PROTOCOL.TYPE_' + t) }));
  });

  /** Kinds this researcher may newly pick: a restricted kind is only offered to a superadmin (or kept if the step already has it). */
  taskKindOptions(step: StepVm): SelectOption[] {
    this.lang();
    return TASK_KINDS
      .filter((k) => !SUPERADMIN_TASK_KINDS.includes(k) || this.isSuperAdmin() || step.config.taskKind === k)
      .map((k) => ({ value: k, label: this.translate.instant('PROTOCOL.TASK_KIND.' + k) }));
  }

  readonly reviewModeOptions = computed<SelectOption[]>(() => {
    this.lang();
    return REVIEW_MODES.map((m) => ({ value: m, label: this.translate.instant('PROTOCOL.REVIEW_MODE.' + m) }));
  });

  /** Per-group review mode choices: "same as the default" plus every mode. */
  readonly groupModeOptions = computed<SelectOption[]>(() => {
    this.lang();
    return [{ value: '', label: this.translate.instant('PROTOCOL.REVIEW_MODE_DEFAULT') }, ...this.reviewModeOptions()];
  });

  groupMode(step: StepVm, groupId: number | undefined): string {
    return step.config.modeByGroup?.find((m) => m.groupId === groupId)?.mode ?? '';
  }

  setReviewConfig(index: number, patch: Partial<StepVm['config']>): void {
    const arr = [...this.steps()];
    arr[index] = { ...arr[index], config: { ...arr[index].config, ...patch } };
    this.steps.set(arr);
    this.markDirty();
  }

  setGroupMode(index: number, groupId: number | undefined, value: string | number): void {
    if (groupId == null) return;
    const rest = (this.steps()[index].config.modeByGroup ?? []).filter((m) => m.groupId !== groupId);
    this.setReviewConfig(index, { modeByGroup: value === '' ? rest : [...rest, { groupId, mode: String(value) as ReviewMode }] });
  }

  onTaskKindChange(index: number, value: string | number): void {
    const kind = String(value) as ProtocolTaskKind;
    const arr = [...this.steps()];
    // A kind switch starts that kind's own settings from scratch (Code Review needs a default mode and an intro choice).
    arr[index] = {
      ...arr[index],
      config: kind === 'CODE_REVIEW' ? { taskKind: kind, defaultMode: 'AI', modeByGroup: [], includeIntro: false } : { taskKind: kind },
    };
    this.steps.set(arr);
    this.markDirty();
  }

  /** Where the researcher configures the chosen task (in this dashboard), or null. */
  taskSetupLink(step: StepVm): string | null {
    const kind = step.config.taskKind;
    if (kind === 'GENERIC_TASK' || kind === 'GOOGLE_FORM') return '/task-config';
    if (kind === 'SHEETS') return '/sheets';
    if (kind === 'CODE_REVIEW') return '/task-config';
    return null;
  }

  readonly deliveryOptions = computed<SelectOption[]>(() => {
    this.lang();
    return (['AUTO', 'AFTER_DELAY', 'MANUAL'] as ProtocolDelivery[]).map((d) => ({
      value: d,
      label: this.translate.instant('PROTOCOL.DELIVERY_' + d),
    }));
  });

  readonly questionnaireOptions = computed<SelectOption[]>(() => {
    this.lang();
    const sr = (this.translate.currentLang || 'sr') === 'sr';
    return this.questionnaires().map((q) => ({ value: q.id, label: sr ? q.titleSr : q.titleEn }));
  });

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      if (id != null) this.load(id);
    });
  }

  private toVm(s: ProtocolStep): StepVm {
    return {
      id: s.id,
      stepType: s.stepType,
      titleSr: s.titleSr,
      titleEn: s.titleEn,
      questionnaireId: s.questionnaireId,
      config: { ...s.config },
      delivery: s.delivery,
      delayDays: s.delayDays,
      emailMessageSr: s.emailMessageSr,
      emailMessageEn: s.emailMessageEn,
      participantsStarted: s.participantsStarted,
      localKey: this.nextKey++,
    };
  }

  private async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    this.notProtocol.set(false);
    this.cancelPendingSave();
    this.saved.set(false);
    this.errorKey.set(null);
    this.incompleteKey.set(null);
    try {
      const [protocol, qs, design] = await Promise.all([
        this.api.getProtocol(researchId),
        this.api.getQuestionnaires(researchId),
        this.api.getResearchDesign(researchId).catch(() => null),
      ]);
      this.steps.set(protocol.steps.map((s) => this.toVm(s)));
      this.questionnaires.set(qs.questionnaires);
      this.groups.set(design?.groups ?? []);
    } catch (err: any) {
      if (err?.error?.error === 'NOT_PROTOCOL') this.notProtocol.set(true);
      else this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  isLocked(step: StepVm): boolean {
    return step.participantsStarted > 0;
  }

  drop(event: CdkDragDrop<StepVm[]>): void {
    const from = event.previousIndex;
    const to = event.currentIndex;
    if (from === to) return;
    // Frozen head: a started step can't move, and nothing may be dropped in front of/into it.
    if (from < this.frozenCount() || to < this.frozenCount()) {
      this.orderHint.set(true);
      return;
    }
    this.orderHint.set(false);
    const arr = [...this.steps()];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    this.steps.set(arr);
    this.markDirty();
  }

  addStep(): void {
    const type = this.newType();
    if (!type) return;
    const isManual = type === 'MANUAL';
    const step: StepVm = {
      stepType: type,
      titleSr: DEFAULT_TITLE_SR[type],
      titleEn: DEFAULT_TITLE_EN[type],
      questionnaireId: null,
      config: type === 'EXTERNAL_LINK' ? { url: '' } : (type === 'MESSAGE' || type === 'MANUAL' ? { bodySr: '', bodyEn: '' } : (type === 'EXPERIMENT' ? { taskKind: 'GENERIC_TASK' } : {})),
      delivery: isManual ? 'MANUAL' : 'AUTO',
      delayDays: null,
      emailMessageSr: null,
      emailMessageEn: null,
      participantsStarted: 0,
      localKey: this.nextKey++,
    };
    this.steps.set([...this.steps(), step]);
    this.newType.set(null);
    this.markDirty();
  }

  removeStep(index: number): void {
    if (this.isLocked(this.steps()[index])) return;
    this.steps.set(this.steps().filter((_, i) => i !== index));
    this.markDirty();
  }

  patch(index: number, changes: Partial<StepVm>): void {
    const arr = [...this.steps()];
    arr[index] = { ...arr[index], ...changes };
    this.steps.set(arr);
    this.markDirty();
  }

  /** A questionnaire placed right after the Sheets task and delivered automatically can open on the hand-in page. */
  followsSheets(index: number): boolean {
    const arr = this.steps();
    const prev = arr[index - 1];
    return !!prev && prev.stepType === 'EXPERIMENT' && prev.config.taskKind === 'SHEETS' && arr[index]?.delivery === 'AUTO';
  }

  setOpenImmediately(index: number, checked: boolean): void {
    const arr = [...this.steps()];
    arr[index] = { ...arr[index], config: { ...arr[index].config, openImmediately: checked } };
    this.steps.set(arr);
    this.markDirty();
  }

  patchConfig(index: number, key: 'url' | 'bodySr' | 'bodyEn', value: string): void {
    const arr = [...this.steps()];
    arr[index] = { ...arr[index], config: { ...arr[index].config, [key]: value } };
    this.steps.set(arr);
    this.markDirty();
  }

  onDeliveryChange(index: number, value: string | number): void {
    const delivery = String(value) as ProtocolDelivery;
    this.patch(index, { delivery, delayDays: delivery === 'AFTER_DELAY' ? (this.steps()[index].delayDays ?? 1) : null });
  }

  onQuestionnaireChange(index: number, value: string | number): void {
    const id = Number(value);
    const q = this.questionnaires().find((x) => x.id === id);
    const step = this.steps()[index];
    this.patch(index, {
      questionnaireId: id,
      // Pre-fill the internal step name from the questionnaire while the researcher hasn't typed one.
      titleSr: q && (!step.titleSr || step.titleSr === DEFAULT_TITLE_SR.QUESTIONNAIRE) ? q.titleSr : step.titleSr,
      titleEn: q && (!step.titleEn || step.titleEn === DEFAULT_TITLE_EN.QUESTIONNAIRE) ? q.titleEn : step.titleEn,
    });
  }

  hasEmail(step: StepVm): boolean {
    return step.stepType !== 'MANUAL';
  }

  usesBuiltInPage(step: StepVm): string | null {
    if (step.stepType === 'CONSENT') return '/consent-form';
    if (step.stepType === 'DEMOGRAPHIC') return '/demographic-questions';
    return null;
  }

  /** First problem found, as a translation key, or null. */
  private validate(): string | null {
    for (const s of this.steps()) {
      if (!s.titleSr.trim() || !s.titleEn.trim()) return 'PROTOCOL.ERR_TITLE';
      if (s.stepType === 'QUESTIONNAIRE' && !s.questionnaireId) return 'PROTOCOL.ERR_QUESTIONNAIRE';
      if (s.stepType === 'EXTERNAL_LINK' && !/^https?:\/\/\S+$/i.test((s.config.url ?? '').trim())) return 'PROTOCOL.ERR_URL';
      if (s.stepType === 'MESSAGE' && (!(s.config.bodySr ?? '').trim() || !(s.config.bodyEn ?? '').trim())) return 'PROTOCOL.ERR_MESSAGE';
      if (s.stepType === 'EXPERIMENT' && !(s.config.taskKind && TASK_KINDS.includes(s.config.taskKind))) return 'PROTOCOL.ERR_TASK_KIND';
      if (s.stepType === 'EXPERIMENT' && s.config.taskKind === 'OTHER' && (!(s.emailMessageSr ?? '').trim() || !(s.emailMessageEn ?? '').trim())) return 'PROTOCOL.ERR_OTHER_DESCRIPTION';
      if (s.stepType === 'EXPERIMENT' && s.config.taskKind === 'CODE_REVIEW' && !(s.config.defaultMode && REVIEW_MODES.includes(s.config.defaultMode))) return 'PROTOCOL.ERR_REVIEW_MODE';
      if (s.delivery === 'AFTER_DELAY' && !(Number.isInteger(s.delayDays) && s.delayDays! >= 0 && s.delayDays! <= 365)) return 'PROTOCOL.ERR_DELAY';
    }
    return null;
  }

  // ---- Autosave ----------------------------------------------------------------------------------------------------
  // There is no save button: every edit is sent after a short pause. An edit that is not valid yet (a link step
  // without an address, an empty message ...) just waits and the editor says what is missing; the next edit retries.

  private markDirty(): void {
    this.saved.set(false);
    this.dirty = true;
    this.errorKey.set(null);
    this.scheduleSave(AUTOSAVE_DELAY_MS);
  }

  private scheduleSave(delay: number): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.autosave(); }, delay);
  }

  private cancelPendingSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = false;
  }

  /** Saves right away if something is waiting; the study wizard calls this before it reads the protocol back. */
  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    while (this.saving()) await new Promise((r) => setTimeout(r, 50));
    await this.autosave();
  }

  /** Closing or reloading the tab inside the pause (or while a save runs) would lose the edit, so the browser asks first. */
  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.dirty || this.saving()) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  ngOnDestroy(): void {
    // Leaving the page inside the pause must not lose the last edit.
    if (this.dirty && !this.saving()) {
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      void this.autosave();
    } else if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
  }

  private async autosave(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || !this.dirty || this.saving()) return;
    const problem = this.validate();
    this.incompleteKey.set(problem);
    if (problem) return; // stays dirty: the next edit tries again

    this.dirty = false;
    this.saving.set(true);
    this.errorKey.set(null);

    const snapshot = this.steps();
    const payload: ProtocolStepInput[] = snapshot.map((s, idx) => ({
      id: s.id,
      stepType: s.stepType,
      titleSr: s.titleSr.trim(),
      titleEn: s.titleEn.trim(),
      questionnaireId: s.stepType === 'QUESTIONNAIRE' ? s.questionnaireId : null,
      // The "open immediately" switch only counts while the step still follows the Sheets task (moving it away drops the switch).
      config: s.stepType === 'QUESTIONNAIRE' && s.config.openImmediately && !this.followsSheets(idx) ? {} : s.config,
      delivery: s.delivery,
      delayDays: s.delivery === 'AFTER_DELAY' ? s.delayDays : null,
      emailMessageSr: s.emailMessageSr?.trim() || null,
      emailMessageEn: s.emailMessageEn?.trim() || null,
    }));
    const result = await this.api.updateProtocol(researchId, payload);

    if (result.ok) {
      await this.adoptSavedIds(researchId, snapshot);
      // The Results/Consent/Demographic nav entries follow the protocol's steps.
      await this.studyConfigStore.refresh(researchId);
      this.saving.set(false);
      if (this.dirty) this.scheduleSave(0);
      else this.saved.set(true);
      return;
    }

    this.saving.set(false);
    this.dirty = true; // not accepted: keep it for the next attempt
    this.errorDetail.set('');
    if (result.error === 'PROTOCOL_LOCKED') {
      this.errorKey.set(result.reason === 'ORDER_FROZEN' ? 'PROTOCOL.ERR_ORDER_FROZEN' : 'PROTOCOL.ERR_STEP_HAS_PROGRESS');
    } else if (result.error === 'SUPERADMIN_ONLY_TASK_KIND') {
      this.errorKey.set('PROTOCOL.ERR_SUPERADMIN_ONLY');
    } else if (result.error === 'OPEN_IMMEDIATELY_INVALID') {
      this.errorKey.set('PROTOCOL.ERR_OPEN_IMMEDIATELY');
    } else if (result.error === 'DUPLICATE_STEP_TYPE') {
      this.errorKey.set('PROTOCOL.ERR_DUPLICATE');
      this.errorDetail.set(result.stepType ? this.translate.instant('PROTOCOL.TYPE_' + result.stepType) : '');
    } else {
      this.errorKey.set('PROTOCOL.ERR_SAVE');
    }
  }

  /**
   * After a save the server owns the ids of new steps. Copy them (and the participant counts) onto the steps on
   * screen WITHOUT replacing the rest — the researcher may already be typing the next change.
   */
  private async adoptSavedIds(researchId: number, saved: StepVm[]): Promise<void> {
    try {
      const protocol = await this.api.getProtocol(researchId);
      if (this.scope.selectedResearchId() !== researchId || protocol.steps.length !== saved.length) return;
      const byKey = new Map(saved.map((s, i) => [s.localKey, protocol.steps[i]]));
      this.steps.set(this.steps().map((s) => {
        const server = byKey.get(s.localKey);
        return server ? { ...s, id: server.id, participantsStarted: server.participantsStarted } : s;
      }));
    } catch {
      // The save itself worked; ids are picked up on the next load. A second save before that would duplicate
      // a new step, so reload the whole list instead of leaving id-less steps behind.
      await this.load(researchId);
    }
  }
}
