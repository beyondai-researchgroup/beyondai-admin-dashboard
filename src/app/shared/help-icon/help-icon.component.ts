import { Component, HostListener, input, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

/**
 * A small "?" button that opens a modal with additional information, instead of a permanent
 * hint paragraph sitting under a section heading (follow-up request, 2026-09-07 — "throughout
 * the app, descriptions shouldn't sit below the section heading; put a small question-mark icon
 * next to it that opens a popup, like NASA-TLX does"). Generalizes the multi-topic help modal
 * `pr-review-task.component` originally had (its own 3-topic `@switch`, since folded into this
 * shared component too) plus the old bespoke Calendar-connect help modal
 * (`configuration.component`'s `showCalendarHelp`) into one consistent, drop-in-anywhere shape.
 *
 * Two content shapes, combinable: a short intro (projected via `<ng-content>` — a plain
 * paragraph, or nothing at all) and, when the topic involves connecting something (a Google
 * account, a token, ...), a proper numbered `steps` list rendered with real styled badges
 * (never a bare `<ol>` relying on the browser's own list-marker rendering — that's what made the
 * very first version of this component look unpolished). An optional trailing `note` covers a
 * caveat worth calling out separately (e.g. what to do if Google blocks access).
 *
 * Usage: place as a sibling of the heading text inside the same `<h3 class="raw-heading">` (or
 * `form-heading`) element, with an extra `heading-with-help` class on that element for the flex
 * layout — see configuration.component.html for the established call shape:
 * `<h3 class="raw-heading heading-with-help">{{ 'X.HEADING' | translate }}
 *    <app-help-icon [title]="'X.HEADING' | translate" [steps]="[...]" [note]="'...'">
 *      <p>{{ 'X.HINT' | translate }}</p>
 *    </app-help-icon>
 * </h3>`
 */
@Component({
  selector: 'app-help-icon',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './help-icon.component.html',
  styleUrl: './help-icon.component.scss',
})
export class HelpIconComponent {
  readonly title = input.required<string>();
  readonly ariaLabel = input<string>();
  readonly steps = input<string[]>();
  readonly note = input<string>();

  readonly open = signal(false);

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.open.set(false);
  }
}
