import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import { SelectComponent, SelectOption } from '../select/select.component';

const COLORS = ['#e5484d', '#f08c00', '#d4a017', '#2f9e44', '#339af0', '#9c6ade', '#e64980', '#868e96'];

/**
 * Rich-text editor for the consent sections (TipTap on ProseMirror): headings, bold / italic / underline / strike,
 * fonts, sizes, colours, bulleted and numbered lists, quotes, alignment, links. The value is HTML; the server
 * re-sanitizes it with an allow-list that matches exactly what this toolbar can produce.
 */
@Component({
  selector: 'app-rich-text-editor',
  standalone: true,
  imports: [TranslateModule, SelectComponent],
  template: `
    <div class="rt" [class.rt--disabled]="disabled()">
      @if (!disabled()) {
        <div class="rt-toolbar" role="toolbar" [attr.aria-label]="'RICH.TOOLBAR' | translate">
          <div class="rt-group">
            <app-select class="rt-select rt-select--block" [options]="blockOptions()" [value]="blockValue()" (valueChange)="setBlock($event)"></app-select>
          </div>
          <div class="rt-group">
            <button type="button" class="rt-btn rt-btn--bold" [class.rt-btn--on]="on('bold')" [title]="'RICH.BOLD' | translate" (mousedown)="$event.preventDefault()" (click)="run('toggleBold')">B</button>
            <button type="button" class="rt-btn rt-btn--italic" [class.rt-btn--on]="on('italic')" [title]="'RICH.ITALIC' | translate" (mousedown)="$event.preventDefault()" (click)="run('toggleItalic')">I</button>
            <button type="button" class="rt-btn rt-btn--underline" [class.rt-btn--on]="on('underline')" [title]="'RICH.UNDERLINE' | translate" (mousedown)="$event.preventDefault()" (click)="run('toggleUnderline')">U</button>
            <button type="button" class="rt-btn rt-btn--strike" [class.rt-btn--on]="on('strike')" [title]="'RICH.STRIKE' | translate" (mousedown)="$event.preventDefault()" (click)="run('toggleStrike')">S</button>
            <div class="rt-pop-wrap">
              <button type="button" class="rt-btn rt-btn--color" [class.rt-btn--on]="panel() === 'color'" [title]="'RICH.COLOR' | translate" (mousedown)="$event.preventDefault()" (click)="togglePanel('color')">
                <span class="rt-color-a">A</span><span class="rt-color-bar" [style.background]="currentColor() || 'var(--color-text)'"></span>
              </button>
              @if (panel() === 'color') {
                <div class="rt-pop rt-pop--colors">
                  @for (c of colors; track c) {
                    <button type="button" class="rt-swatch" [style.background]="c" [attr.aria-label]="c" (mousedown)="$event.preventDefault()" (click)="setColor(c)"></button>
                  }
                  <button type="button" class="rt-swatch-reset" (mousedown)="$event.preventDefault()" (click)="setColor('')">{{ 'RICH.COLOR_RESET' | translate }}</button>
                </div>
              }
            </div>
          </div>
          <div class="rt-group">
            <button type="button" class="rt-btn" [class.rt-btn--on]="on('bulletList')" [title]="'RICH.BULLETS' | translate" (mousedown)="$event.preventDefault()" (click)="run('toggleBulletList')">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><circle cx="3" cy="4" r="1.4" /><circle cx="3" cy="9" r="1.4" /><circle cx="3" cy="14" r="1.4" /><path d="M7 4h9M7 9h9M7 14h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" /></svg>
            </button>
            <button type="button" class="rt-btn" [class.rt-btn--on]="on('orderedList')" [title]="'RICH.NUMBERS' | translate" (mousedown)="$event.preventDefault()" (click)="run('toggleOrderedList')">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><text x="0" y="6" font-size="6" font-weight="700">1</text><text x="0" y="11" font-size="6" font-weight="700">2</text><text x="0" y="16" font-size="6" font-weight="700">3</text><path d="M7 4h9M7 9h9M7 14h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" /></svg>
            </button>
            <button type="button" class="rt-btn" [class.rt-btn--on]="on('blockquote')" [title]="'RICH.QUOTE' | translate" (mousedown)="$event.preventDefault()" (click)="run('toggleBlockquote')">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 3v12" stroke="currentColor" stroke-width="2" stroke-linecap="round" /><path d="M7 5h9M7 9h9M7 13h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
            </button>
          </div>
          <div class="rt-group">
            <button type="button" class="rt-btn" [class.rt-btn--on]="isAlign('left')" [title]="'RICH.ALIGN_LEFT' | translate" (mousedown)="$event.preventDefault()" (click)="align('left')">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2 4h14M2 8h9M2 12h14M2 16h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
            </button>
            <button type="button" class="rt-btn" [class.rt-btn--on]="isAlign('center')" [title]="'RICH.ALIGN_CENTER' | translate" (mousedown)="$event.preventDefault()" (click)="align('center')">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2 4h14M5 8h8M2 12h14M5 16h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
            </button>
            <button type="button" class="rt-btn" [class.rt-btn--on]="isAlign('right')" [title]="'RICH.ALIGN_RIGHT' | translate" (mousedown)="$event.preventDefault()" (click)="align('right')">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2 4h14M7 8h9M2 12h14M7 16h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
            </button>
            <button type="button" class="rt-btn" [class.rt-btn--on]="isAlign('justify')" [title]="'RICH.ALIGN_JUSTIFY' | translate" (mousedown)="$event.preventDefault()" (click)="align('justify')">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2 4h14M2 8h14M2 12h14M2 16h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
            </button>
          </div>
          <div class="rt-group">
            <div class="rt-pop-wrap">
              <button type="button" class="rt-btn" [class.rt-btn--on]="on('link') || panel() === 'link'" [title]="'RICH.LINK' | translate" (mousedown)="$event.preventDefault()" (click)="openLink()">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M7.5 10.5l3-3M6.2 8.3L4.7 9.8a2.6 2.6 0 003.7 3.7l1.5-1.5M11.8 9.7l1.5-1.5a2.6 2.6 0 00-3.7-3.7L8.1 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>
              @if (panel() === 'link') {
                <div class="rt-pop rt-pop--link">
                  <input #linkInput class="rt-link-input" type="url" placeholder="https://" [value]="linkUrl()" (input)="linkUrl.set($any($event.target).value)" (keydown.enter)="applyLink($event)" />
                  <button type="button" class="rt-link-btn rt-link-btn--primary" [disabled]="!linkValid()" (click)="applyLink($event)">{{ 'RICH.LINK_APPLY' | translate }}</button>
                  @if (on('link')) { <button type="button" class="rt-link-btn" (click)="removeLink()">{{ 'RICH.LINK_REMOVE' | translate }}</button> }
                </div>
              }
            </div>
            <button type="button" class="rt-btn rt-btn--text" [title]="'RICH.CLEAR' | translate" (mousedown)="$event.preventDefault()" (click)="clearFormatting()">Tx</button>
            <button type="button" class="rt-btn" [disabled]="!canUndo()" [title]="'RICH.UNDO' | translate" (mousedown)="$event.preventDefault()" (click)="run('undo')">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M6 4L3 7l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /><path d="M3 7h7a4 4 0 010 8H7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
            </button>
            <button type="button" class="rt-btn" [disabled]="!canRedo()" [title]="'RICH.REDO' | translate" (mousedown)="$event.preventDefault()" (click)="run('redo')">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M12 4l3 3-3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /><path d="M15 7H8a4 4 0 000 8h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
            </button>
          </div>
        </div>
      }
      <div #host class="rt-editor rich-content" [style.min-height.px]="minHeight()"></div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rt { border: 1px solid var(--color-border-strong); border-radius: var(--radius-input); background: var(--color-surface); }
    .rt:focus-within { border-color: var(--color-accent); box-shadow: var(--shadow-focus); }
    .rt--disabled { opacity: 0.7; }
    .rt-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 8px 10px; border-bottom: 1px solid var(--color-border); background: var(--color-surface-alt); border-radius: var(--radius-input) var(--radius-input) 0 0; }
    .rt-group { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
    .rt-select { display: block; }
    .rt-select--block { width: 132px; }
    .rt-btn {
      min-width: 30px; height: 30px; padding: 0 6px; display: inline-flex; align-items: center; justify-content: center; gap: 2px; flex-direction: column;
      background: transparent; border: 1px solid transparent; border-radius: 8px; color: var(--color-text); cursor: pointer;
      font-family: var(--font-body); font-size: 14px; line-height: 1;
    }
    .rt-btn:hover:not(:disabled) { background: var(--color-bg); border-color: var(--color-border-strong); }
    .rt-btn:disabled { opacity: 0.35; cursor: default; }
    .rt-btn--on { background: rgba(var(--color-accent-rgb), 0.14); border-color: rgba(var(--color-accent-rgb), 0.5); color: var(--color-accent); }
    .rt-btn--bold { font-weight: 800; }
    .rt-btn--italic { font-style: italic; font-family: Georgia, serif; }
    .rt-btn--underline { text-decoration: underline; }
    .rt-btn--strike { text-decoration: line-through; }
    .rt-btn--text { font-size: 12px; font-weight: 600; }
    .rt-btn--color { gap: 3px; }
    .rt-color-a { font-weight: 700; font-size: 14px; line-height: 1; }
    .rt-color-bar { width: 16px; height: 3px; border-radius: 2px; }
    .rt-pop-wrap { position: relative; }
    .rt-pop {
      position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; display: flex; align-items: center; gap: 6px; padding: 8px;
      background: var(--color-surface); border: 1px solid var(--color-border-strong); border-radius: var(--radius-input); box-shadow: var(--shadow-elevated);
    }
    .rt-pop--colors { flex-wrap: wrap; width: 196px; }
    .rt-swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--color-surface); box-shadow: 0 0 0 1px var(--color-border-strong); cursor: pointer; padding: 0; }
    .rt-swatch:hover { transform: scale(1.12); }
    .rt-swatch-reset { flex-basis: 100%; padding: 5px 8px; background: transparent; border: 1px solid var(--color-border-strong); border-radius: 8px; color: var(--color-text-secondary); font-size: 12px; cursor: pointer; font-family: var(--font-body); }
    .rt-pop--link { width: 330px; }
    .rt-link-input { flex: 1; min-width: 0; padding: 7px 9px; background: var(--color-bg); border: 1px solid var(--color-border-strong); border-radius: 8px; color: var(--color-text); font-family: var(--font-body); font-size: 13px; }
    .rt-link-input:focus { outline: none; border-color: var(--color-accent); box-shadow: var(--shadow-focus); }
    .rt-link-btn { padding: 7px 10px; background: transparent; border: 1px solid var(--color-border-strong); border-radius: 8px; color: var(--color-text); font-size: 12px; cursor: pointer; font-family: var(--font-body); white-space: nowrap; }
    .rt-link-btn--primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-on-accent); }
    .rt-link-btn:disabled { opacity: 0.45; cursor: default; }
    .rt-editor { padding: 14px 16px; max-height: 52vh; overflow-y: auto; }
  `],
})
export class RichTextEditorComponent implements AfterViewInit, OnDestroy {
  private translate = inject(TranslateService);

  /** The HTML to edit. Changes made by the user come out through `valueChange`; this input is only read when it differs from them. */
  readonly value = input('');
  readonly disabled = input(false);
  readonly minHeight = input(220);
  readonly valueChange = output<string>();

  @ViewChild('host', { static: true }) private host!: ElementRef<HTMLElement>;
  @ViewChild('linkInput') private linkInput?: ElementRef<HTMLInputElement>;

  private editor: Editor | null = null;
  private lastEmitted: string | null = null;
  /** Bumped on every editor transaction so the toolbar re-reads what is active at the cursor. */
  private readonly tick = signal(0);
  private readonly lang = signal(this.translate.currentLang || 'sr');

  readonly colors = COLORS;
  readonly panel = signal<'color' | 'link' | null>(null);
  readonly linkUrl = signal('');
  readonly linkValid = computed(() => /^(https?:\/\/|mailto:)\S+$/i.test(this.linkUrl().trim()));

  readonly blockOptions = computed<SelectOption[]>(() => {
    this.lang();
    return [
      { value: 'p', label: this.translate.instant('RICH.PARAGRAPH') },
      { value: 'h2', label: this.translate.instant('RICH.HEADING') },
      { value: 'h3', label: this.translate.instant('RICH.SUBHEADING') },
    ];
  });

  readonly blockValue = computed(() => {
    this.tick();
    const e = this.editor;
    return !e ? 'p' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p';
  });
  readonly currentColor = computed(() => {
    this.tick();
    return (this.editor?.getAttributes('textStyle')['color'] as string | undefined) ?? '';
  });
  readonly canUndo = computed(() => { this.tick(); return !!this.editor?.can().undo(); });
  readonly canRedo = computed(() => { this.tick(); return !!this.editor?.can().redo(); });

  constructor() {
    this.translate.onLangChange.subscribe((e) => this.lang.set(e.lang));
    effect(() => {
      const v = this.value();
      untracked(() => this.applyExternal(v));
    });
    effect(() => {
      const off = this.disabled();
      untracked(() => this.editor?.setEditable(!off));
    });
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    if (this.panel() && !(event.target as HTMLElement).closest('.rt-pop-wrap')) this.panel.set(null);
  }

  ngAfterViewInit(): void {
    this.editor = new Editor({
      element: this.host.nativeElement,
      content: this.value() || '',
      editable: !this.disabled(),
      extensions: [
        StarterKit.configure({ heading: { levels: [2, 3] }, code: false, codeBlock: false }),
        Underline,
        TextStyle,
        Color,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Link.configure({ openOnClick: false, autolink: false, protocols: ['mailto'], HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } }),
      ],
      onTransaction: () => this.tick.update((n) => n + 1),
      onUpdate: ({ editor }) => {
        const html = editor.isEmpty ? '' : editor.getHTML();
        this.lastEmitted = html;
        this.valueChange.emit(html);
      },
    });
    this.tick.update((n) => n + 1);
  }

  ngOnDestroy(): void {
    this.editor?.destroy();
    this.editor = null;
  }

  private applyExternal(v: string): void {
    if (!this.editor || v === this.lastEmitted) return;
    const current = this.editor.isEmpty ? '' : this.editor.getHTML();
    if (v === current) return;
    this.editor.commands.setContent(v || '', false);
    this.lastEmitted = v;
  }

  // ---- toolbar -----------------------------------------------------------------------------------------------------

  on(name: string): boolean {
    this.tick();
    return !!this.editor?.isActive(name);
  }

  isAlign(a: string): boolean {
    this.tick();
    return !!this.editor?.isActive({ textAlign: a });
  }

  run(command: string): void {
    this.panel.set(null);
    (this.editor?.chain().focus() as unknown as Record<string, () => { run: () => boolean }>)[command]().run();
  }

  align(a: string): void {
    this.editor?.chain().focus().setTextAlign(a).run();
  }

  setBlock(value: string | number): void {
    const chain = this.editor?.chain().focus();
    if (!chain) return;
    if (value === 'h2') chain.setHeading({ level: 2 }).run();
    else if (value === 'h3') chain.setHeading({ level: 3 }).run();
    else chain.setParagraph().run();
  }

  togglePanel(p: 'color' | 'link'): void {
    this.panel.set(this.panel() === p ? null : p);
  }

  setColor(color: string): void {
    const chain = this.editor?.chain().focus();
    if (!chain) return;
    if (color) chain.setColor(color).run();
    else chain.unsetColor().removeEmptyTextStyle().run();
    this.panel.set(null);
  }

  openLink(): void {
    if (this.panel() === 'link') { this.panel.set(null); return; }
    this.linkUrl.set((this.editor?.getAttributes('link')['href'] as string | undefined) ?? '');
    this.panel.set('link');
    setTimeout(() => this.linkInput?.nativeElement.focus());
  }

  applyLink(event: Event): void {
    event.preventDefault();
    if (!this.linkValid()) return;
    this.editor?.chain().focus().extendMarkRange('link').setLink({ href: this.linkUrl().trim() }).run();
    this.panel.set(null);
  }

  removeLink(): void {
    this.editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    this.panel.set(null);
  }

  clearFormatting(): void {
    this.panel.set(null);
    this.editor?.chain().focus().unsetAllMarks().clearNodes().unsetTextAlign().run();
  }
}
