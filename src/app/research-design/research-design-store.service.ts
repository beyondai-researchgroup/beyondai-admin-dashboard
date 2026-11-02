import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AdminApiService,
  AssignmentMode,
  ResearchDesignData,
  ResearchGroupData,
  ResearchTaskData,
  ResearchVariableData,
  VariableRole,
} from '../services/admin-api.service';

export const EMPTY_DESIGN: ResearchDesignData = {
  approach: null,
  subjectDesign: null,
  timeDimension: null,
  factorStructure: null,
  controlCondition: null,
  blinding: null,
  assignmentMode: 'MANUAL',
  hypotheses: null,
  notes: null,
};

/** A soft remark about the design (never blocks saving): i18n key under RESEARCH_DESIGN.WARN. */
export interface DesignWarning {
  key: string;
  level: 'warn' | 'info';
}

/**
 * Working copy of one research's design document (study type, variables, participant groups),
 * shared by the three section components, the /design page and the study wizard so they all edit the
 * same state and one save writes it. Loads per research id; save() sends the whole document.
 */
@Injectable({ providedIn: 'root' })
export class ResearchDesignStore {
  private api = inject(AdminApiService);

  readonly researchId = signal<number | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly notProtocol = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);
  /** i18n suffix under RESEARCH_DESIGN.ERR_* of the last failed save, or null. */
  readonly errorKey = signal<string | null>(null);

  readonly design = signal<ResearchDesignData>({ ...EMPTY_DESIGN });
  readonly variables = signal<ResearchVariableData[]>([]);
  readonly groups = signal<ResearchGroupData[]>([]);
  /** Study tasks (A / B ...): a second factor, balanced inside each group. */
  readonly tasks = signal<ResearchTaskData[]>([]);
  readonly participantCount = signal(0);
  readonly unassignedCount = signal(0);
  readonly unassignedTaskCount = signal(0);

  /** True when the saved/edited groups (or the study type) mean participants need a group. */
  readonly needsGroups = computed(() => {
    const s = this.design().subjectDesign;
    return s === 'BETWEEN' || s === 'MIXED' || this.groups().length > 0;
  });

  readonly warnings = computed<DesignWarning[]>(() => {
    const d = this.design();
    const out: DesignWarning[] = [];
    const hasIv = this.variables().some((v) => v.role === 'INDEPENDENT');
    const groups = this.groups().length;
    if (d.approach === 'EXPERIMENTAL' && this.variables().length > 0 && !hasIv) out.push({ key: 'NO_IV', level: 'warn' });
    if (d.approach === 'EXPERIMENTAL' && groups > 0 && d.assignmentMode !== 'RANDOM') out.push({ key: 'EXPERIMENTAL_RANDOM', level: 'warn' });
    if (d.approach === 'QUASI_EXPERIMENTAL' && d.assignmentMode === 'RANDOM') out.push({ key: 'QUASI_RANDOM', level: 'warn' });
    if ((d.subjectDesign === 'BETWEEN' || d.subjectDesign === 'MIXED') && groups < 2) out.push({ key: 'GROUPS_NEEDED', level: 'warn' });
    if ((d.approach === 'CORRELATIONAL' || d.approach === 'DESCRIPTIVE') && groups > 0) out.push({ key: 'GROUPS_NOT_USED', level: 'warn' });
    if ((d.subjectDesign === 'WITHIN' || d.timeDimension === 'CROSSOVER') && groups > 0) out.push({ key: 'WITHIN_GROUPS', level: 'info' });
    if (d.subjectDesign === 'WITHIN' || d.timeDimension === 'CROSSOVER') out.push({ key: 'NO_COUNTERBALANCING', level: 'info' });
    if (this.tasks().length === 1) out.push({ key: 'ONE_TASK', level: 'warn' });
    return out;
  });

  async load(researchId: number): Promise<void> {
    this.researchId.set(researchId);
    this.loading.set(true);
    this.loadError.set(false);
    this.notProtocol.set(false);
    this.saved.set(false);
    this.errorKey.set(null);
    try {
      const doc = await this.api.getResearchDesign(researchId);
      this.apply(doc);
    } catch (err: any) {
      if (err?.error?.error === 'NOT_PROTOCOL') this.notProtocol.set(true);
      else this.loadError.set(true);
      this.design.set({ ...EMPTY_DESIGN });
      this.variables.set([]);
      this.groups.set([]);
      this.tasks.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  private apply(doc: { design: ResearchDesignData; variables: ResearchVariableData[]; groups: ResearchGroupData[]; tasks?: ResearchTaskData[]; participantCount: number; unassignedCount: number; unassignedTaskCount?: number }): void {
    this.design.set({ ...doc.design });
    this.variables.set(doc.variables.map((v) => ({ ...v, levels: [...v.levels] })));
    this.groups.set(doc.groups.map((g) => ({ ...g })));
    this.tasks.set((doc.tasks ?? []).map((t) => ({ ...t })));
    this.participantCount.set(doc.participantCount);
    this.unassignedCount.set(doc.unassignedCount);
    this.unassignedTaskCount.set(doc.unassignedTaskCount ?? 0);
  }

  /** Saves the whole document. Returns true on success. */
  async save(): Promise<boolean> {
    const id = this.researchId();
    if (id == null || this.saving()) return false;
    this.saved.set(false);
    this.errorKey.set(null);
    const blank = this.firstBlankName();
    if (blank) {
      this.errorKey.set(blank);
      return false;
    }
    this.saving.set(true);
    try {
      const res = await this.api.saveResearchDesign(id, {
        design: this.design(),
        variables: this.variables().map((v) => ({ ...v, name: v.name.trim() })),
        groups: this.groups().map((g) => ({ ...g, name: g.name.trim(), weight: 1 })),
        tasks: this.tasks().map((t) => ({ ...t, name: t.name.trim(), weight: 1 })),
      });
      if (!res.ok) {
        const known = ['DUPLICATE_GROUP_NAME', 'GROUP_HAS_PARTICIPANTS', 'DUPLICATE_TASK_NAME', 'TASK_HAS_PARTICIPANTS', 'GROUP_HAS_TEMPLATES', 'TASK_HAS_TEMPLATES', 'NOT_PROTOCOL', 'INSUFFICIENT_ROLE'];
        const reason = known.includes(res.error) ? res.error : this.reasonFromMessage(res.error);
        this.errorKey.set(reason);
        return false;
      }
      this.apply(res.doc);
      this.saved.set(true);
      return true;
    } finally {
      this.saving.set(false);
    }
  }

  patchDesign(patch: Partial<ResearchDesignData>): void {
    this.design.update((d) => ({ ...d, ...patch }));
    this.saved.set(false);
  }

  setAssignmentMode(mode: AssignmentMode): void {
    this.patchDesign({ assignmentMode: mode });
  }

  // ── variables ──
  addVariable(role: VariableRole): void {
    this.variables.update((v) => [...v, { role, name: '', description: null, levels: [], measurement: null }]);
    this.saved.set(false);
  }
  patchVariable(index: number, patch: Partial<ResearchVariableData>): void {
    this.variables.update((v) => v.map((x, i) => (i === index ? { ...x, ...patch } : x)));
    this.saved.set(false);
  }
  removeVariable(index: number): void {
    this.variables.update((v) => v.filter((_, i) => i !== index));
    this.saved.set(false);
  }

  // ── groups ──
  addGroup(name = ''): void {
    this.groups.update((g) => [...g, { name, description: null, weight: 1, isControl: false }]);
    this.saved.set(false);
  }
  patchGroup(index: number, patch: Partial<ResearchGroupData>): void {
    this.groups.update((g) => g.map((x, i) => (i === index ? { ...x, ...patch } : x)));
    this.saved.set(false);
  }
  removeGroup(index: number): void {
    this.groups.update((g) => g.filter((_, i) => i !== index));
    this.saved.set(false);
  }

  // ── tasks ──
  addTask(name = ''): void {
    this.tasks.update((t) => [...t, { name, weight: 1 }]);
    this.saved.set(false);
  }
  patchTask(index: number, patch: Partial<ResearchTaskData>): void {
    this.tasks.update((t) => t.map((x, i) => (i === index ? { ...x, ...patch } : x)));
    this.saved.set(false);
  }
  removeTask(index: number): void {
    this.tasks.update((t) => t.filter((_, i) => i !== index));
    this.saved.set(false);
  }

  /** The independent variable's levels that do not yet have a group of the same name. */
  readonly missingLevelGroups = computed(() => {
    const have = new Set(this.groups().map((g) => g.name.trim().toLowerCase()));
    const iv = this.variables().find((v) => v.role === 'INDEPENDENT' && v.levels.length >= 2);
    return iv ? iv.levels.filter((l) => !have.has(l.trim().toLowerCase())) : [];
  });

  groupsFromLevels(): void {
    for (const level of this.missingLevelGroups()) this.addGroup(level);
  }

  /** A group, task or variable row with no name (an "add" that was never filled in) would be refused by the server; say which one. */
  private firstBlankName(): string | null {
    if (this.groups().some((g) => !g.name.trim())) return 'EMPTY_GROUP_NAME';
    if (this.tasks().some((t) => !t.name.trim())) return 'EMPTY_TASK_NAME';
    if (this.variables().some((v) => !v.name.trim())) return 'EMPTY_VARIABLE_NAME';
    return null;
  }

  /** The server's plain-text 400 answers, mapped to the closest message; anything else stays the generic one. */
  private reasonFromMessage(message: string | undefined): string {
    const m = message ?? '';
    if (/Each group needs a name/.test(m)) return 'EMPTY_GROUP_NAME';
    if (/Each task needs a name/.test(m)) return 'EMPTY_TASK_NAME';
    if (/Each variable needs a name/.test(m)) return 'EMPTY_VARIABLE_NAME';
    return 'SERVER_ERROR';
  }
}
