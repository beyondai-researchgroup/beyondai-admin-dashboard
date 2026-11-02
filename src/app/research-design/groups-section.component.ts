import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { AssignmentMode } from '../services/admin-api.service';
import { ResearchDesignStore } from './research-design-store.service';

/**
 * Participant groups (e.g. control and treatment) and how participants are put into them: by the
 * researcher or at random by the platform. The protocol is the same for every group — a group is a
 * label used to compare participants in the analysis and the exports.
 */
@Component({
  selector: 'app-groups-section',
  standalone: true,
  imports: [FormsModule, TranslateModule],
  templateUrl: './groups-section.component.html',
  styleUrl: './research-design-sections.scss',
})
export class GroupsSectionComponent {
  readonly store = inject(ResearchDesignStore);
  /** Unique radio ids so the section can appear more than once in the DOM without clashes. */
  readonly uid = Math.random().toString(36).slice(2, 8);

  setMode(mode: AssignmentMode): void {
    this.store.setAssignmentMode(mode);
  }

  /** A group that already has participants cannot be removed (the server refuses it too). */
  canRemove(i: number): boolean {
    return !(this.store.groups()[i].participantCount ?? 0);
  }
}
