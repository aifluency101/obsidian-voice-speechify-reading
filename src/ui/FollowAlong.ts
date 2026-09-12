import { MarkdownView, Notice, type App } from "obsidian";
import { ReadingHighlighter } from "./ReadingHighlight";
import { PreviewHighlighter } from "./PreviewHighlighter";

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

  constructor(private app: App) {
    this.editor = new ReadingHighlighter(app);
    this.preview = new PreviewHighlighter();
  }

  get isActive(): boolean {
    return this.mode !== null;
  }

  start(): void {
    this.clear();

    // Not getActiveViewOfType alone: by the time reading begins the focus may
    // have moved to the player pane, leaving the note no longer "active".
    const view =
      this.app.workspace.getActiveViewOfType(MarkdownView) ??
      this.markdownViewForFile(this.app.workspace.getActiveFile()?.path);
    if (!view) {
      this.mode = null;
      return;
    }

    if (view.getMode() === "preview") {
      this.mode = this.preview.start(view) ? "preview" : null;
    } else {
      this.mode = this.editor.start(view) ? "editor" : null;
    }

    if (this.mode === null && !this.warnedUnsupported) {
      this.warnedUnsupported = true;
      new Notice(
        "Voice: could not follow along in this note. Try Editing view.",
        6000,
      );
    }
  }

  setPassage(passage: string): void {
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
