import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AdminApiService, InviteResolveErrorCode } from '../services/admin-api.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

/**
 * Public route `/accept-invite/:token` (researcher profile system, 2026-08-20) — outside the
 * authenticated shell, same routing precedent as rei40-andrejkatin's LinkAccessComponent.
 * Resolves the one-time invite token, then lets the researcher set their own password before
 * ever logging in (the token itself is the authentication for this step — no password needed to
 * reach this form).
 */
@Component({
  selector: 'app-accept-invite',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule, LoadingSpinnerComponent],
  templateUrl: './accept-invite.component.html',
  styleUrl: './accept-invite.component.scss',
})
export class AcceptInviteComponent {
  private fb = inject(FormBuilder);
  private api = inject(AdminApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  private token = this.route.snapshot.paramMap.get('token') ?? '';

  readonly resolving = signal(true);
  readonly resolveError = signal<InviteResolveErrorCode | null>(null);
  readonly email = signal<string | null>(null);

  readonly submitting = signal(false);
  readonly submitError = signal<string | null>(null);
  readonly done = signal(false);

  readonly form = this.fb.group({
    newPassword: ['', [Validators.required, Validators.minLength(8)]],
    confirmPassword: ['', Validators.required],
  });

  constructor() {
    this.resolve();
  }

  private async resolve(): Promise<void> {
    this.resolving.set(true);
    const result = await this.api.resolveResearcherInvite(this.token);
    if (result.ok) {
      this.email.set(result.result.email);
    } else {
      this.resolveError.set(result.error);
    }
    this.resolving.set(false);
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.submitting()) return;
    const { newPassword, confirmPassword } = this.form.value;
    if (newPassword !== confirmPassword) {
      this.submitError.set('MISMATCH');
      return;
    }

    this.submitting.set(true);
    this.submitError.set(null);
    try {
      const result = await this.api.acceptResearcherInvite(this.token, newPassword!);
      if (result.ok) {
        this.done.set(true);
      } else {
        this.submitError.set(result.error);
      }
    } finally {
      this.submitting.set(false);
    }
  }

  goToLogin(): void {
    this.router.navigate(['/login']);
  }
}
