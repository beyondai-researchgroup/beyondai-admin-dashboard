import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AdminApiService, ProtocolEngineResult, ProtocolTimeline, ProtocolTimelineStep } from '../services/admin-api.service';
import { ScopeService } from '../services/scope.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

/**
 * One participant's progress through the protocol (2026-10): every step with its status, and the
 * researcher's actions — start the protocol, send a step now / resend its link, copy the live link,
 * mark an in-person step done, skip a step. The participant never sees this page or the protocol.
 */
@Component({
  selector: 'app-protocol-participant-detail',
  standalone: true,
  imports: [RouterLink, TranslateModule, LoadingSpinnerComponent],
  templateUrl: './protocol-participant-detail.component.html',
  styleUrl: './protocol-participant-detail.component.scss',
})
export class ProtocolParticipantDetailComponent {
  private api = inject(AdminApiService);
  private route = inject(ActivatedRoute);
  private translate = inject(TranslateService);
  readonly scope = inject(ScopeService);

  readonly participantId = this.route.snapshot.paramMap.get('id') ?? '';
  readonly timeline = signal<ProtocolTimeline | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly busy = signal(false);
  readonly message = signal<{ key: string; tone: 'ok' | 'error' } | null>(null);
  readonly copiedStepId = signal<number | null>(null);

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      if (id != null) this.load(id);
    });
  }

  async load(researchId: number): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      this.timeline.set(await this.api.getProtocolTimeline(researchId, this.participantId));
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  titleOf(step: ProtocolTimelineStep): string {
    return (this.translate.currentLang || 'sr') === 'en' ? step.titleEn : step.titleSr;
  }

  fmt(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString() : '';
  }

  /** The first step that is not completed or skipped: the one the participant is on. */
  currentStepId(): number | null {
    const t = this.timeline();
    return t?.steps.find((s) => s.status !== 'COMPLETED' && s.status !== 'SKIPPED')?.id ?? null;
  }

  isManual(step: ProtocolTimelineStep): boolean {
    return step.stepType === 'MANUAL';
  }

  canSendNow(step: ProtocolTimelineStep): boolean {
    return step.id === this.currentStepId() && (step.status === 'NOT_REACHED' || step.status === 'PENDING' || step.status === 'SCHEDULED') && !this.isManual(step);
  }

  canResend(step: ProtocolTimelineStep): boolean {
    return step.status === 'SENT' && !this.isManual(step) && step.stepType !== 'MESSAGE';
  }

  canMarkDone(step: ProtocolTimelineStep): boolean {
    return step.id === this.currentStepId() && (step.status === 'SENT' || step.status === 'PENDING' || step.status === 'SCHEDULED' || step.status === 'NOT_REACHED');
  }

  canSkip(step: ProtocolTimelineStep): boolean {
    return step.id === this.currentStepId();
  }

  private report(result: ProtocolEngineResult): void {
    if (result.ok) {
      this.message.set({ key: result.reason === 'WAITING_FOR_RESEARCHER' ? 'PROTOCOL_PROGRESS.MSG_WAITING' : 'PROTOCOL_PROGRESS.MSG_DONE', tone: 'ok' });
      return;
    }
    const known = ['NO_EMAIL', 'EMAIL_FAILED', 'EMPTY_PROTOCOL', 'NOT_PROTOCOL', 'NOT_RESENDABLE', 'NO_TASK_ASSIGNED', 'NO_FORM_URL', 'NO_WORKBOOK', 'NO_TEMPLATE', 'TASK_REQUIRED', 'TASK_KIND_NOT_AVAILABLE', 'GROUP_REQUIRED'];
    this.message.set({
      key: known.includes(result.reason ?? '') ? 'PROTOCOL_PROGRESS.ERR_' + result.reason : 'PROTOCOL_PROGRESS.ERR_GENERIC',
      tone: 'error',
    });
  }

  private async run(action: (researchId: number) => Promise<ProtocolEngineResult>): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    this.report(await action(researchId));
    this.busy.set(false);
    await this.load(researchId);
  }

  start(): Promise<void> {
    return this.run((rid) => this.api.startProtocolParticipant(rid, this.participantId));
  }

  send(step: ProtocolTimelineStep): Promise<void> {
    return this.run((rid) => this.api.sendProtocolStep(rid, this.participantId, step.id));
  }

  markDone(step: ProtocolTimelineStep): Promise<void> {
    return this.run((rid) => this.api.completeProtocolStep(rid, this.participantId, step.id));
  }

  skip(step: ProtocolTimelineStep): Promise<void> {
    if (!confirm(this.translate.instant('PROTOCOL_PROGRESS.CONFIRM_SKIP', { title: this.titleOf(step) }))) return Promise.resolve();
    return this.run((rid) => this.api.skipProtocolStep(rid, this.participantId, step.id));
  }

  async copyLink(step: ProtocolTimelineStep): Promise<void> {
    if (!step.linkUrl) return;
    try {
      await navigator.clipboard.writeText(step.linkUrl);
      this.copiedStepId.set(step.id);
      setTimeout(() => this.copiedStepId.set(null), 2000);
    } catch {
      /* clipboard unavailable — the link is also visible in the row */
    }
  }
}
