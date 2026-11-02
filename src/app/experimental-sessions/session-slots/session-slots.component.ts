import { Component, HostListener, computed, inject, input, signal } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';
import { SelectComponent, SelectOption } from '../../shared/select/select.component';
import {
  AdminApiService,
  ProtocolMatrix,
  SessionSlot,
  SessionSlotAudience,
  SessionSlotCreateInput,
  SessionSlotKind,
} from '../../services/admin-api.service';
import { PREDEFINED_TAGS, predefinedTagLabel, predefinedTagTone } from '../session-tags';

type Banner = { kind: 'ok' | 'warn'; key: string; params: Record<string, number> } | null;

/**
 * Termini (slots) of an experimental session in a PROTOCOL research. A slot has one time, a type (online with an
 * optional meeting link, or in person with a location) and an audience: one or more chosen participants, a whole
 * group, or every participant. The server resolves the audience when the slot is created; later additions are made
 * explicitly (add participants, "add new members").
 */
@Component({
  selector: 'app-session-slots',
  standalone: true,
  imports: [TranslateModule, FormsModule, SelectComponent, LoadingSpinnerComponent],
  templateUrl: './session-slots.component.html',
  styleUrl: './session-slots.component.scss',
})
export class SessionSlotsComponent {
  private api = inject(AdminApiService);
  private translate = inject(TranslateService);

  readonly experimentalSessionId = input.required<number>();
  readonly researchId = input.required<number>();

  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly slots = signal<SessionSlot[]>([]);
  readonly calendarConnected = signal(true);
  readonly matrix = signal<ProtocolMatrix | null>(null);
  readonly banner = signal<Banner>(null);

  // ── form (create, or edit when editingId is set) ──
  readonly formOpen = signal(false);
  readonly editingId = signal<number | null>(null);
  readonly saving = signal(false);
  readonly formError = signal<string | null>(null);
  readonly conflicts = signal<string[]>([]);
  readonly startTime = signal('10:00');
  readonly duration = signal(45);
  readonly kind = signal<SessionSlotKind>('ONLINE');
  readonly meetingUrl = signal('');
  readonly location = signal('');
  readonly audience = signal<SessionSlotAudience>('PARTICIPANT');
  readonly groupId = signal<number | null>(null);
  readonly pickedIds = signal<string[]>([]);
  readonly stepId = signal<number | null>(null);
  readonly formNotes = signal('');

  // per-slot drafts: notes, and the participant being added
  readonly noteDrafts = signal<Record<number, string>>({});
  readonly addPick = signal<Record<number, string | null>>({});
  readonly busySlot = signal<number | null>(null);

  readonly timeOptions: SelectOption[] = Array.from({ length: 14 }, (_, h) => h + 7).flatMap((h) =>
    [0, 15, 30, 45].map((m) => {
      const label = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      return { value: label, label };
    })
  );
  readonly durationOptions: SelectOption[] = [15, 30, 45, 60, 90, 120, 180].map((m) => ({ value: m, label: `${m} min` }));

  readonly participants = computed(() => this.matrix()?.participants ?? []);
  readonly groups = computed(() => this.matrix()?.groups ?? []);
  readonly hasGroups = computed(() => this.groups().length > 0);
  readonly groupOptions = computed<SelectOption[]>(() => this.groups().map((g) => ({ value: g.id, label: g.name })));
  readonly stepOptions = computed<SelectOption[]>(() => {
    const none: SelectOption = { value: '', label: this.translate.instant('SESSION_SLOTS.NO_STEP') };
    const lang = this.translate.currentLang;
    return [none, ...(this.matrix()?.steps ?? []).map((s) => ({ value: s.id, label: lang === 'en' ? s.titleEn : s.titleSr }))];
  });

  /** Who the form would invite right now (the server decides again on save). */
  readonly previewAttendees = computed(() => {
    const all = this.participants();
    if (this.audience() === 'ALL') return all;
    if (this.audience() === 'GROUP') return all.filter((p) => p.groupId === this.groupId());
    const picked = new Set(this.pickedIds());
    return all.filter((p) => picked.has(p.participantId));
  });
  readonly previewWithoutEmail = computed(() => this.previewAttendees().filter((p) => !p.hasEmail).length);

  readonly formValid = computed(() => {
    if (!this.startTime()) return false;
    if (this.kind() === 'IN_PERSON' && !this.location().trim()) return false;
    if (this.editingId() !== null) return true;
    if (this.audience() === 'GROUP' && this.groupId() === null) return false;
    // Group / everyone can be scheduled before anyone has been imported (they are added later); a hand-picked slot needs someone.
    return this.audience() !== 'PARTICIPANT' || this.previewAttendees().length > 0;
  });

  readonly tagOptions = computed<SelectOption[]>(() => {
    const lang = this.translate.currentLang;
    return [
      { value: '', label: this.translate.instant('SESSION_SLOTS.NO_TAG') },
      ...PREDEFINED_TAGS.map((t) => ({ value: t.id, label: lang === 'en' ? t.labelEn : t.labelSr })),
    ];
  });

  constructor() {
    queueMicrotask(() => this.load());
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const [slotRes, matrix] = await Promise.all([
        this.api.getSessionSlots(this.experimentalSessionId()),
        this.api.getProtocolMatrix(this.researchId()),
      ]);
      this.slots.set(slotRes.slots);
      this.calendarConnected.set(slotRes.calendarConnected);
      this.matrix.set(matrix);
      this.noteDrafts.set({});
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private async reloadSlots(): Promise<void> {
    const res = await this.api.getSessionSlots(this.experimentalSessionId());
    this.slots.set(res.slots);
    this.calendarConnected.set(res.calendarConnected);
    this.noteDrafts.set({});
  }

  // ── form ──
  openCreate(): void {
    this.editingId.set(null);
    this.startTime.set('10:00');
    this.duration.set(45);
    this.kind.set('ONLINE');
    this.meetingUrl.set('');
    this.location.set('');
    this.audience.set('PARTICIPANT');
    this.groupId.set(this.groups()[0]?.id ?? null);
    this.pickedIds.set([]);
    this.stepId.set(null);
    this.formNotes.set('');
    this.formError.set(null);
    this.conflicts.set([]);
    this.formOpen.set(true);
  }

  openEdit(s: SessionSlot): void {
    this.editingId.set(s.id);
    this.startTime.set(s.startTime);
    this.duration.set(s.durationMinutes);
    this.kind.set(s.kind);
    this.meetingUrl.set(s.meetingUrl ?? '');
    this.location.set(s.location ?? '');
    this.formNotes.set(s.notes ?? '');
    this.formError.set(null);
    this.conflicts.set([]);
    this.formOpen.set(true);
  }

  closeForm(): void {
    if (this.saving()) return;
    this.formOpen.set(false);
  }

  setAudience(a: SessionSlotAudience): void {
    this.audience.set(a);
    this.conflicts.set([]);
    this.formError.set(null);
  }

  togglePicked(id: string): void {
    this.pickedIds.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  }

  async save(skipConflicts = false): Promise<void> {
    if (this.saving() || !this.formValid()) return;
    this.saving.set(true);
    this.formError.set(null);
    const base = {
      startTime: this.startTime(),
      durationMinutes: this.duration(),
      kind: this.kind(),
      meetingUrl: this.kind() === 'ONLINE' ? this.meetingUrl().trim() || null : null,
      location: this.kind() === 'IN_PERSON' ? this.location().trim() : null,
      notes: this.formNotes().trim() || null,
    };
    try {
      const editing = this.editingId();
      if (editing !== null) {
        const res = await this.api.updateSessionSlot(editing, base);
        if (!res.ok) {
          this.formError.set(res.error);
          return;
        }
        this.formOpen.set(false);
        this.banner.set(null);
        await this.reloadSlots();
        return;
      }
      const body: SessionSlotCreateInput = {
        ...base,
        audienceType: this.audience(),
        groupId: this.audience() === 'GROUP' ? this.groupId() : null,
        participantIds: this.audience() === 'PARTICIPANT' ? this.pickedIds() : undefined,
        protocolStepId: this.stepId(),
        skipConflicts,
      };
      const res = await this.api.createSessionSlot(this.experimentalSessionId(), body);
      if (!res.ok) {
        this.conflicts.set(res.conflicts ?? []);
        this.formError.set(res.error);
        return;
      }
      this.formOpen.set(false);
      this.banner.set({
        kind: res.withoutEmail > 0 ? 'warn' : 'ok',
        key: 'SESSION_SLOTS.CREATED',
        params: { n: res.attendeeCount, m: res.withoutEmail, skipped: res.skipped },
      });
      await this.reloadSlots();
    } finally {
      this.saving.set(false);
    }
  }

  // ── a slot card ──
  audienceLabel(s: SessionSlot): string {
    if (s.audienceType === 'GROUP') {
      return this.translate.instant('SESSION_SLOTS.AUDIENCE_GROUP_LABEL', { name: s.groupName ?? '', n: s.attendees.length });
    }
    if (s.audienceType === 'ALL') return this.translate.instant('SESSION_SLOTS.AUDIENCE_ALL_LABEL', { n: s.attendees.length });
    return this.translate.instant('SESSION_SLOTS.AUDIENCE_PARTICIPANT_LABEL', { n: s.attendees.length });
  }

  stepLabel(s: SessionSlot): string | null {
    return (this.translate.currentLang === 'en' ? s.stepTitleEn : s.stepTitleSr) ?? null;
  }

  canSync(s: SessionSlot): boolean {
    return s.audienceType !== 'PARTICIPANT';
  }

  addableOptions(s: SessionSlot): SelectOption[] {
    const inSlot = new Set(s.attendees.map((a) => a.participantId));
    return this.participants()
      .filter((p) => !inSlot.has(p.participantId))
      .map((p) => ({ value: p.participantId, label: p.participantId }));
  }

  noteDraft(s: SessionSlot): string {
    return this.noteDrafts()[s.id] ?? s.notes ?? '';
  }

  setNoteDraft(s: SessionSlot, v: string): void {
    this.noteDrafts.update((d) => ({ ...d, [s.id]: v }));
  }

  setAddPick(s: SessionSlot, v: string | null): void {
    this.addPick.update((d) => ({ ...d, [s.id]: v }));
  }

  private async runOn<T>(s: SessionSlot, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.busySlot() !== null) return undefined;
    this.busySlot.set(s.id);
    try {
      return await fn();
    } finally {
      this.busySlot.set(null);
    }
  }

  async addPicked(s: SessionSlot): Promise<void> {
    const id = this.addPick()[s.id];
    if (!id) return;
    const res = await this.runOn(s, () => this.api.addSessionSlotAttendees(s.id, { participantIds: [id] }));
    if (res && !res.ok) {
      this.banner.set({
        kind: 'warn',
        key: res.error === 'ALREADY_SCHEDULED' ? 'SESSION_SLOTS.ERR_ALREADY_SCHEDULED_SHORT' : 'SESSION_SLOTS.ERR_GENERIC',
        params: {},
      });
      return;
    }
    this.setAddPick(s, null);
    await this.reloadSlots();
  }

  async syncMembers(s: SessionSlot): Promise<void> {
    const res = await this.runOn(s, () => this.api.addSessionSlotAttendees(s.id, { syncGroup: true, skipConflicts: true }));
    if (res && res.ok) {
      this.banner.set({ kind: 'ok', key: 'SESSION_SLOTS.SYNCED', params: { n: res.added } });
      await this.reloadSlots();
    } else if (res) {
      this.banner.set({ kind: 'warn', key: 'SESSION_SLOTS.ERR_GENERIC', params: {} });
    }
  }

  async removeAttendee(s: SessionSlot, guid: string): Promise<void> {
    await this.runOn(s, () => this.api.removeSessionSlotAttendee(s.id, guid));
    await this.reloadSlots();
  }

  tagValue(s: SessionSlot): string {
    return s.tags.length ? s.tags[0] : '';
  }

  tagLabel(id: string): string {
    return predefinedTagLabel(id, this.translate.currentLang);
  }

  tagTone(id: string): string {
    return predefinedTagTone(id) ?? 'neutral';
  }

  async saveNotes(s: SessionSlot, tag?: string): Promise<void> {
    const tags = tag === undefined ? s.tags : tag ? [tag] : [];
    await this.runOn(s, () => this.api.updateSessionSlotNotesTags(s.id, this.noteDraft(s).trim() || null, tags));
    await this.reloadSlots();
  }

  async remove(s: SessionSlot): Promise<void> {
    if (!confirm(this.translate.instant('SESSION_SLOTS.DELETE_CONFIRM'))) return;
    await this.runOn(s, () => this.api.deleteSessionSlot(s.id));
    this.banner.set(null);
    await this.reloadSlots();
  }

  errorKey(code: string | null): string {
    switch (code) {
      case 'INVALID_URL': return 'SESSION_SLOTS.ERR_URL';
      case 'LOCATION_REQUIRED': return 'SESSION_SLOTS.ERR_LOCATION';
      case 'NO_ATTENDEES': return 'SESSION_SLOTS.ERR_NO_ATTENDEES';
      case 'ALREADY_SCHEDULED': return 'SESSION_SLOTS.ERR_ALREADY_SCHEDULED';
      case 'INSUFFICIENT_ROLE': return 'SESSION_SLOTS.ERR_ROLE';
      default: return 'SESSION_SLOTS.ERR_GENERIC';
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeForm();
  }
}
