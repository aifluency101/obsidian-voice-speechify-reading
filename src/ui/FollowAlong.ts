import { MarkdownView, Notice, type App } from "obsidian";
import { ReadingHighlighter } from "./ReadingHighlight";
import { PreviewHighlighter } from "./PreviewHighlighter";
import type { PreviewSectionRegistry } from "./previewSections";
import type { FollowAlongDiagnostics } from "../utils/followAlongDiagnostics";

/**
 * Routes follow-along highlighting to whichever mechanism the note is using.
 *
 * Obsidian renders a note two different ways and neither technique works for
 * both: Editing view is a CodeMirror document and takes decorations, Reading
 * view is rendered HTML and takes CSS Custom Highlight ranges. The mode is
 * decided once per reading pass, since changing view mid-note re-renders
 * everything anyway.
 */
export class FollowAlongHighlighter {
  private editor: ReadingHighlighter;
  private preview: PreviewHighlighter;
  private mode: "editor" | "preview" | null = null;
  private warnedUnsupported = false;
  private failedStarts = 0;

  constructor(
    private app: App,
    sections: PreviewSectionRegistry,
    private diagnostics: FollowAlongDiagnostics,
  ) {
    this.editor = new ReadingHighlighter(app);
    this.preview = new PreviewHighlighter(sections, diagnostics);
  }

  /**
   * Active means "a highlight has actually appeared", not merely "setup ran".
   * The caller retries while inactive, and treating a silent failure as active
   * is what left a whole note reading with nothing highlighted until something
   * unrelated — opening the player — happened to reset the state.
   */
  /** True once a highlight has actually appeared, not merely once setup ran. */
  get isActive(): boolean {
    if (this.mode === "editor") {
      return this.editor.isActive;
    }
    if (this.mode === "preview") {
      return this.preview.isActive;
    }
    return false;
  }

  start(): void {
    this.clear();

    // Not getActiveViewOfType alone: by the time reading begins the focus may
    // have moved to the player pane, leaving the note no longer "active".
    const view =
      this.app.workspace.getActiveViewOfType(MarkdownView) ??
      this.markdownViewForFile(this.app.workspace.getActiveFile()?.path);
    if (!view) {
      this.diagnostics.record("start", "no markdown view resolved");
      this.mode = null;
      return;
    }

    const viewMode = view.getMode();
    if (viewMode === "preview") {
      this.mode = this.preview.start(view) ? "preview" : null;
    } else {
      this.mode = this.editor.start(view) ? "editor" : null;
    }
    this.diagnostics.record(
      "start",
      `getMode=${viewMode} chose=${this.mode ?? "none"} file=${view.file?.path ?? "?"}`,
    );

    // Only complain once it is clearly not going to settle: the first passages
    // routinely arrive before the view mode and the rendered sections have.
    if (this.mode === null) {
      this.failedStarts++;
      if (this.failedStarts >= 5 && !this.warnedUnsupported) {
        this.warnedUnsupported = true;
        new Notice(
          "Voice: could not follow along in this note. Try Editing view.",
          6000,
        );
      }
    } else {
      this.failedStarts = 0;
    }
  }

  setPassage(passage: string): void {
    // Re-decide until something is actually highlighted. Two things commonly
    // are not settled when reading begins: the view's mode (the Reader Mode
    // plugin switches a note to Reading view after the leaf opens, so an early
    // reading of getMode() can be stale) and whether Obsidian has rendered any
    // sections yet. Both resolve within a passage or two, and re-running setup
    // is cheap now that it no longer touches the DOM.
    if (!this.isActive) {
      this.start();
    }
    if (this.mode === "editor") {
      this.editor.setPassage(passage);
    } else if (this.mode === "preview") {
      this.preview.setPassage(passage);
    }
  }

  setWord(word: string): void {
    if (this.mode === "editor") {
      this.editor.setWord(word);
    } else if (this.mode === "preview") {
      this.preview.setWord(word);
    }
  }

  rewind(): void {
    if (this.mode === "editor") {
      this.editor.rewind();
    } else if (this.mode === "preview") {
      this.preview.rewind();
    }
  }

  stop(): void {
    this.clear();
    this.mode = null;
    this.failedStarts = 0;
  }

  private clear(): void {
    this.editor.stop();
    this.preview.stop();
  }

  private markdownViewForFile(
    path: string | undefined | null,
  ): MarkdownView | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) {
        continue;
      }
      if (path && view.file?.path !== path) {
        continue;
      }
      return view;
    }
    return undefined;
  }
}
