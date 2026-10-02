import { Component, ElementRef, HostListener, OnInit, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Theme, ThemeService } from '../services/theme.service';
import { DatePipe } from '@angular/common';
import { AuthService } from '../services/auth.service';
import { AdminApiService } from '../services/admin-api.service';
import { AvatarRefreshService } from '../services/avatar-refresh.service';
import { NotificationsService } from '../services/notifications.service';

@Component({
  selector: 'app-global-header',
  standalone: true,
  imports: [RouterLink, TranslateModule, DatePipe],
  template: `
    <header class="global-header">
      <div class="header-brand">
        <div class="brand-logo-wrap">
          <img [src]="logoSrc()" alt="BeyondAI" class="brand-logo" />
        </div>
        <span class="brand-name">BeyondAI Research Group <span class="brand-suffix">· Admin</span></span>
      </div>
      <div class="header-controls">
        <div class="toggle-group" aria-label="Theme">
          <button
            class="toggle-group__btn"
            type="button"
            [class.toggle-group__btn--active]="currentTheme() === 'dark'"
            (click)="setTheme('dark')"
            aria-label="Dark theme"
            title="Tamna tema / Dark theme"
          >☾</button>
          <button
            class="toggle-group__btn"
            type="button"
            [class.toggle-group__btn--active]="currentTheme() === 'light'"
            (click)="setTheme('light')"
            aria-label="Light theme"
            title="Svetla tema / Light theme"
          >☀</button>
        </div>
        <!-- Language toggle disabled: the language is chosen once on the login page and locked.
             Re-enable by uncommenting if needed. -->
        <!--
        <div class="toggle-group" aria-label="Language">
          <button
            class="toggle-group__btn"
            type="button"
            [class.toggle-group__btn--active]="currentLang() === 'sr'"
            (click)="setLang('sr')"
            aria-label="Srpski"
          >SR</button>
          <button
            class="toggle-group__btn"
            type="button"
            [class.toggle-group__btn--active]="currentLang() === 'en'"
            (click)="setLang('en')"
            aria-label="English"
          >EN</button>
        </div>
        -->

        @if (researcher()) {
          <div class="profile-menu">
            <button type="button" class="bell-btn" (click)="toggleNotifications()" [attr.aria-label]="'HEADER.NOTIFICATIONS' | translate">
              🔔
              @if (notifications.unreadCount() > 0) {
                <span class="bell-badge">{{ notifications.unreadCount() > 9 ? '9+' : notifications.unreadCount() }}</span>
              }
            </button>
            @if (notificationsOpen()) {
              <div class="profile-dropdown notifications-dropdown">
                <div class="notifications-header">
                  <span class="profile-dropdown__name">{{ 'HEADER.NOTIFICATIONS' | translate }}</span>
                  @if (notifications.unreadCount() > 0) {
                    <button type="button" class="mark-all-btn" (click)="notifications.markAllRead()">{{ 'HEADER.MARK_ALL_READ' | translate }}</button>
                  }
                </div>
                @if (!notifications.items().length) {
                  <div class="notifications-empty">{{ 'HEADER.NO_NOTIFICATIONS' | translate }}</div>
                } @else {
                  @for (n of notifications.items(); track n.id) {
                    <button
                      type="button"
                      class="notification-item"
                      [class.notification-item--unread]="!n.isRead"
                      (click)="notifications.markRead(n.id)"
                    >
                      <span class="notification-item__message">{{ n.message }}</span>
                      <span class="notification-item__date">{{ n.createdAt | date: 'dd.MM.yyyy. HH:mm' }}</span>
                    </button>
                  }
                }
              </div>
            }
          </div>
        }

        @if (researcher(); as r) {
          <div class="profile-menu">
            <button type="button" class="profile-avatar-btn" (click)="toggleMenu()" [attr.aria-label]="'HEADER.PROFILE' | translate">
              @if (avatarObjectUrl(); as url) {
                <img [src]="url" alt="" class="profile-avatar-img" />
              } @else {
                <span class="profile-avatar-initials">{{ initials() }}</span>
              }
            </button>
            @if (menuOpen()) {
              <div class="profile-dropdown">
                <div class="profile-dropdown__name">{{ r.firstName }} {{ r.lastName }}</div>
                <div class="profile-dropdown__email">{{ r.email }}</div>
                <a routerLink="/profile" class="profile-dropdown__item" (click)="menuOpen.set(false)">{{ 'HEADER.PROFILE' | translate }}</a>
                <button type="button" class="profile-dropdown__item profile-dropdown__item--btn" (click)="logout()">{{ 'NAV.LOGOUT' | translate }}</button>
              </div>
            }
          </div>
        }
      </div>
    </header>
  `,
  styles: [`
    .global-header {
      position: sticky;
      top: 0;
      z-index: 100;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      background: var(--color-header-bg);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--color-border);
    }

    .header-brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .brand-logo-wrap {
      width: 44px;
      height: 44px;
      border-radius: 8px;
      overflow: hidden;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--color-header-bg);
    }

    .brand-logo {
      width: 44px;
      height: 44px;
      object-fit: contain;
      display: block;
      filter: drop-shadow(0 0 6px rgba(var(--color-accent-rgb), 0.45)) brightness(1.05);
    }

    .brand-name {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 16px;
      font-weight: 600;
      color: var(--header-text);
      letter-spacing: 0.02em;
    }

    .brand-suffix {
      font-weight: 400;
      opacity: 0.7;
    }

    .header-controls {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-shrink: 0;
    }

    .toggle-group {
      display: flex;
      border: 1px solid var(--header-ctrl-border);
      border-radius: 6px;
      overflow: hidden;
    }

    .toggle-group__btn {
      padding: 0.3rem 0.65rem;
      background: transparent;
      color: var(--header-ctrl-color);
      border: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 0.8rem;
      cursor: pointer;
      transition: background 150ms ease, color 150ms ease;
      line-height: 1.4;

      &:not(:last-child) {
        border-right: 1px solid var(--header-ctrl-border);
      }

      &--active {
        background: var(--header-ctrl-active-bg);
        color: var(--header-ctrl-active-color);
        font-weight: 600;
        cursor: default;
      }

      &:not(.toggle-group__btn--active):hover {
        color: var(--header-ctrl-hover-color);
      }
    }

    .profile-menu {
      position: relative;
    }

    .profile-avatar-btn {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 1px solid var(--header-ctrl-border);
      background: var(--header-ctrl-active-bg);
      color: var(--header-ctrl-active-color);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      overflow: hidden;
      font-size: 12.5px;
      font-weight: 700;
    }

    .profile-avatar-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .profile-dropdown {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      min-width: 220px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-input);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      z-index: 200;
    }

    .profile-dropdown__name {
      font-size: 13.5px;
      font-weight: 700;
      color: var(--color-text);
      padding: 4px 8px 0;
    }

    .profile-dropdown__email {
      font-size: 12px;
      color: var(--color-text-secondary);
      padding: 0 8px 8px;
      border-bottom: 1px solid var(--color-border);
      margin-bottom: 6px;
      word-break: break-all;
    }

    .profile-dropdown__item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 8px;
      border-radius: calc(var(--radius-input) - 4px);
      font-size: 13.5px;
      color: var(--color-text);
      text-decoration: none;
      background: transparent;
      border: none;
      cursor: pointer;
      font-family: inherit;
    }

    .profile-dropdown__item:hover {
      background: var(--color-surface-alt);
    }

    .bell-btn {
      position: relative;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 1px solid var(--header-ctrl-border);
      background: transparent;
      color: var(--header-ctrl-color);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      font-size: 15px;
      line-height: 1;
    }

    .bell-btn:hover {
      color: var(--header-ctrl-hover-color);
    }

    .bell-badge {
      position: absolute;
      top: -3px;
      right: -3px;
      min-width: 16px;
      height: 16px;
      padding: 0 3px;
      border-radius: 999px;
      background: var(--color-error, #dc2626);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      line-height: 16px;
      text-align: center;
    }

    .notifications-dropdown {
      min-width: 320px;
      max-width: 380px;
      max-height: 420px;
      overflow-y: auto;
      padding: 8px;
    }

    .notifications-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px 8px;
      border-bottom: 1px solid var(--color-border);
      margin-bottom: 6px;
    }

    .mark-all-btn {
      background: transparent;
      border: none;
      color: var(--color-accent);
      font-size: 12px;
      cursor: pointer;
      padding: 0;
      font-family: inherit;
    }

    .notifications-empty {
      padding: 20px 8px;
      text-align: center;
      font-size: 13px;
      color: var(--color-text-secondary);
    }

    .notification-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      width: 100%;
      text-align: left;
      padding: 10px 8px;
      border-radius: calc(var(--radius-input) - 4px);
      background: transparent;
      border: none;
      cursor: pointer;
      font-family: inherit;
    }

    .notification-item:hover {
      background: var(--color-surface-alt);
    }

    .notification-item--unread {
      background: rgba(var(--color-accent-rgb), 0.08);
    }

    .notification-item--unread:hover {
      background: rgba(var(--color-accent-rgb), 0.14);
    }

    .notification-item__message {
      font-size: 13px;
      line-height: 1.5;
      color: var(--color-text);
    }

    .notification-item__date {
      font-size: 11px;
      color: var(--color-text-secondary);
    }
  `],
})
export class GlobalHeaderComponent implements OnInit {
  private translate = inject(TranslateService);
  private themeService = inject(ThemeService);
  private auth = inject(AuthService);
  private api = inject(AdminApiService);
  private router = inject(Router);
  private elementRef = inject(ElementRef<HTMLElement>);
  private avatarRefresh = inject(AvatarRefreshService);
  readonly notifications = inject(NotificationsService);

  readonly currentLang = signal('sr');
  readonly currentTheme = this.themeService.theme;
  readonly logoSrc = computed(() =>
    this.currentTheme() === 'light' ? 'assets/beyondai-favicon-light.svg' : 'assets/beyondai-favicon.svg'
  );

  readonly menuOpen = signal(false);
  readonly notificationsOpen = signal(false);
  readonly researcher = this.auth.researcher;
  // The avatar route sits behind requireAuth — a plain <img src> can't carry the Authorization
  // header, so this fetches it with the Bearer token and renders a Blob ObjectURL instead (same
  // pattern as fetchAnalysisPlotObjectUrl). null means "no avatar" (a 404) or "not fetched yet",
  // both of which fall back to initials.
  readonly avatarObjectUrl = signal<string | null>(null);

  readonly initials = computed(() => {
    const r = this.auth.researcher();
    if (!r) return '';
    return `${r.firstName?.[0] ?? ''}${r.lastName?.[0] ?? ''}`.toUpperCase();
  });

  constructor() {
    // Re-fetch the avatar Blob whenever the logged-in researcher changes or avatarRefresh.bust()
    // bumps (a re-upload from ProfileComponent) — revokes the previous ObjectURL first so blob
    // URLs don't leak.
    effect(() => {
      const r = this.auth.researcher();
      this.avatarRefresh.bust();
      const previous = this.avatarObjectUrl();
      if (!r) {
        this.avatarObjectUrl.set(null);
        if (previous) URL.revokeObjectURL(previous);
        return;
      }
      this.api.fetchAvatarObjectUrl(r.id).then((url) => {
        this.avatarObjectUrl.set(url);
        if (previous) URL.revokeObjectURL(previous);
      });
    }, { allowSignalWrites: true });

    // Starts/stops the notifications poll as the logged-in researcher changes (started here,
    // in the one component that's always mounted while authenticated, rather than from
    // AppComponent — this is also where the bell UI itself lives).
    effect(() => {
      if (this.auth.researcher()) {
        this.notifications.ensureStarted();
      } else {
        this.notifications.stop();
      }
    }, { allowSignalWrites: true });
  }

  ngOnInit(): void {
    this.currentLang.set(this.translate.currentLang || 'sr');
  }


  setLang(lang: string): void {
    this.translate.use(lang);
    this.currentLang.set(lang);
    try { localStorage.setItem('admin-lang', lang); } catch { /* ignore */ }
  }

  setTheme(theme: Theme): void {
    this.themeService.setTheme(theme);
  }

  toggleMenu(): void {
    this.menuOpen.set(!this.menuOpen());
    if (this.menuOpen()) this.notificationsOpen.set(false);
  }

  toggleNotifications(): void {
    this.notificationsOpen.set(!this.notificationsOpen());
    if (this.notificationsOpen()) this.menuOpen.set(false);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.menuOpen.set(false);
      this.notificationsOpen.set(false);
    }
  }

  logout(): void {
    this.menuOpen.set(false);
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
