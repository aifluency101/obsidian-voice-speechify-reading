import { MarkdownView, Notice } from "obsidian";
import { SourceMatcher, tokenizeSpoken } from "../utils/sourceWords";
import {
  buildTextIndex,
  rangeFromOffsets,
  type TextIndex,
} from "./domTextIndex";

/**
 * Follow-along highlighting in Reading view.
 *
 * Reading view is rendered HTML, not a CodeMirror document, so the editor's
 * decorations cannot apply. This uses the CSS Custom Highlight API instead:
 * DOM Ranges are registered under a name and styled with ::highlight(), which
 * paints them without touching the DOM — important, because Obsidian owns that
 * DOM and re-renders it.
 *
 * Two consequences of how Reading view works shape this:
 *
 * - Only sections near the viewport are rendered, so a passage further down the
 *   note may not exist in the DOM yet. The index is therefore rebuilt on every
 *   passage, and a miss is retried once after the scroll has had a chance to
 *   bring more of the note into being.
 * - Because the rendered text *is* what gets spoken (no markup, no link
 *   targets), matching here is markedly more reliable than against markdown.
 */

const PASSAGE_HIGHLIGHT = "voice-reading-passage";
const WORD_HIGHLIGHT = "voice-reading-word";

/** `Highlight` and `CSS.highlights` are newer than the TS DOM lib in use. */
interface HighlightRegistry {
  set(name: string, highlight: object): void;
  delete(name: string): void;
}
type HighlightConstructor = new (...ranges: Range[]) => object;

function highlightRegistry(): HighlightRegistry | undefined {
  const registry = (CSS as unknown as { highlights?: HighlightRegistry })
    .highlights;
  return registry && typeof Highlight !== "undefined" ? registry : undefined;
}

declare const Highlight: HighlightConstructor | undefined;

export class PreviewHighlighter {
  private container?: Element;
  private index?: TextIndex;
  private matcher?: SourceMatcher;
  private passageRange: { from: number; to: number } | null = null;
  private wordMatcher?: SourceMatcher;
  private lastPassageText = "";
  private warnedUnsupported = false;
  private pendingRetry?: number;

  /** True once a reading pass has a rendered container to work against. */
  get isActive(): boolean {
    return !!this.container;
  }

  /**
   * Begin a pass over `view`, which must be in Reading view. Returns false when
   * this cannot work here, so the caller can fall back or explain.
   */
  start(view: MarkdownView): boolean {
    if (!highlightRegistry()) {
      if (!this.warnedUnsupported) {
        this.warnedUnsupported = true;
        new Notice(
          "Voice: this version of Obsidian cannot highlight in Reading view. Switch to Editing view to follow along.",
          6000,
        );
      }
      return false;
    }

    const container = view.contentEl.querySelector(".markdown-preview-view");
    if (!container) {
      return false;
    }
    this.container = container;
    this.index = undefined;
    this.matcher = undefined;
    this.passageRange = null;
    this.lastPassageText = "";
    this.refreshIndex();
    return true;
  }

  setPassage(spokenPassage: string): void {
    if (!this.container || spokenPassage === this.lastPassageText) {
      return;
    }
    this.lastPassageText = spokenPassage;
    this.clearRetry();
    if (!this.locatePassage(spokenPassage)) {
      // The passage may simply not be rendered yet. Give Obsidian a moment —
      // our own scrolling is what brings the next sections into existence.
      this.pendingRetry = window.setTimeout(() => {
        this.pendingRetry = undefined;
        this.refreshIndex(true);
        this.locatePassage(spokenPassage);
      }, 250);
    }
  }

  setWord(word: string): void {
    const registry = highlightRegistry();
    if (!registry || !this.index || !this.passageRange || !word) {
      return;
    }
    // One matcher for the whole passage, advanced word by word: rebuilding it
    // per word would restart at the beginning and keep re-finding the first
    // occurrence of a repeated word instead of the one being spoken.
    if (!this.wordMatcher) {
      this.wordMatcher = new SourceMatcher(
        this.index.text.slice(this.passageRange.from, this.passageRange.to),
      );
    }
    const within = this.wordMatcher.find(tokenizeSpoken(word));
    if (!within) {
      return;
    }
    const range = rangeFromOffsets(
      this.index,
      this.passageRange.from + within.from,
      this.passageRange.from + within.to,
    );
    if (!range || !Highlight) {
      return;
    }
    registry.set(WORD_HIGHLIGHT, new Highlight(range));
    this.scrollTo(range, "nearest");
  }

  stop(): void {
    this.clearRetry();
    const registry = highlightRegistry();
    registry?.delete(PASSAGE_HIGHLIGHT);
    registry?.delete(WORD_HIGHLIGHT);
    this.container = undefined;
    this.index = undefined;
    this.matcher = undefined;
    this.wordMatcher = undefined;
    this.passageRange = null;
    this.lastPassageText = "";
  }

  /** A seek moved backwards; let the next search start from the top again. */
  rewind(): void {
    this.matcher?.reset();
    this.lastPassageText = "";
  }

  // --- internals ---

  private locatePassage(spokenPassage: string): boolean {
    const registry = highlightRegistry();
    if (!registry || !Highlight) {
      return false;
    }
    this.refreshIndex();
    if (!this.index || !this.matcher) {
      return false;
    }

    const found = this.matcher.find(tokenizeSpoken(spokenPassage));
    if (!found) {
      return false;
    }
    const range = rangeFromOffsets(this.index, found.from, found.to);
    if (!range) {
      return false;
    }

    this.passageRange = found;
    this.wordMatcher = undefined;
    registry.set(PASSAGE_HIGHLIGHT, new Highlight(range));
    registry.delete(WORD_HIGHLIGHT);
    this.scrollTo(range, "center");
    return true;
  }

  /**
   * Rebuild the flattened text when the rendered DOM has changed. Offsets shift
   * whenever a section mounts, so the matcher is rebuilt with it and re-seeded
   * to just past the passage we were on, keeping repeated phrases in order.
   */
  private refreshIndex(force = false): void {
    if (!this.container) {
      return;
    }
    const next = buildTextIndex(this.container);
    const unchanged =
      !force && this.index !== undefined && this.index.text === next.text;
    if (unchanged) {
      return;
    }

    const previousPassage = this.lastPassageText;
    this.index = next;
    this.matcher = new SourceMatcher(next.text);
    if (previousPassage) {
      // Result discarded: this only advances the cursor past where we were.
      this.matcher.find(tokenizeSpoken(previousPassage));
    }
  }

  private scrollTo(range: Range, block: ScrollLogicalPosition): void {
    const node = range.startContainer;
    const element =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    element?.scrollIntoView({ block, inline: "nearest" });
  }

  private clearRetry(): void {
    if (this.pendingRetry !== undefined) {
      window.clearTimeout(this.pendingRetry);
      this.pendingRetry = undefined;
    }
  }
}
