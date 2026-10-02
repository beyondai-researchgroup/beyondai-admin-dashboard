import { Component, ElementRef, OnDestroy, ViewChild, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { AcademicStatus, AdminApiService, MyProfile } from '../services/admin-api.service';
import { AuthService } from '../services/auth.service';
import { AvatarRefreshService } from '../services/avatar-refresh.service';
import { SelectComponent, SelectOption } from '../shared/select/select.component';
import { COUNTRIES } from '../data/countries';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

/**
 * Self-service "my profile" page (researcher profile system, 2026-08-20) — edit own info (never
 * isSuperAdmin/researchIds/email, those stay admin-only), change password, upload an avatar, and
 * a "Moja istraživanja" list with a "Napusti istraživanje" self-leave button per row.
 */
@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule, SelectComponent, LoadingSpinnerComponent],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss',
})
export class ProfileComponent implements OnDestroy {
  private fb = inject(FormBuilder);
  private api = inject(AdminApiService);
  private auth = inject(AuthService);
  private avatarRefresh = inject(AvatarRefreshService);
  private translate = inject(TranslateService);
  private router = inject(Router);
  private readonly lang = signal(this.translate.currentLang || 'sr');

  @ViewChild('avatarInput') avatarInputRef?: ElementRef<HTMLInputElement>;

  readonly profile = signal<MyProfile | null>(null);
  // The avatar route sits behind requireAuth — a plain <img src> can't carry the Authorization
  // header, so this holds a Blob ObjectURL fetched with the Bearer token instead (see
  // fetchAvatarObjectUrl's doc comment). null means "no avatar" or "not loaded yet".
  readonly avatarObjectUrl = signal<string | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal(false);

  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly saveError = signal(false);

  readonly changingPassword = signal(false);
  readonly passwordSaved = signal(false);
  readonly passwordError = signal<'CURRENT_PASSWORD_INCORRECT' | 'SERVER_ERROR' | 'MISMATCH' | null>(null);

  readonly uploadingAvatar = signal(false);
  readonly avatarError = signal(false);

  readonly leavingResearchId = signal<number | null>(null);
  readonly leaveError = signal<string | null>(null);

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
  readonly languageOptions = computed<SelectOption[]>(() => [
    { value: 'sr', label: 'Srpski' },
    { value: 'en', label: 'English' },
  ]);

  readonly form = this.fb.group({
    firstName: ['', [Validators.required, Validators.maxLength(100)]],
    lastName: ['', [Validators.required, Validators.maxLength(100)]],
    dateOfBirth: [''],
    academicStatus: [''],
    country: [''],
    language: ['sr'],
  });

  readonly passwordForm = this.fb.group({
    currentPassword: ['', Validators.required],
    newPassword: ['', [Validators.required, Validators.minLength(8)]],
    confirmPassword: ['', Validators.required],
  });

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    this.load();
  }

  ngOnDestroy(): void {
    const url = this.avatarObjectUrl();
    if (url) URL.revokeObjectURL(url);
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const p = await this.api.getMyProfile();
      this.profile.set(p);
      this.form.setValue({
        firstName: p.firstName,
        lastName: p.lastName,
        dateOfBirth: p.dateOfBirth ?? '',
        academicStatus: p.academicStatus ?? '',
        country: p.country ?? '',
        language: p.language,
      });
      if (p.hasAvatar) await this.loadAvatar(p.id);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadAvatar(researcherId: number): Promise<void> {
    const previous = this.avatarObjectUrl();
    const url = await this.api.fetchAvatarObjectUrl(researcherId);
    this.avatarObjectUrl.set(url);
    if (previous) URL.revokeObjectURL(previous);
  }

  onAcademicStatusChange(value: string | number): void {
    this.form.controls.academicStatus.setValue(String(value));
  }
  onCountryChange(value: string | number): void {
    this.form.controls.country.setValue(String(value));
  }
  onLanguageChange(value: string | number): void {
    this.form.controls.language.setValue(String(value) as 'sr' | 'en');
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.saving()) return;
    this.saving.set(true);
    this.saveError.set(false);
    this.saved.set(false);

    const v = this.form.value;
    const newLang = (v.language as 'sr' | 'en') ?? 'sr';
    try {
      await this.api.updateMyProfile({
        firstName: v.firstName!.trim(),
        lastName: v.lastName!.trim(),
        dateOfBirth: v.dateOfBirth || null,
        academicStatus: (v.academicStatus || null) as AcademicStatus | null,
        country: v.country?.trim() || null,
        language: newLang,
      });
      this.auth.updateCachedResearcher({ firstName: v.firstName!.trim(), lastName: v.lastName!.trim() });
      if (newLang !== this.translate.currentLang) this.translate.use(newLang);
      this.saved.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  async submitPassword(): Promise<void> {
    if (this.passwordForm.invalid || this.changingPassword()) return;
    const { currentPassword, newPassword, confirmPassword } = this.passwordForm.value;
    if (newPassword !== confirmPassword) {
      this.passwordError.set('MISMATCH');
      return;
    }

    this.changingPassword.set(true);
    this.passwordError.set(null);
    this.passwordSaved.set(false);
    try {
      const result = await this.api.changeMyPassword(currentPassword!, newPassword!);
      if (result.ok) {
        this.passwordSaved.set(true);
        this.passwordForm.reset({ currentPassword: '', newPassword: '', confirmPassword: '' });
      } else {
        this.passwordError.set(result.error);
      }
    } finally {
      this.changingPassword.set(false);
    }
  }

  async onAvatarSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.uploadingAvatar.set(true);
    this.avatarError.set(false);
    try {
      await this.api.uploadMyAvatar(file);
      // The profile signal's own `hasAvatar` was fetched at page-load time (false for anyone
      // without a picture yet) — patch it in directly instead of waiting on a re-fetch, and
      // re-fetch the actual image bytes now that they exist.
      const p = this.profile();
      if (p) {
        this.profile.set({ ...p, hasAvatar: true });
        await this.loadAvatar(p.id);
      }
      // Tells GlobalHeaderComponent's own avatar (a separate fetch) to refresh too.
      this.avatarRefresh.refresh();
    } catch {
      this.avatarError.set(true);
    } finally {
      this.uploadingAvatar.set(false);
      if (this.avatarInputRef) this.avatarInputRef.nativeElement.value = '';
    }
  }

  async leaveResearch(researchId: number): Promise<void> {
    if (!confirm(this.translate.instant('PROFILE.LEAVE_CONFIRM'))) return;
    this.leaveError.set(null);
    this.leavingResearchId.set(researchId);
    try {
      const result = await this.api.leaveResearch(researchId);
      if (result.ok) {
        await this.load();
      } else {
        this.leaveError.set(result.error === 'LAST_RESEARCH' ? 'PROFILE.LEAVE_ERROR_LAST' : 'PROFILE.LEAVE_ERROR');
      }
    } finally {
      this.leavingResearchId.set(null);
    }
  }
}
