import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { AdminApiService, ResearcherDirectoryEntry, ResearcherRole, StudyConfig, TeamMember } from '../services/admin-api.service';
import { AuthService } from '../services/auth.service';
import { ScopeService } from '../services/scope.service';
import { StudyConfigStoreService } from '../services/study-config-store.service';
import { SelectComponent, SelectOption } from '../shared/select/select.component';
import { HelpIconComponent } from '../shared/help-icon/help-icon.component';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

/**
 * Single "Configuration" page combining what used to be two separate pages (Study Configuration
 * + Settings), as two clearly separated sections — both are per-account/per-research setup a
 * researcher visits occasionally, not day-to-day workflow, so splitting them across two nav
 * entries was more separation than the content warranted.
 *
 * Section 1 — Study configuration: EEG toggle, NASA-TLX structure, REI-40 variant, scoped to the
 * sidebar's selected research (unchanged from the former StudyConfigComponent).
 * Section 2 — Google Calendar: per-researcher OAuth connect/disconnect (unchanged from the former
 * SettingsComponent) — this one isn't research-scoped, it's tied to the logged-in researcher.
 */
// The one device this app can actually parse/chart (server/eeg/insight5.mjs's exact 29-column
// header check) — any other value routes a participant's EEG section into upload/download-only
// mode, both here (form UI) and on Participant Detail (interpretation gating).
export const EEG_DEVICE_INSIGHT5 = 'Emotiv Insight 5';
const EEG_DEVICE_OTHER = 'OTHER';

@Component({
  selector: 'app-configuration',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule, SelectComponent, HelpIconComponent, LoadingSpinnerComponent],
  templateUrl: './configuration.component.html',
  styleUrl: './configuration.component.scss',
})
export class ConfigurationComponent {
  private fb = inject(FormBuilder);
  private api = inject(AdminApiService);
  private auth = inject(AuthService);
  private scope = inject(ScopeService);
  readonly studyConfigStore = inject(StudyConfigStoreService);
  private route = inject(ActivatedRoute);
  private translate = inject(TranslateService);
  private readonly lang = signal(this.translate.currentLang || 'sr');

  // --- Study configuration ---
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal(false);
  readonly saveLockedError = signal(false);
  readonly saved = signal(false);

  // Raw ids from the API, labels derived via a computed (not baked in at load time) so a
  // language switch after the page has already loaded re-translates the dropdown too — the same
  // gap eegDeviceOptions already avoided by being a computed from the start.
  readonly rei40VariantIds = signal<string[]>(['v1']);
  readonly rei40VariantOptions = computed<SelectOption[]>(() =>
    this.rei40VariantIds().map((id) => ({ value: id, label: this.variantLabel(id) }))
  );
  readonly rei40VariantLocked = signal(false);

  readonly eegDeviceOptions = computed<SelectOption[]>(() => [
    { value: EEG_DEVICE_INSIGHT5, label: EEG_DEVICE_INSIGHT5 },
    { value: EEG_DEVICE_OTHER, label: this.t('STUDY_CONFIG.EEG_DEVICE_OTHER_OPTION') },
  ]);

  form = this.fb.group({
    usesEeg: [false],
    // Preset selects between the one recognized device and "something else"; eegDeviceOtherName
    // only matters (and is only shown) when the preset is EEG_DEVICE_OTHER — it's free-text
    // metadata (what to call the device), it doesn't feed any parsing logic.
    eegDevicePreset: [EEG_DEVICE_INSIGHT5],
    eegDeviceOtherName: [''],
    usesTlx: [true],
    tlxCalculateScores: [true],
    tlxIncludeWeightings: [true],
    rei40Variant: ['v1'],
    // Phase D of platform-ification — off skips REI-40/Big Five entirely for this research;
    // studyDisplayName only matters (and is only shown) when usesPsychTests is false, since
    // it's the one configurable piece of the thank-you email consent-andrejkatin sends instead.
    usesPsychTests: [true],
    studyDisplayName: ['', [Validators.required, Validators.maxLength(200)]],
    emailSenderName: ['', [Validators.maxLength(150)]],
    // Part C of the platform re-architecture — off skips the consent screen entirely for this
    // research's participants (a shared, non-per-participant "your links" page instead).
    usesConsentForm: [true],
    // Demographic Questionnaire (2026-10-01) — default false matches the DB column default; a
    // brand-new feature nobody has authored questions for yet, unlike usesPsychTests/usesTlx.
    usesDemographics: [false],
    // 2026-09-08 follow-up — whether Participants/Import/Experimental-Sessions are shown at all;
    // forced true (and un-editable, see the template's taskType gate) for PR_REVIEW research.
    tracksParticipants: [true],
    // Which language(s) are even offered to a participant at their first Consent-app login — at
    // least one must stay checked (enforced client-side in onConsentLanguageChange below, and
    // again server-side/DB-side).
    consentLanguageSr: [true],
    consentLanguageEn: [true],
    // Per-app participant timer (2026-09-11) — each row's *Enabled is only ever shown/editable
    // when studyConfigStore says this research actually uses that app (see the template); the
    // *Minutes field only matters (and only renders) when its own *Enabled is checked.
    timerCodeReviewEnabled: [false],
    timerCodeReviewMinutes: [30],
    timerRei40Enabled: [false],
    timerRei40Minutes: [15],
    timerBigFiveEnabled: [false],
    timerBigFiveMinutes: [15],
    timerNasaTlxEnabled: [false],
    timerNasaTlxMinutes: [15],
  });

  // --- Google Calendar ---
  readonly calendarLoading = signal(true);
  readonly calendarLoadError = signal(false);
  readonly calendarConnected = signal(false);
  readonly calendarEmail = signal<string | null>(null);

  readonly calendarJustConnected = signal(false);
  readonly calendarConnectError = signal(false);
  readonly calendarNotConfigured = signal(false);

  readonly calendarDisconnecting = signal(false);
  readonly calendarDisconnectError = signal(false);

  readonly calendarConnectUrl = this.api.buildCalendarConnectUrl();
  readonly calendarHelpSteps = computed(() => {
    this.lang();
    return ['SETTINGS.CALENDAR_HELP_STEP1', 'SETTINGS.CALENDAR_HELP_STEP2', 'SETTINGS.CALENDAR_HELP_STEP3', 'SETTINGS.CALENDAR_HELP_STEP4'].map(
      (k) => this.translate.instant(k)
    );
  });

  // --- Google Forms (Part G of the platform re-architecture, 2026-09-07) --- same shape as the
  // Google Calendar block above, a separate connection (own OAuth client/columns).
  readonly googleFormsLoading = signal(true);
  readonly googleFormsLoadError = signal(false);
  readonly googleFormsConnected = signal(false);
  readonly googleFormsEmail = signal<string | null>(null);

  readonly googleFormsJustConnected = signal(false);
  readonly googleFormsConnectError = signal(false);
  readonly googleFormsNotConfigured = signal(false);

  readonly googleFormsDisconnecting = signal(false);
  readonly googleFormsDisconnectError = signal(false);

  readonly googleFormsConnectUrl = this.api.buildGoogleFormsConnectUrl();
  readonly googleFormsHelpSteps = computed(() => {
    this.lang();
    return [
      'SETTINGS.GOOGLE_FORMS_HELP_STEP1',
      'SETTINGS.GOOGLE_FORMS_HELP_STEP2',
      'SETTINGS.GOOGLE_FORMS_HELP_STEP3',
      'SETTINGS.GOOGLE_FORMS_HELP_STEP4',
    ].map((k) => this.translate.instant(k));
  });

  // --- Team (Part B of the platform re-architecture, 2026-09-07) ---
  readonly teamMembers = signal<TeamMember[]>([]);
  readonly teamLoading = signal(false);
  readonly teamLoadError = signal(false);
  readonly directory = signal<ResearcherDirectoryEntry[]>([]);
  readonly teamSaving = signal(false);
  readonly teamError = signal<string | null>(null);
  readonly newMemberId = signal<number | null>(null);
  readonly newMemberRole = signal<ResearcherRole>('OWNER');
  // 2026-09-08 — set right after a successful addTeamMember() call so the template can show
  // "invitation sent" vs "access updated"; cleared on the next add/remove attempt.
  readonly teamAddedStatus = signal<'updated' | 'invited' | null>(null);

  readonly roleOptions: SelectOption[] = [
    { value: 'OWNER', label: 'OWNER' },
    { value: 'COLLABORATOR', label: 'COLLABORATOR' },
    { value: 'VIEWER', label: 'VIEWER' },
  ];

  // Only an OWNER of the currently-selected research sees/can edit the Team section — derived
  // straight from the researches list already carried on the logged-in researcher (superadmin
  // always counts as owning everything, matching hasMinRole's own bypass on the backend).
  readonly isTeamOwner = computed(() => {
    const researcher = this.auth.researcher();
    if (!researcher) return false;
    if (researcher.isSuperAdmin) return true;
    const id = this.scope.selectedResearchId();
    return researcher.researches.some((r) => r.id === id && r.role === 'OWNER');
  });

  readonly directoryOptions = computed<SelectOption[]>(() => {
    const memberIds = new Set(this.teamMembers().map((m) => m.id));
    return this.directory()
      .filter((r) => !memberIds.has(r.id))
      .map((r) => ({ value: r.id, label: `${r.firstName} ${r.lastName} (${r.email})` }));
  });

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));

    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      if (id != null) this.loadStudyConfig(id);
      if (id != null) this.loadTeam(id);
    });
    this.api.getResearcherDirectory().then((d) => this.directory.set(d)).catch(() => this.directory.set([]));

    const params = this.route.snapshot.queryParamMap;
    this.calendarJustConnected.set(params.get('calendarConnected') === '1');
    this.calendarConnectError.set(params.get('calendarError') === '1');
    this.calendarNotConfigured.set(params.get('calendarError') === 'not_configured');
    this.loadCalendarStatus();

    this.googleFormsJustConnected.set(params.get('googleFormsConnected') === '1');
    this.googleFormsConnectError.set(params.get('googleFormsError') === '1');
    this.googleFormsNotConfigured.set(params.get('googleFormsError') === 'not_configured');
    this.loadGoogleFormsStatus();
  }

  private async loadStudyConfig(researchId: number): Promise<void> {
    this.loading.set(true);
    this.loadError.set(false);
    this.saved.set(false);
    this.saveError.set(false);
    this.saveLockedError.set(false);
    try {
      const cfg = await this.api.getStudyConfig(researchId);
      this.rei40VariantIds.set(cfg.rei40Variants);
      this.rei40VariantLocked.set(cfg.rei40VariantLocked);
      const isInsight5 = cfg.eegDeviceType === EEG_DEVICE_INSIGHT5;
      this.form.setValue({
        usesEeg: cfg.usesEeg,
        eegDevicePreset: isInsight5 || !cfg.eegDeviceType ? EEG_DEVICE_INSIGHT5 : EEG_DEVICE_OTHER,
        eegDeviceOtherName: isInsight5 ? '' : (cfg.eegDeviceType ?? ''),
        usesTlx: cfg.usesTlx,
        tlxCalculateScores: cfg.tlxCalculateScores,
        tlxIncludeWeightings: cfg.tlxIncludeWeightings,
        rei40Variant: cfg.rei40Variant,
        usesPsychTests: cfg.usesPsychTests,
        studyDisplayName: cfg.studyDisplayName,
        emailSenderName: cfg.emailSenderName ?? '',
        usesConsentForm: cfg.usesConsentForm,
        usesDemographics: cfg.usesDemographics,
        tracksParticipants: cfg.tracksParticipants,
        consentLanguageSr: cfg.consentLanguageSr,
        consentLanguageEn: cfg.consentLanguageEn,
        timerCodeReviewEnabled: cfg.timerCodeReviewEnabled,
        timerCodeReviewMinutes: cfg.timerCodeReviewMinutes ?? 30,
        timerRei40Enabled: cfg.timerRei40Enabled,
        timerRei40Minutes: cfg.timerRei40Minutes ?? 15,
        timerBigFiveEnabled: cfg.timerBigFiveEnabled,
        timerBigFiveMinutes: cfg.timerBigFiveMinutes ?? 15,
        timerNasaTlxEnabled: cfg.timerNasaTlxEnabled,
        timerNasaTlxMinutes: cfg.timerNasaTlxMinutes ?? 15,
      });
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private variantLabel(id: string): string {
    // Keep in sync with server/study-config/routes.mjs's REI40_VARIANTS. The 'short' label states
    // outright that it's a subset, not the official (unpublished) REI-10 — see
    // rei40-andrejkatin's data/rei40-short-items.ts for why. Translated (not hardcoded Serbian)
    // so the dropdown actually reflects the selected UI language.
    if (id === 'v1') return this.t('STUDY_CONFIG.REI40_VARIANT_OPTION_V1');
    if (id === 'short') return this.t('STUDY_CONFIG.REI40_VARIANT_OPTION_SHORT');
    return id;
  }

  onRei40VariantChange(value: string | number): void {
    this.form.controls.rei40Variant.setValue(String(value));
  }

  onEegDevicePresetChange(value: string | number): void {
    this.form.controls.eegDevicePreset.setValue(String(value));
  }

  // Refuses to leave both languages unchecked — re-checks the one just unchecked instead of
  // silently allowing an invalid state the server would 400 on submit anyway.
  onConsentLanguageChange(lang: 'sr' | 'en', checked: boolean): void {
    const control = lang === 'sr' ? this.form.controls.consentLanguageSr : this.form.controls.consentLanguageEn;
    const other = lang === 'sr' ? this.form.controls.consentLanguageEn : this.form.controls.consentLanguageSr;
    if (!checked && !other.value) {
      control.setValue(true);
      return;
    }
    control.setValue(checked);
  }

  async submit(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (this.saving() || researchId == null) return;

    this.saving.set(true);
    this.saveError.set(false);
    this.saveLockedError.set(false);
    this.saved.set(false);

    const v = this.form.value;
    // The preset carries the recognized/not-recognized distinction; the free-text name is only
    // meaningful (and only shown) for "other" — Insight 5 always saves the exact canonical
    // string the backend checks against (server/eeg/insight5.mjs, eeg/routes.mjs upload
    // validation, and the /interpretation gate all match on this literal value).
    const eegDeviceType =
      v.eegDevicePreset === EEG_DEVICE_INSIGHT5 ? EEG_DEVICE_INSIGHT5 : v.eegDeviceOtherName?.trim() || EEG_DEVICE_OTHER;
    const body: Omit<StudyConfig, 'rei40Variants' | 'rei40VariantLocked'> = {
      usesEeg: v.usesEeg ?? false,
      eegDeviceType,
      usesTlx: v.usesTlx ?? true,
      tlxCalculateScores: v.tlxCalculateScores ?? true,
      tlxIncludeWeightings: v.tlxIncludeWeightings ?? true,
      rei40Variant: v.rei40Variant ?? 'v1',
      usesPsychTests: v.usesPsychTests ?? true,
      studyDisplayName: v.studyDisplayName?.trim() || '',
      emailSenderName: v.emailSenderName?.trim() || null,
      usesConsentForm: v.usesConsentForm ?? true,
      usesDemographics: v.usesDemographics ?? false,
      tracksParticipants: this.studyConfigStore.taskType() === 'PR_REVIEW' ? true : (v.tracksParticipants ?? true),
      consentLanguageSr: v.consentLanguageSr ?? true,
      consentLanguageEn: v.consentLanguageEn ?? true,
      timerCodeReviewEnabled: v.timerCodeReviewEnabled ?? false,
      timerCodeReviewMinutes: v.timerCodeReviewMinutes ?? 30,
      timerRei40Enabled: v.timerRei40Enabled ?? false,
      timerRei40Minutes: v.timerRei40Minutes ?? 15,
      timerBigFiveEnabled: v.timerBigFiveEnabled ?? false,
      timerBigFiveMinutes: v.timerBigFiveMinutes ?? 15,
      timerNasaTlxEnabled: v.timerNasaTlxEnabled ?? false,
      timerNasaTlxMinutes: v.timerNasaTlxMinutes ?? 15,
    };

    const result = await this.api.updateStudyConfig(researchId, body);
    this.saving.set(false);
    if (result.ok) {
      this.saved.set(true);
      // Bug fix (2026-08-20): the sidebar's Results menu previously only refreshed on a research
      // switch, so saving here while this research was already selected left it stale (still
      // showing NASA-TLX/REI-40/Big Five tabs a researcher had just turned off) until they
      // switched away and back. Refreshing the shared store now reflects the save immediately.
      await this.studyConfigStore.refresh(researchId);
    } else if (result.error === 'REI40_VARIANT_LOCKED') {
      // Someone else completed a REI result for this research between load and submit —
      // re-load so the form reflects the now-locked state instead of silently no-oping.
      this.rei40VariantLocked.set(true);
      this.saveLockedError.set(true);
    } else {
      this.saveError.set(true);
    }
  }

  private async loadTeam(researchId: number): Promise<void> {
    this.teamLoading.set(true);
    this.teamLoadError.set(false);
    this.teamError.set(null);
    try {
      const members = await this.api.getTeam(researchId);
      this.teamMembers.set(members);
    } catch {
      this.teamLoadError.set(true);
    } finally {
      this.teamLoading.set(false);
    }
  }

  onNewMemberChange(value: string | number): void {
    this.newMemberId.set(Number(value));
  }

  onNewMemberRoleChange(value: string | number): void {
    this.newMemberRole.set(String(value) as ResearcherRole);
  }

  async addTeamMember(): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    const researcherId = this.newMemberId();
    if (researchId == null || researcherId == null || this.teamSaving()) return;

    this.teamSaving.set(true);
    this.teamError.set(null);
    this.teamAddedStatus.set(null);
    const result = await this.api.updateTeamMember(researchId, researcherId, this.newMemberRole());
    this.teamSaving.set(false);
    if (result.ok) {
      this.newMemberId.set(null);
      // 2026-09-08 — adding someone not already a member sends an invite instead of granting
      // access directly; the confirmation message needs to say which one actually happened.
      this.teamAddedStatus.set(result.status);
      await this.loadTeam(researchId);
    } else {
      this.teamError.set(result.error ?? 'ERROR');
    }
  }

  async changeTeamMemberRole(researcherId: number, role: string | number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.teamSaving()) return;

    this.teamSaving.set(true);
    this.teamError.set(null);
    const result = await this.api.updateTeamMember(researchId, researcherId, String(role) as ResearcherRole);
    this.teamSaving.set(false);
    if (result.ok) {
      await this.loadTeam(researchId);
    } else {
      this.teamError.set(result.error ?? 'ERROR');
    }
  }

  async removeTeamMember(researcherId: number): Promise<void> {
    const researchId = this.scope.selectedResearchId();
    if (researchId == null || this.teamSaving()) return;
    const member = this.teamMembers().find((m) => m.id === researcherId);
    const confirmKey = member?.status === 'pending' ? 'CONFIGURATION.TEAM_WITHDRAW_CONFIRM' : 'CONFIGURATION.TEAM_REMOVE_CONFIRM';
    if (!confirm(this.t(confirmKey))) return;

    this.teamSaving.set(true);
    this.teamError.set(null);
    this.teamAddedStatus.set(null);
    const result = await this.api.removeTeamMember(researchId, researcherId);
    this.teamSaving.set(false);
    if (result.ok) {
      await this.loadTeam(researchId);
    } else {
      this.teamError.set(result.error ?? 'ERROR');
    }
  }

  private async loadCalendarStatus(): Promise<void> {
    this.calendarLoading.set(true);
    this.calendarLoadError.set(false);
    try {
      const status = await this.api.getCalendarStatus();
      this.calendarConnected.set(status.connected);
      this.calendarEmail.set(status.email);
    } catch {
      this.calendarLoadError.set(true);
    } finally {
      this.calendarLoading.set(false);
    }
  }

  async disconnectCalendar(): Promise<void> {
    if (this.calendarDisconnecting()) return;
    this.calendarDisconnecting.set(true);
    this.calendarDisconnectError.set(false);
    try {
      await this.api.disconnectCalendar();
      this.calendarConnected.set(false);
      this.calendarEmail.set(null);
    } catch {
      this.calendarDisconnectError.set(true);
    } finally {
      this.calendarDisconnecting.set(false);
    }
  }

  private async loadGoogleFormsStatus(): Promise<void> {
    this.googleFormsLoading.set(true);
    this.googleFormsLoadError.set(false);
    try {
      const status = await this.api.getGoogleFormsStatus();
      this.googleFormsConnected.set(status.connected);
      this.googleFormsEmail.set(status.email);
    } catch {
      this.googleFormsLoadError.set(true);
    } finally {
      this.googleFormsLoading.set(false);
    }
  }

  async disconnectGoogleForms(): Promise<void> {
    if (this.googleFormsDisconnecting()) return;
    this.googleFormsDisconnecting.set(true);
    this.googleFormsDisconnectError.set(false);
    try {
      await this.api.disconnectGoogleForms();
      this.googleFormsConnected.set(false);
      this.googleFormsEmail.set(null);
    } catch {
      this.googleFormsDisconnectError.set(true);
    } finally {
      this.googleFormsDisconnecting.set(false);
    }
  }

  private t(key: string, params?: object): string {
    this.lang();
    return this.translate.instant(key, params);
  }
}
