import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { ProtocolStep } from '../services/admin-api.service';
import { ProtocolFlowComponent } from '../protocol/protocol-flow.component';
import { AdminApiService } from '../services/admin-api.service';
import { ResearchesStoreService } from '../services/researches-store.service';
import { ScopeService } from '../services/scope.service';
import { StudyConfigStoreService } from '../services/study-config-store.service';
import { ProtocolComponent } from '../protocol/protocol.component';
import { DesignTypeSectionComponent } from '../research-design/design-type-section.component';
import { DesignWarningsComponent } from '../research-design/design-warnings.component';
import { GroupsSectionComponent } from '../research-design/groups-section.component';
import { TasksSectionComponent } from '../research-design/tasks-section.component';
import { ResearchDesignStore } from '../research-design/research-design-store.service';
import { VariablesSectionComponent } from '../research-design/variables-section.component';

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;
const STEPS: WizardStep[] = [1, 2, 3, 4, 5, 6];
const STEP_KEYS: Record<WizardStep, string> = {
  1: 'STEP_BASICS', 2: 'STEP_DESIGN', 3: 'STEP_VARIABLES', 4: 'STEP_GROUPS', 5: 'STEP_PROTOCOL', 6: 'STEP_DONE',
};

/**
 * Guided setup of a new research (superadmin): basics, study type, variables (skippable), groups,
 * protocol steps, review. The research is created when the first step is confirmed (the protocol and
 * its questionnaires belong to a research, so it has to exist) but is flagged "not set up yet" until
 * the wizard is finished; an unfinished one can be continued from the Researches list. Steps 2-5
 * reuse the same components as the /design and /protocol pages.
 */
@Component({
  selector: 'app-study-wizard',
  standalone: true,
  imports: [
    ReactiveFormsModule, RouterLink, TranslateModule, ProtocolComponent, DesignTypeSectionComponent,
    VariablesSectionComponent, GroupsSectionComponent, TasksSectionComponent, DesignWarningsComponent, ProtocolFlowComponent,
  ],
  templateUrl: './study-wizard.component.html',
  styleUrl: './study-wizard.component.scss',
})
export class StudyWizardComponent {
  private readonly protocolEditor = viewChild(ProtocolComponent);
  private fb = inject(FormBuilder);
  private api = inject(AdminApiService);
  private scope = inject(ScopeService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private researchesStore = inject(ResearchesStoreService);
  readonly studyConfig = inject(StudyConfigStoreService);
  readonly design = inject(ResearchDesignStore);

  readonly steps = STEPS;
  readonly stepKey = (s: WizardStep) => STEP_KEYS[s];

  readonly step = signal<WizardStep>(1);
  readonly researchId = signal<number | null>(null);
  readonly busy = signal(false);
  readonly errorKey = signal<string | null>(null);
  readonly finished = signal(false);
  /** The saved protocol, loaded when the review opens (the diagram needs titles, delays and task settings). */
  readonly protocolSteps = signal<ProtocolStep[]>([]);

  /** Where the research takes place, for the review header. */
  readonly place = computed(() =>
    [this.form.value.university, this.form.value.city, this.form.value.country].map((x) => (x ?? '').trim()).filter(Boolean).join(' · '));

  /** The study type as label/value rows; a null value is shown as "not specified". */
  readonly designRows = computed(() => {
    const d = this.design.design();
    return [
      { label: 'FIELD_APPROACH', value: d.approach ? 'APPROACH.' + d.approach : null },
      { label: 'FIELD_SUBJECT', value: d.subjectDesign ? 'SUBJECT.' + d.subjectDesign : null },
      { label: 'FIELD_TIME', value: d.timeDimension ? 'TIME.' + d.timeDimension : null },
      { label: 'FIELD_FACTOR', value: d.factorStructure ? 'FACTOR.' + d.factorStructure : null },
      { label: 'FIELD_CONTROL', value: d.controlCondition ? 'CONTROL.' + d.controlCondition : null },
      { label: 'FIELD_BLINDING', value: d.blinding ? 'BLINDING.' + d.blinding : null },
    ];
  });


  form = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(150)]],
    description: ['', Validators.maxLength(2000)],
    university: ['', Validators.maxLength(200)],
    city: ['', Validators.maxLength(200)],
    country: ['', Validators.maxLength(200)],
  });

  /** The design says participants need groups (between / mixed) or groups already exist. */
  readonly groupsExpected = computed(() => this.design.needsGroups());

  constructor() {
    this.researchesStore.ensureLoaded();
    const q = this.route.snapshot.queryParamMap;
    const resumeId = Number(q.get('researchId'));
    if (Number.isInteger(resumeId) && resumeId > 0) void this.resume(resumeId, Number(q.get('step')));
  }

  private async resume(id: number, wantedStep: number): Promise<void> {
    this.busy.set(true);
    try {
      const r = await this.api.getResearch(id);
      this.form.setValue({
        name: r.name,
        description: r.description ?? '',
        university: r.university ?? '',
        city: r.city ?? '',
        country: r.country ?? '',
      });
      this.researchId.set(id);
      this.scope.select(id);
      await this.design.load(id);
      await this.studyConfig.load(id);
      this.step.set((wantedStep >= 2 && wantedStep <= 6 ? wantedStep : 2) as WizardStep);
      if (this.step() === 6) await this.loadProtocol(id);
    } catch {
      this.errorKey.set('ERR_LOAD');
    } finally {
      this.busy.set(false);
    }
  }

  private async loadProtocol(id: number): Promise<void> {
    try {
      this.protocolSteps.set((await this.api.getProtocol(id)).steps);
    } catch {
      this.protocolSteps.set([]);
    }
  }

  private clearError(): void {
    this.errorKey.set(null);
  }

  goTo(step: WizardStep): void {
    // Only already-reachable steps are clickable: nothing past step 1 exists before the research does.
    if (this.researchId() == null && step !== 1) return;
    this.clearError();
    this.step.set(step);
  }

  back(): void {
    const s = this.step();
    if (s > 1) this.goTo((s - 1) as WizardStep);
  }

  /** Step 1: create the research (first time) or update its basics, then load the design. */
  async confirmBasics(): Promise<void> {
    if (this.form.invalid || this.busy()) return;
    this.busy.set(true);
    this.clearError();
    const v = this.form.value;
    const body = {
      name: v.name!.trim(),
      description: v.description?.trim() || null,
      university: v.university?.trim() || null,
      city: v.city?.trim() || null,
      country: v.country?.trim() || null,
    };
    try {
      let id = this.researchId();
      if (id == null) {
        const created = await this.api.createResearch({ ...body, flowMode: 'PROTOCOL', setupComplete: false });
        id = created.id;
        this.researchId.set(id);
        this.scope.select(id);
        await this.researchesStore.reload();
        await this.studyConfig.load(id);
      } else {
        await this.api.updateResearch(id, body);
        await this.researchesStore.reload();
      }
      await this.design.load(id);
      this.step.set(2);
    } catch {
      this.errorKey.set('ERR_CREATE');
    } finally {
      this.busy.set(false);
    }
  }

  /** Steps 2-4: write the design document, then move on. */
  async saveAndNext(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.clearError();
    try {
      if (await this.design.save()) {
        const id = this.researchId();
        if (id != null) await this.studyConfig.refresh(id);
        this.step.set((this.step() + 1) as WizardStep);
      } else {
        this.errorKey.set('ERR_DESIGN');
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** Step 3 can be skipped without writing anything. */
  skipVariables(): void {
    this.clearError();
    this.step.set(4);
  }

  /** Step 5 -> 6: refresh what the protocol contains so the review is accurate. */
  async toReview(): Promise<void> {
    const id = this.researchId();
    // The editor saves on its own after a short pause; make sure the last edit is in before it is read back.
    await this.protocolEditor()?.flush();
    if (id != null) {
      await this.studyConfig.refresh(id);
      await this.loadProtocol(id);
    }
    this.clearError();
    this.step.set(6);
  }

  async finish(): Promise<void> {
    const id = this.researchId();
    if (id == null || this.busy()) return;
    this.busy.set(true);
    this.clearError();
    try {
      if (await this.api.completeResearchSetup(id)) {
        await this.researchesStore.reload();
        await this.studyConfig.refresh(id);
        this.finished.set(true);
      } else {
        this.errorKey.set('ERR_FINISH');
      }
    } finally {
      this.busy.set(false);
    }
  }

  open(path: string): void {
    void this.router.navigate([path]);
  }
}
