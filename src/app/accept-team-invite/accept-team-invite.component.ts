import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AdminApiService } from '../services/admin-api.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';

type TeamInviteErrorCode = 'NOT_FOUND' | 'EXPIRED' | 'ALREADY_ACCEPTED';

/**
 * Public route `/accept-team-invite/:token` (2026-09-08) — outside the authenticated shell, same
 * routing precedent as accept-invite.component.ts. Unlike that new-account flow, this researcher
 * already has a password — accepting just needs a click, no form. The token alone is the
 * authentication (confirmed explicit choice, consistent with every other magic-link flow in this
 * platform).
 */
@Component({
  selector: 'app-accept-team-invite',
  standalone: true,
  imports: [TranslateModule, LoadingSpinnerComponent],
  templateUrl: './accept-team-invite.component.html',
  styleUrl: './accept-team-invite.component.scss',
})
export class AcceptTeamInviteComponent {
  private api = inject(AdminApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  private token = this.route.snapshot.paramMap.get('token') ?? '';

  readonly resolving = signal(true);
  readonly resolveError = signal<TeamInviteErrorCode | null>(null);
  readonly researchName = signal<string | null>(null);
  readonly researcherFirstName = signal<string | null>(null);

  readonly accepting = signal(false);
  readonly acceptError = signal<string | null>(null);
  readonly done = signal(false);

  constructor() {
    this.resolve();
  }

  private async resolve(): Promise<void> {
    this.resolving.set(true);
    const result = await this.api.resolveTeamInvite(this.token);
    if (result.ok) {
      this.researchName.set(result.researchName);
      this.researcherFirstName.set(result.researcherFirstName);
    } else {
      this.resolveError.set(result.error);
    }
    this.resolving.set(false);
  }

  async accept(): Promise<void> {
    if (this.accepting()) return;
    this.accepting.set(true);
    this.acceptError.set(null);
    try {
      const result = await this.api.acceptTeamInvite(this.token);
      if (result.ok) {
        this.done.set(true);
      } else {
        this.acceptError.set(result.error);
      }
    } finally {
      this.accepting.set(false);
    }
  }

  goToLogin(): void {
    this.router.navigate(['/login']);
  }
}
