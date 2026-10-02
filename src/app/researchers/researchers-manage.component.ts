import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AcademicStatus, AdminApiService, ResearcherRole, ResearcherSummary } from '../services/admin-api.service';
import { ResearchesStoreService } from '../services/researches-store.service';
import { SelectComponent, SelectOption } from '../shared/select/select.component';
import { COUNTRIES } from '../data/countries';
import { HelpIconComponent } from '../shared/help-icon/help-icon.component';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

/** Superadmin-only (Phase B, 2026-08-18; reworked into a full profile system 2026-08-20):
 *  create/edit/delete researcher accounts and manage which research(es) each one is assigned
 *  to. Creating a brand-new account sends a magic-link invite email (no password field — see
 *  server/researchers/routes.mjs); "add an existing researcher to a research" is a separate,
 *  lighter-weight flow that just expands an existing account's researchIds, no new invite. */
@Component({
  selector: 'app-researchers-manage',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule, SelectComponent, HelpIconComponent, LoadingSpinnerComponent],
  templateUrl: './researchers-manage.component.html',
  styleUrl: './researchers-manage.component.scss',
})
export class ResearchersManageComponent {
  private fb = inject(FormBuilder);
  private api = inject(AdminApiService);
  private translate = inject(TranslateService);
  private readonly lang = signal(this.translate.currentLang || 'sr');
  readonly researchesStore = inject(ResearchesStoreService);

  readonly researchers = signal<ResearcherSummary[]>([]);
  readonly loading = signal(true);

  readonly editingId = signal<number | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly saved = signal(false);
  readonly inviteEmailFailed = signal(false);
  readonly deleteError = signal<string | null>(null);
  // 2026-09-08 — set after a successful updateResearcher() call: how many of the just-submitted
  // research ids were genuinely new and got a fresh invite email (not just an existing member's
  // role change, and not a still-pending invite left untouched).
  readonly newInvitesSent = signal(0);

  // "Novi istraživač" (full profile form, sends an invite email) vs "Postojeći istraživač" (pick
  // from the list, just expand their researchIds — no invite). Only relevant while not editing;
  // editing an existing row always uses the full form (below).
  readonly mode = signal<'new' | 'existing'>('new');

  readonly academicStatuses: AcademicStatus[] = ['PHD_STUDENT', 'MASTER', 'DOCTOR'];
  readonly academicStatusOptions = computed<SelectOption[]>(() => {
    this.lang();
    return [
      { value: '', label: this.translate.instant('RESEARCHERS.ACADEMIC_STATUS_NONE') },
      ...this.academicStatuses.map((s) => ({ value: s, label: this.translate.instant(`RESEARCHERS.ACADEMIC_STATUS_${s}`) })),
    ];
  });
  readonly countryOptions: SelectOption[] = [
    { value: '', label: '—' },
    ...COUNTRIES.map((c) => ({ value: c, label: c })),
  ];

  // Role granularity (Phase 6 of the modular-platform plan) — a role per checked research chip,
  // defaulting to OWNER (today's behavior, unchanged) the moment a chip is checked. Kept as a
  // separate map rather than folded into the form's researchIds control since app-select's
  // valueChange doesn't fit naturally inside a FormArray here.
  readonly researchRoles = signal<Partial<Record<number, ResearcherRole>>>({});
  readonly existingResearchRoles = signal<Partial<Record<number, ResearcherRole>>>({});
  readonly researcherRoles: ResearcherRole[] = ['OWNER', 'COLLABORATOR', 'VIEWER'];
  readonly roleOptions = computed<SelectOption[]>(() => {
    this.lang();
    return this.researcherRoles.map((r) => ({ value: r, label: this.translate.instant(`RESEARCHERS.ROLE_${r}`) }));
  });

  readonly form = this.fb.group({
    firstName: ['', [Validators.required, Validators.maxLength(100)]],
    lastName: ['', [Validators.required, Validators.maxLength(100)]],
    email: ['', [Validators.required, Validators.email, Validators.maxLength(255)]],
    dateOfBirth: [''],
    academicStatus: [''],
    country: [''],
    newPassword: [''], // only shown/used while editing — force-reset someone's password
    isSuperAdmin: [false],
    researchIds: this.fb.control<number[]>([]),
  });

  readonly isSuperAdminSelected = computed(() => this.form.controls.isSuperAdmin.value ?? false);

  // "Add existing researcher" flow's own light state.
  readonly existingResearcherId = signal<number | null>(null);
  readonly existingResearchIds = signal<number[]>([]);
  readonly existingResearcherOptions = computed<SelectOption[]>(() =>
    this.researchers()
      .filter((r) => !r.isSuperAdmin)
      .map((r) => ({ value: r.id, label: `${r.firstName} ${r.lastName} (${r.email})` }))
  );

  constructor() {
    this.researchesStore.ensureLoaded();
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.researchers.set(await this.api.getResearchers());
    } finally {
      this.loading.set(false);
    }
  }

  fullName(r: ResearcherSummary): string {
    return `${r.firstName} ${r.lastName}`.trim();
  }

  researchNames(r: ResearcherSummary): string {
    // 2026-09-08 — a pending (not-yet-accepted) research gets a suffix so this list never implies
    // access the researcher doesn't actually have yet.
    const pendingSuffix = this.translate.instant('RESEARCHERS.PENDING_SUFFIX');
    return r.researches.map((x) => (x.status === 'pending' ? `${x.name} ${pendingSuffix}` : x.name)).join(', ');
  }

  isResearchChecked(id: number): boolean {
    return (this.form.controls.researchIds.value ?? []).includes(id);
  }

  toggleResearch(id: number, checked: boolean): void {
    const current = this.form.controls.researchIds.value ?? [];
    this.form.controls.researchIds.setValue(
      checked ? [...current, id] : current.filter((x) => x !== id)
    );
    this.researchRoles.update((roles) => {
      const next = { ...roles };
      if (checked) next[id] = next[id] ?? 'OWNER';
      else delete next[id];
      return next;
    });
  }

  roleFor(id: number): ResearcherRole {
    return this.researchRoles()[id] ?? 'OWNER';
  }

  onRoleChange(id: number, value: string | number): void {
    this.researchRoles.update((roles) => ({ ...roles, [id]: value as ResearcherRole }));
  }

  isExistingResearchChecked(id: number): boolean {
    return this.existingResearchIds().includes(id);
  }

  toggleExistingResearch(id: number, checked: boolean): void {
    const current = this.existingResearchIds();
    this.existingResearchIds.set(checked ? [...current, id] : current.filter((x) => x !== id));
    this.existingResearchRoles.update((roles) => {
      const next = { ...roles };
      if (checked) next[id] = next[id] ?? 'OWNER';
      else delete next[id];
      return next;
    });
  }

  existingRoleFor(id: number): ResearcherRole {
    return this.existingResearchRoles()[id] ?? 'OWNER';
  }

  onExistingRoleChange(id: number, value: string | number): void {
    this.existingResearchRoles.update((roles) => ({ ...roles, [id]: value as ResearcherRole }));
  }

  onExistingResearcherChange(value: string | number): void {
    const id = Number(value);
    this.existingResearcherId.set(id);
    const r = this.researchers().find((x) => x.id === id);
    this.existingResearchIds.set(r ? r.researches.map((x) => x.id) : []);
    this.existingResearchRoles.set(r ? Object.fromEntries(r.researches.map((x) => [x.id, x.role])) : {});
  }

  onAcademicStatusChange(value: string | number): void {
    this.form.controls.academicStatus.setValue(String(value));
  }

  onCountryChange(value: string | number): void {
    this.form.controls.country.setValue(String(value));
  }

  startEdit(r: ResearcherSummary): void {
    this.editingId.set(r.id);
    this.saved.set(false);
    this.error.set(null);
    this.inviteEmailFailed.set(false);
    this.deleteError.set(null);
    this.form.setValue({
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      dateOfBirth: r.dateOfBirth ?? '',
      academicStatus: r.academicStatus ?? '',
      country: r.country ?? '',
      newPassword: '',
      isSuperAdmin: r.isSuperAdmin,
      researchIds: r.researches.map((x) => x.id),
    });
    this.researchRoles.set(Object.fromEntries(r.researches.map((x) => [x.id, x.role])));
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.form.reset({
      firstName: '', lastName: '', email: '', dateOfBirth: '', academicStatus: '', country: '',
      newPassword: '', isSuperAdmin: false, researchIds: [],
    });
    this.researchRoles.set({});
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.saving()) return;

    const { firstName, lastName, email, dateOfBirth, academicStatus, country, newPassword, isSuperAdmin, researchIds } =
      this.form.value;
    const effectiveResearchIds = isSuperAdmin ? [] : researchIds ?? [];

    if (!isSuperAdmin && effectiveResearchIds.length === 0) {
      this.error.set('RESEARCHERS.RESEARCHES_ERROR');
      return;
    }
    if (newPassword && newPassword.length > 0 && newPassword.length < 8) {
      this.error.set('RESEARCHERS.PASSWORD_ERROR');
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    this.saved.set(false);
    this.inviteEmailFailed.set(false);
    this.newInvitesSent.set(0);

    const id = this.editingId();
    const profileBody = {
      firstName: firstName!.trim(),
      lastName: lastName!.trim(),
      email: email!.trim(),
      dateOfBirth: dateOfBirth || null,
      academicStatus: (academicStatus || null) as AcademicStatus | null,
      country: country?.trim() || null,
      isSuperAdmin: !!isSuperAdmin,
      researchIds: effectiveResearchIds,
      researchRoles: this.researchRoles(),
    };

    try {
      if (id != null) {
        const res = await this.api.updateResearcher(id, { ...profileBody, newPassword: newPassword || undefined });
        this.newInvitesSent.set(res.newInvites);
      } else {
        const result = await this.api.createResearcher({ ...profileBody, lang: this.lang() === 'en' ? 'en' : 'sr' });
        if (!result.inviteEmailSent) this.inviteEmailFailed.set(true);
      }
      await this.load();
      this.saved.set(true);
      this.cancelEdit();
    } catch (err: any) {
      this.error.set(err?.error?.error === 'Email already in use' ? 'RESEARCHERS.ERROR_EMAIL_TAKEN' : 'RESEARCHERS.ERROR');
    } finally {
      this.saving.set(false);
    }
  }

  async submitExisting(): Promise<void> {
    const researcherId = this.existingResearcherId();
    if (researcherId == null || this.saving()) return;
    const r = this.researchers().find((x) => x.id === researcherId);
    if (!r) return;

    if (!r.isSuperAdmin && this.existingResearchIds().length === 0) {
      this.error.set('RESEARCHERS.RESEARCHES_ERROR');
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    this.saved.set(false);
    this.newInvitesSent.set(0);

    try {
      const res = await this.api.updateResearcher(researcherId, {
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        dateOfBirth: r.dateOfBirth,
        academicStatus: r.academicStatus,
        country: r.country,
        isSuperAdmin: r.isSuperAdmin,
        researchIds: r.isSuperAdmin ? [] : this.existingResearchIds(),
        researchRoles: this.existingResearchRoles(),
      });
      this.newInvitesSent.set(res.newInvites);
      await this.load();
      this.saved.set(true);
      this.existingResearcherId.set(null);
      this.existingResearchIds.set([]);
      this.existingResearchRoles.set({});
    } catch {
      this.error.set('RESEARCHERS.ERROR');
    } finally {
      this.saving.set(false);
    }
  }

  async remove(r: ResearcherSummary): Promise<void> {
    this.deleteError.set(null);
    if (!confirm(this.translate.instant('RESEARCHERS.DELETE_CONFIRM'))) return;
    try {
      await this.api.deleteResearcher(r.id);
      await this.load();
    } catch (err: any) {
      this.deleteError.set(
        err?.error?.error === 'Cannot delete the last remaining superadmin'
          ? 'RESEARCHERS.DELETE_ERROR_LAST_SUPERADMIN'
          : 'RESEARCHERS.ERROR'
      );
    }
  }
}
