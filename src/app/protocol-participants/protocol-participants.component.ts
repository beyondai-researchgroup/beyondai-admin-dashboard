import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  AdminApiService,
  MailOutboxStats,
  ProtocolEngineResult,
  ProtocolMatrix,
  ProtocolMatrixParticipant,
  ProtocolMatrixStep,
  ProtocolProgressStatus,
  RandomizeResult,
} from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { StudyConfigStoreService } from '../services/study-config-store.service';
import { ParticipantCodesActionsComponent } from '../shared/participant-codes-actions/participant-codes-actions.component';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';
import { SelectComponent, SelectOption } from '../shared/select/select.component';

/**
 * Participants of a PROTOCOL research (2026-10): one row per participant, one column per protocol step,
 * showing how far each has got — and the researcher's "start" actions. The participant never sees any
 * of this; they only receive the email for their next step.
 */
@Component({
  selector: 'app-protocol-participants',
  standalone: true,
  imports: [TranslateModule, LoadingSpinnerComponent, SelectComponent, ParticipantCodesActionsComponent],
  templateUrl: './protocol-participants.component.html',
  styleUrl: './protocol-participants.component.scss',
})
export class ProtocolParticipantsComponent {
  private api = inject(AdminApiService);
  private router = inject(Router);
  private translate = inject(TranslateService);
  readonly scope = inject(ScopeService);
  private studyConfig = inject(StudyConfigStoreService);

  readonly matrix = signal<ProtocolMatrix | null>(null);
  /** The legend explains the work-state icons only when some Sheets task has them. */
  readonly hasSheetsStep = computed(() => (this.matrix()?.participants ?? []).some((p) => Object.values(p.statuses).some((c) => !!c.activity)));
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly busy = signal(false);
  /** Result of the last start action: translation key + optional detail. */
  readonly message = signal<{ key: string; detail?: string; tone: 'ok' | 'error' } | null>(null);

  readonly notStarted = computed(() => (this.matrix()?.participants ?? []).filter((p) => !p.started));

  // ── participant groups (study design) ──
  private readonly lang = signal(this.translate.currentLang || 'sr');
  readonly hasGroups = computed(() => (this.matrix()?.groups.length ?? 0) > 0);
  /** '' = everyone, 'none' = participants without a group, otherwise a group id. */
  readonly groupFilter = signal<string>('');
  readonly visibleParticipants = computed(() => {
    let ps = this.matrix()?.participants ?? [];
    const f = this.groupFilter();
    if (f === 'none') ps = ps.filter((p) => p.groupId == null);
    else if (f) ps = ps.filter((p) => String(p.groupId) === f);
    const t = this.taskFilter();
    if (t === 'none') ps = ps.filter((p) => p.taskId == null);
    else if (t) ps = ps.filter((p) => String(p.taskId) === t);
    return ps;
  });
  readonly withoutGroup = computed(() => (this.matrix()?.participants ?? []).filter((p) => p.groupId == null && !p.started));

  // ── study tasks (A / B ...): the second factor, drawn inside every group ──
  /** Two or more tasks are needed to split anybody. */
  readonly hasTasks = computed(() => (this.matrix()?.tasks?.length ?? 0) >= 2);
  /** '' = everyone, 'none' = participants without a task, otherwise a task id. */
  readonly taskFilter = signal<string>('');
  readonly withoutTask = computed(() => this.hasTasks() ? (this.matrix()?.participants ?? []).filter((p) => p.taskId == null && !p.started) : []);
  /** Participants that can be started right now: not started yet, in a group and with a task when the research has them. */
  readonly startable = computed(() => this.notStarted().filter((p) => (!this.hasGroups() || p.groupId != null) && (!this.hasTasks() || p.taskId != null) && !this.needsPr(p)));
  readonly canRandomize = computed(() => ((this.matrix()?.groups.length ?? 0) >= 2 && this.withoutGroup().length > 0) || (this.hasTasks() && this.withoutTask().length > 0));
  /** Participants that a previous random run placed and that have not started: they can be drawn again. */
  readonly redrawable = computed(() => (this.matrix()?.participants ?? []).filter((p) => !p.started && (p.groupAssignedBy === 'RANDOM' || p.taskAssignedBy === 'RANDOM')));
  readonly canRedraw = computed(() => this.redrawable().length > 0);
  /** True while a previewed draw is a "draw again" one (the confirmation must repeat it with reset). */
  private previewReset = false;

  readonly taskOptions = computed<SelectOption[]>(() => {
    this.lang();
    return [
      { value: '', label: this.translate.instant('PROTOCOL_PROGRESS.TASK_NONE') },
      ...(this.matrix()?.tasks ?? []).map((t) => ({ value: t.id, label: t.name })),
    ];
  });
  readonly taskFilterOptions = computed<SelectOption[]>(() => {
    this.lang();
    return [
      { value: '', label: this.translate.instant('PROTOCOL_PROGRESS.FILTER_ALL') },
      { value: 'none', label: this.translate.instant('PROTOCOL_PROGRESS.TASK_NONE') },
      ...(this.matrix()?.tasks ?? []).map((t) => ({ value: String(t.id), label: t.name })),
    ];
  });

  /** The researcher's view of the draw: how many participants are in every group x task cell (and without a group or task). */
  readonly assignmentTable = computed(() => {
    const m = this.matrix();
    if (!m || (!this.hasGroups() && !this.hasTasks())) return null;
    const tasks = this.hasTasks() ? m.tasks! : [];
    const rows = (this.hasGroups() ? m.groups : [{ id: 0, name: '' }]).map((g) => {
      const members = m.participants.filter((p) => (this.hasGroups() ? p.groupId === g.id : true));
      return {
        groupId: g.id,
        name: g.name,
        total: members.length,
        cells: tasks.map((t) => members.filter((p) => p.taskId === t.id).length),
        noTask: this.hasTasks() ? members.filter((p) => p.taskId == null).length : 0,
      };
    });
    const noGroup = this.hasGroups() ? m.participants.filter((p) => p.groupId == null).length : 0;
    return { tasks, rows, noGroup, anyNoTask: rows.some((r) => r.noTask > 0) };
  });

  readonly groupOptions = computed<SelectOption[]>(() => {
    this.lang();
    return [
      { value: '', label: this.translate.instant('PROTOCOL_PROGRESS.GROUP_NONE') },
      ...(this.matrix()?.groups ?? []).map((g) => ({ value: g.id, label: g.name })),
    ];
  });
  readonly filterOptions = computed<SelectOption[]>(() => {
    this.lang();
    return [
      { value: '', label: this.translate.instant('PROTOCOL_PROGRESS.FILTER_ALL') },
      { value: 'none', label: this.translate.instant('PROTOCOL_PROGRESS.GROUP_NONE') },
      ...(this.matrix()?.groups ?? []).map((g) => ({ value: String(g.id), label: g.name })),
    ];
  });

  // ── Code Review step: which PR each participant reviews ──
  readonly isCodeReview = computed(() => this.studyConfig.protocolTaskKind() === 'CODE_REVIEW');
  readonly prOptions = computed<SelectOption[]>(() => {
    this.lang();
    return [
      { value: '', label: this.translate.instant('PROTOCOL_PROGRESS.PR_NONE') },
      ...(this.matrix()?.prTasks ?? []).map((t) => ({ value: t.id, label: t.label })),
    ];
  });
  /** A participant cannot be started on a Code Review protocol until they have a PR to review. */
  needsPr(p: ProtocolMatrixParticipant): boolean {
    return this.isCodeReview() && p.prConfigId == null;
  }
  readonly withoutPr = computed(() => this.isCodeReview() ? (this.matrix()?.participants ?? []).filter((p) => p.prConfigId == null && !p.started) : []);

  async setPrTask(p: ProtocolMatrixParticipant, value: string | number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    const res = await this.api.setParticipantPrTask(researchId, p.participantId, value === '' ? null : Number(value));
    this.busy.set(false);
    if (!res.ok) this.message.set({ key: res.error === 'PR_LOCKED' ? 'PROTOCOL_PROGRESS.ERR_PR_LOCKED' : 'PROTOCOL_PROGRESS.ERR_GENERIC', tone: 'error' });
    await this.load(researchId);
  }

  // ── the experimental session (the participants' tables): "send to everybody who is ready" ──
  /** Experiment steps that at least one participant is ready for (earlier steps done) and has not been sent yet. */
  readonly sendableSteps = computed(() => {
    const m = this.matrix();
    if (!m) return [];
    const out: { step: ProtocolMatrixStep; count: number }[] = [];
    m.steps.forEach((step, i) => {
      if (step.stepType !== 'EXPERIMENT') return;
      const earlier = m.steps.slice(0, i);
      const count = m.participants.filter((p) => p.started
        && ['NOT_REACHED', 'PENDING', 'SCHEDULED'].includes(this.statusOf(p, step.id))
        && earlier.every((e) => ['COMPLETED', 'SKIPPED'].includes(this.statusOf(p, e.id)))).length;
      if (count > 0) out.push({ step, count });
    });
    return out;
  });

  async sendStepToAll(step: ProtocolMatrixStep): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    const r = await this.api.sendProtocolStepToAll(researchId, step.id);
    this.busy.set(false);
    if (!r) {
      this.message.set({ key: 'PROTOCOL_PROGRESS.ERR_GENERIC', tone: 'error' });
    } else if (r.failed.length) {
      this.message.set({
        key: 'PROTOCOL_PROGRESS.MSG_SEND_ALL_PARTIAL',
        detail: `${r.sent} (${r.failed.map((f) => f.participantId + ': ' + f.reason).join(', ')})`,
        tone: 'error',
      });
    } else {
      this.message.set({ key: 'PROTOCOL_PROGRESS.MSG_SEND_ALL_OK', detail: String(r.sent), tone: 'ok' });
    }
    await this.load(researchId);
  }

  // ── mail queue ──
  readonly outbox = signal<MailOutboxStats | null>(null);
  readonly outboxBusy = signal(false);

  private async loadOutbox(researchId: number): Promise<void> {
    try {
      this.outbox.set(await this.api.getMailOutbox(researchId));
    } catch {
      this.outbox.set(null);
    }
  }

  async drainNow(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.outboxBusy()) return;
    this.outboxBusy.set(true);
    const r = await this.api.drainMailOutbox(researchId);
    this.outboxBusy.set(false);
    if (r) this.message.set({ key: 'PROTOCOL_PROGRESS.MSG_MAIL_SENT', detail: String(r.sent), tone: 'ok' });
    else this.message.set({ key: 'PROTOCOL_PROGRESS.ERR_GENERIC', tone: 'error' });
    await this.load(researchId);
  }

  async retryFailed(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.outboxBusy()) return;
    this.outboxBusy.set(true);
    await this.api.retryFailedMail(researchId);
    this.outboxBusy.set(false);
    await this.drainNow();
  }

  /** The previewed random allocation waiting for the researcher's confirmation. */
  readonly randomPreview = signal<RandomizeResult | null>(null);
  readonly stats = computed(() => {
    const ps = this.matrix()?.participants ?? [];
    return {
      total: ps.length,
      started: ps.filter((p) => p.started).length,
      finished: ps.filter((p) => p.finished).length,
      noEmail: ps.filter((p) => !p.hasEmail).length,
    };
  });

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      if (id != null) this.load(id);
    });
  }

  /** How many participants there are and how many already have a code. */
  readonly codeCounts = computed(() => {
    const ps = this.matrix()?.participants ?? [];
    return { total: ps.length, withCode: ps.filter((p) => !!p.participantCode).length };
  });

  async reloadCodes(): Promise<void> {
    const id = this.scope.selectedResearchId();
    if (id != null) await this.load(id);
  }

  async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      this.matrix.set(await this.api.getProtocolMatrix(researchId));
      void this.loadOutbox(researchId);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  titleOf(step: ProtocolMatrixStep): string {
    return (this.translate.currentLang || 'sr') === 'en' ? step.titleEn : step.titleSr;
  }

  statusOf(p: ProtocolMatrixParticipant, stepId: number): ProtocolProgressStatus {
    return p.statuses[stepId]?.status ?? 'NOT_REACHED';
  }

  cellClass(p: ProtocolMatrixParticipant, stepId: number): string {
    const a = p.statuses[stepId]?.activity;
    return 'cell cell--' + this.statusOf(p, stepId) + (a ? ' cell--act-' + a : '');
  }

  /** The icon: a sent Sheets task shows whether the participant has started / is working. */
  cellIcon(p: ProtocolMatrixParticipant, stepId: number): string {
    const st = this.statusOf(p, stepId);
    const a = p.statuses[stepId]?.activity;
    if (st === 'SENT' && a === 'WORKING') return '✎';
    if (st === 'SENT' && a === 'STARTED') return '▸';
    return this.statusIcon(st);
  }

  cellTitle(p: ProtocolMatrixParticipant, stepId: number): string {
    const c = p.statuses[stepId];
    const base = this.translate.instant('PROTOCOL_PROGRESS.STATUS_' + (c?.status ?? 'NOT_REACHED'));
    const label = c?.activity ? base + ' - ' + this.translate.instant('PROTOCOL_PROGRESS.ACTIVITY_' + c.activity) : base;
    const when = c?.completedAt ?? c?.scheduledFor ?? c?.sentAt;
    const started = c?.startedAt ? ` · ${this.translate.instant('PROTOCOL_PROGRESS.STARTED_AT')} ${new Date(c.startedAt).toLocaleString()}` : '';
    return (when ? `${label} · ${new Date(when).toLocaleString()}` : label) + started;
  }

  statusIcon(status: ProtocolProgressStatus): string {
    switch (status) {
      case 'COMPLETED': return '✓';
      case 'SENT': return '●';
      case 'SCHEDULED': return '◷';
      case 'SKIPPED': return '↷';
      case 'PENDING': return '…';
      default: return '–';
    }
  }

  open(p: ProtocolMatrixParticipant): void {
    this.router.navigate(['/protocol-participants', p.participantId]);
  }

  private show(result: ProtocolEngineResult): void {
    if (result.ok) {
      this.message.set({ key: 'PROTOCOL_PROGRESS.MSG_STARTED', tone: 'ok' });
      return;
    }
    const known = ['NO_EMAIL', 'EMAIL_FAILED', 'EMPTY_PROTOCOL', 'NOT_PROTOCOL', 'GROUP_REQUIRED', 'TASK_REQUIRED', 'NO_TEMPLATE', 'NO_TASK_ASSIGNED', 'NO_FORM_URL', 'NO_WORKBOOK', 'TASK_KIND_NOT_AVAILABLE', 'NO_PR_ASSIGNED', 'NO_MODE', 'NO_INTRO_PR'];
    this.message.set({
      key: known.includes(result.reason ?? '') ? 'PROTOCOL_PROGRESS.ERR_' + result.reason : 'PROTOCOL_PROGRESS.ERR_GENERIC',
      tone: 'error',
    });
  }

  async start(p: ProtocolMatrixParticipant, event: Event): Promise<void> {
    event.stopPropagation();
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    this.show(await this.api.startProtocolParticipant(researchId, p.participantId));
    this.busy.set(false);
    await this.load(researchId);
  }

  async setGroup(p: ProtocolMatrixParticipant, value: string | number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    const res = await this.api.setParticipantGroup(researchId, p.participantId, value === '' ? null : Number(value));
    this.busy.set(false);
    if (!res.ok) {
      this.message.set({ key: res.error === 'GROUP_LOCKED' ? 'PROTOCOL_PROGRESS.ERR_GROUP_LOCKED' : 'PROTOCOL_PROGRESS.ERR_GENERIC', tone: 'error' });
    }
    await this.load(researchId);
  }

  async setTask(p: ProtocolMatrixParticipant, value: string | number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    const res = await this.api.setParticipantTask(researchId, p.participantId, value === '' ? null : Number(value));
    this.busy.set(false);
    if (!res.ok) {
      this.message.set({ key: res.error === 'TASK_LOCKED' ? 'PROTOCOL_PROGRESS.ERR_TASK_LOCKED' : 'PROTOCOL_PROGRESS.ERR_GENERIC', tone: 'error' });
    }
    await this.load(researchId);
  }

  /** Step 1 of the random assignment: compute it (nothing is written) and show it for confirmation. */
  async previewRandom(reset = false): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    this.previewReset = reset;
    const res = await this.api.randomizeGroups(researchId, { preview: true, reset });
    this.busy.set(false);
    if ('error' in res) {
      this.message.set({ key: 'PROTOCOL_PROGRESS.ERR_GENERIC', tone: 'error' });
      return;
    }
    this.randomPreview.set(res);
  }

  /** Step 2: write exactly the previewed allocation (same seed). */
  async confirmRandom(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    const preview = this.randomPreview();
    if (researchId == null || !preview || this.busy()) return;
    this.busy.set(true);
    const res = await this.api.randomizeGroups(researchId, { preview: false, seed: preview.seed, reset: this.previewReset });
    this.busy.set(false);
    this.randomPreview.set(null);
    if ('error' in res) {
      this.message.set({ key: 'PROTOCOL_PROGRESS.ERR_GENERIC', tone: 'error' });
    } else {
      this.message.set({ key: 'PROTOCOL_PROGRESS.MSG_RANDOM_OK', detail: String(res.assignments.length), tone: 'ok' });
    }
    await this.load(researchId);
  }

  cancelRandom(): void {
    this.randomPreview.set(null);
  }

  async startAll(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    const r = await this.api.startProtocolAll(researchId);
    this.busy.set(false);
    if (!r) {
      this.message.set({ key: 'PROTOCOL_PROGRESS.ERR_GENERIC', tone: 'error' });
    } else if (r.failed.length) {
      this.message.set({
        key: 'PROTOCOL_PROGRESS.MSG_START_ALL_PARTIAL',
        detail: `${r.started} / ${r.started + r.failed.length} (${r.failed.map((f) => f.participantId + ': ' + (f.reason ?? '?')).join(', ')})`,
        tone: 'error',
      });
    } else {
      this.message.set({ key: 'PROTOCOL_PROGRESS.MSG_START_ALL_OK', detail: String(r.started), tone: 'ok' });
    }
    await this.load(researchId);
  }
}
