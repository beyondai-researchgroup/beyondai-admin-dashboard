import { Injectable, signal } from '@angular/core';

/**
 * Tiny cross-component signal so ProfileComponent can tell GlobalHeaderComponent's avatar
 * `<img>` to bust its cache right after a successful re-upload — they're siblings (the header is
 * mounted once in app.component.html, outside the router-outlet the profile page renders into),
 * so this small shared service is simpler than plumbing an @Output up through the app shell.
 */
@Injectable({ providedIn: 'root' })
export class AvatarRefreshService {
  readonly bust = signal(Date.now());

  refresh(): void {
    this.bust.set(Date.now());
  }
}
