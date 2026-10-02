import { Injectable, inject, signal } from '@angular/core';
import { AdminApiService, NotificationItem } from './admin-api.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';

const POLL_INTERVAL_MS = 30_000;

/**
 * Polls the unread notification count/list while a researcher is logged in (2026-08-20) — same
 * conditional-start/stop-while-authenticated discipline as `r-analysis.component.ts`'s existing
 * run-status poll, just running continuously instead of only while a specific thing is active
 * (there is no WebSocket/SSE infra anywhere in this app to push instead — confirmed via
 * exploration before this was built). New notifications observed since the previous poll are
 * pushed into ToastService as auto-dismissing popups.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private api = inject(AdminApiService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);

  readonly unreadCount = signal(0);
  readonly items = signal<NotificationItem[]>([]);

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private knownIds = new Set<number>();
  private startedForResearcherId: number | null = null;

  /** Called once from the app shell once a researcher is confirmed logged in. Safe to call
   *  repeatedly — no-ops if already running for the same researcher. */
  ensureStarted(): void {
    const researcher = this.auth.researcher();
    if (!researcher) {
      this.stop();
      return;
    }
    if (this.startedForResearcherId === researcher.id) return;

    this.stop();
    this.startedForResearcherId = researcher.id;
    this.knownIds.clear();
    this.poll(true);
    this.pollHandle = setInterval(() => this.poll(false), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.startedForResearcherId = null;
    this.unreadCount.set(0);
    this.items.set([]);
  }

  private async poll(isFirstLoad: boolean): Promise<void> {
    try {
      const list = await this.api.getNotifications();
      this.items.set(list);
      this.unreadCount.set(list.filter((n) => !n.isRead).length);

      if (!isFirstLoad) {
        // Toast only unread items whose id we haven't seen in a previous poll — first load just
        // primes knownIds silently (a fresh login shouldn't toast every historical unread item
        // at once).
        for (const n of list) {
          if (!n.isRead && !this.knownIds.has(n.id)) {
            this.toast.show(n.message);
          }
        }
      }
      this.knownIds = new Set(list.map((n) => n.id));
    } catch {
      // A transient poll failure just tries again next interval — no dedicated error UI for a
      // background poll.
    }
  }

  async markRead(id: number): Promise<void> {
    await this.api.markNotificationRead(id);
    this.items.set(this.items().map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    this.unreadCount.set(this.items().filter((n) => !n.isRead).length);
  }

  async markAllRead(): Promise<void> {
    await this.api.markAllNotificationsRead();
    this.items.set(this.items().map((n) => ({ ...n, isRead: true })));
    this.unreadCount.set(0);
  }
}
