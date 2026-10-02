import { Component, ElementRef, ViewChild, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { AdminApiService, MailingListRowError } from '../../services/admin-api.service';
import { HelpIconComponent } from '../../shared/help-icon/help-icon.component';
import { LoadingSpinnerComponent } from '../../shared/loading-spinner/loading-spinner.component';

/**
 * Consent Form delivery section (Part C3 of the 2026-09-08 follow-up round) — two independent
 * modes: a plain shareable link into the Consent app (Mode 1, no personalization — just the
 * app's own existing public URL, exposed here for convenience) and a CSV mailing-list upload
 * that mints a real per-recipient magic link and emails it (Mode 2). Embedded below
 * ConsentFormComponent's own preview/edit section, not a separate page/route.
 */
@Component({
  selector: 'app-consent-delivery',
  standalone: true,
  imports: [FormsModule, TranslateModule, HelpIconComponent, LoadingSpinnerComponent],
  templateUrl: './delivery.component.html',
  styleUrl: './delivery.component.scss',
})
export class ConsentDeliveryComponent {
  private api = inject(AdminApiService);

  readonly researchId = input.required<number>();

  @ViewChild('fileInput') fileInputRef?: ElementRef<HTMLInputElement>;

  readonly portalUrl = signal<string | null>(null);
  readonly portalUrlLoading = signal(true);
  readonly copied = signal(false);

  // 2026-09-09 — Activate/Deactivate toggle: a fresh link starts inactive (ConsentPortalActive
  // DEFAULT FALSE) and must be explicitly turned on before consent-andrejkatin's /r/:slug entry
  // point lets any participant through. Mirrors pr-review-task.component.ts's activate() shape —
  // busy-signal, await the API call, re-fetch for confirmed state.
  readonly portalActive = signal<boolean | null>(null);
  readonly togglingActive = signal(false);

  // 2026-09-08 follow-up — the portal link is now research-scoped (`${consentAppUrl}/${slug}`);
  // this lets a researcher fix up the path segment itself (e.g. a typo, or a shorter name) from
  // right here rather than it staying whatever was auto-generated from the research's Name at
  // creation time.
  readonly currentSlug = signal<string | null>(null);
  readonly editingSlug = signal(false);
  readonly slugInput = signal('');
  readonly slugSaving = signal(false);
  readonly slugError = signal<'INVALID_SLUG' | 'SLUG_TAKEN' | 'SERVER_ERROR' | null>(null);

  readonly uploading = signal(false);
  readonly uploadError = signal<string | null>(null);
  readonly result = signal<{ sent: number; errors: MailingListRowError[] } | null>(null);

  constructor() {
    // allowSignalWrites — see task-file-list.component.ts's identical comment; same
    // NG0600-causes-load()-to-abort-before-clearing-`loading` bug class, same fix. Re-fetches on
    // every researchId change (ConsentFormComponent stays mounted across a research switch, this
    // child just gets a new input value), not just once at creation.
    effect(() => {
      const id = this.researchId();
      this.loadPortalUrl(id);
    }, { allowSignalWrites: true });
  }

  private async loadPortalUrl(researchId: number): Promise<void> {
    this.portalUrlLoading.set(true);
    this.uploadError.set(null);
    this.result.set(null);
    this.editingSlug.set(false);
    this.slugError.set(null);
    try {
      const res = await this.api.getConsentPortalLink(researchId);
      this.portalUrl.set(res.url);
      this.currentSlug.set(res.slug);
      this.portalActive.set(res.active);
    } catch {
      this.portalUrl.set(null);
      this.currentSlug.set(null);
      this.portalActive.set(null);
    } finally {
      this.portalUrlLoading.set(false);
    }
  }

  async toggleActive(): Promise<void> {
    if (this.togglingActive() || this.portalActive() === null) return;
    this.togglingActive.set(true);
    try {
      await this.api.setConsentPortalActive(this.researchId(), !this.portalActive());
      await this.loadPortalUrl(this.researchId());
    } finally {
      this.togglingActive.set(false);
    }
  }

  startEditSlug(): void {
    this.slugInput.set(this.currentSlug() ?? '');
    this.slugError.set(null);
    this.editingSlug.set(true);
  }

  cancelEditSlug(): void {
    this.editingSlug.set(false);
    this.slugError.set(null);
  }

  async saveSlug(): Promise<void> {
    const slug = this.slugInput().trim().toLowerCase();
    if (this.slugSaving() || !slug) return;

    this.slugSaving.set(true);
    this.slugError.set(null);
    const res = await this.api.updateResearchSlug(this.researchId(), slug);
    this.slugSaving.set(false);

    if (res.ok) {
      this.editingSlug.set(false);
      await this.loadPortalUrl(this.researchId());
    } else {
      this.slugError.set(res.error);
    }
  }

  async copyPortalUrl(): Promise<void> {
    const url = this.portalUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // Clipboard API can be unavailable (insecure context, permissions) — the URL is still
      // visible as plain selectable text, so this is a soft failure, no error UI needed.
    }
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || this.uploading()) return;

    this.uploading.set(true);
    this.uploadError.set(null);
    this.result.set(null);
    try {
      const res = await this.api.uploadMailingList(this.researchId(), file);
      if (res.ok) {
        this.result.set({ sent: res.sent, errors: res.errors });
      } else {
        this.uploadError.set(res.error);
      }
    } finally {
      this.uploading.set(false);
      if (this.fileInputRef) this.fileInputRef.nativeElement.value = '';
    }
  }
}
