import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, effect, input, output } from '@angular/core';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { r } from '@codemirror/legacy-modes/mode/r';

/**
 * A thin Angular wrapper around a CodeMirror 6 `EditorView` — Part H of the platform
 * re-architecture (2026-09-07). Deliberately minimal (no theme package, no autocomplete): this
 * is a plain-text-with-R-syntax-highlighting editor for a script that gets uploaded/run
 * server-side, not a full IDE. `[content]`/`(contentChange)` bindings, same shape as any other
 * Angular form control this codebase already writes by hand (e.g. app-select).
 */
@Component({
  selector: 'app-r-script-editor',
  standalone: true,
  template: `<div #host class="r-editor-host"></div>`,
  styleUrl: './r-script-editor.component.scss',
})
export class RScriptEditorComponent implements AfterViewInit, OnDestroy {
  readonly content = input('');
  readonly contentChange = output<string>();

  @ViewChild('host', { static: true }) hostRef!: ElementRef<HTMLDivElement>;

  private view: EditorView | null = null;
  private viewReady = false;

  constructor() {
    // Only replace the document when `content` changes from OUTSIDE this editor (e.g. a fresh
    // file upload) — not on every keystroke, which would fight the user's own cursor position.
    effect(() => {
      const incoming = this.content();
      if (!this.viewReady || !this.view) return;
      if (incoming !== this.view.state.doc.toString()) {
        this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: incoming } });
      }
    });
  }

  ngAfterViewInit(): void {
    const state = EditorState.create({
      doc: this.content(),
      extensions: [
        lineNumbers(),
        history(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        StreamLanguage.define(r),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.contentChange.emit(update.state.doc.toString());
        }),
      ],
    });
    this.view = new EditorView({ state, parent: this.hostRef.nativeElement });
    this.viewReady = true;
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }
}
