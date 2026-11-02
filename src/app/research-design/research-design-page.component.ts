import { Component, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { TranslateModule } from '@ngx-translate/core';
import { ScopeService } from '../services/scope.service';
import { StudyConfigStoreService } from '../services/study-config-store.service';
import { LoadingSpinnerComponent } from '../shared/loading-spinner/loading-spinner.component';
import { DesignTypeSectionComponent } from './design-type-section.component';
import { DesignWarningsComponent } from './design-warnings.component';
import { GroupsSectionComponent } from './groups-section.component';
import { TasksSectionComponent } from './tasks-section.component';
import { ResearchDesignStore } from './research-design-store.service';
import { VariablesSectionComponent } from './variables-section.component';

/** "Nacrt istraživanja": the study type, variables and participant groups of the selected PROTOCOL research. */
@Component({
  selector: 'app-research-design-page',
  standalone: true,
  imports: [
    TranslateModule, LoadingSpinnerComponent, DesignTypeSectionComponent, VariablesSectionComponent,
    GroupsSectionComponent, TasksSectionComponent, DesignWarningsComponent,
  ],
  templateUrl: './research-design-page.component.html',
  styleUrl: './research-design-page.component.scss',
})
export class ResearchDesignPageComponent {
  private scope = inject(ScopeService);
  private studyConfigStore = inject(StudyConfigStoreService);
  readonly store = inject(ResearchDesignStore);

  constructor() {
    toObservable(this.scope.selectedResearchId).subscribe((id) => {
      if (id != null) this.store.load(id);
    });
  }

  async save(): Promise<void> {
    const id = this.store.researchId();
    if (id == null) return;
    if (await this.store.save()) await this.studyConfigStore.refresh(id);
  }
}
