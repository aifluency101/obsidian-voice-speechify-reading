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
  private currentPassage = "";
  private warnedUnsupported = false;
  private pendingRetry?: number;
  private indexDirty = true;
  private painted = false;
  private observer?: MutationObserver;
  private relocateTimer?: number;

  /**
   * True only once a highlight has actually been painted.
   *
   * Finding a container is not the same as working: Reading view populates
   * lazily, so the first attempt can land on an element that has no text in it
   * yet. Reporting "active" then left the caller with nothing to retry, and the
   * highlight only appeared after something else happened to reset the state.
   */
  get isActive(): boolean {
    return !!this.container && this.painted;
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
    this.currentPassage = "";
    this.indexDirty = true;
    this.painted = false;

    // Reading view mounts and unmounts sections as you scroll. That invalidates
    // both the offsets and any Range already handed to the highlight registry —
    // a stale Range can resolve onto recycled nodes, which is what paints a
    // highlight over text that is not being spoken. Re-locate after a change.
    this.observer = new MutationObserver(() => {
      this.indexDirty = true;
      this.scheduleRelocate();
    });
    this.observer.observe(container, { childList: true, subtree: true });

    this.refreshIndex(null);
    return true;
  }

  setPassage(spokenPassage: string): void {
    if (!this.container || spokenPassage === this.currentPassage) {
      return;
    }
    // The passage being *left* is what seeds the search cursor. Recording the
    // new one first meant the cursor was advanced past the very passage we were
    // about to look for, so it was then found later in the note or not at all.
    const previous = this.currentPassage;
    this.currentPassage = spokenPassage;
    this.clearRetry();

    if (!this.locatePassage(spokenPassage, previous)) {
      // It may simply not be rendered yet — our own scrolling is what brings
      // the next sections into existence. Try once more, then give up quietly.
      this.pendingRetry = window.setTimeout(() => {
        this.pendingRetry = undefined;
        this.indexDirty = true;
        this.locatePassage(spokenPassage, previous);
      }, 250);
    }
  }

  setWord(word: string): void {
    const registry = highlightRegistry();
    if (!registry || !this.index || !this.passageRange || !word) {
      return;
    }
    if (this.indexDirty) {
      // Offsets have moved; the passage must be found again before any word
      // inside it means anything.
      if (!this.locatePassage(this.currentPassage, null)) {
        return;
      }
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
    if (this.relocateTimer !== undefined) {
      window.clearTimeout(this.relocateTimer);
      this.relocateTimer = undefined;
    }
    this.observer?.disconnect();
    this.observer = undefined;
    this.clearHighlights();
    this.container = undefined;
    this.index = undefined;
    this.matcher = undefined;
    this.wordMatcher = undefined;
    this.passageRange = null;
    this.currentPassage = "";
    this.indexDirty = true;
    this.painted = false;
  }

  /** A seek moved backwards; let the next search start from the top again. */
  rewind(): void {
    this.matcher?.reset();
    this.currentPassage = "";
  }

  // --- internals ---

  private locatePassage(
    spokenPassage: string,
    seedAfter: string | null,
  ): boolean {
    const registry = highlightRegistry();
    if (!registry || !Highlight || !spokenPassage) {
      return false;
    }
    this.refreshIndex(seedAfter);
    if (!this.index || !this.matcher) {
      return false;
    }

    const found = this.matcher.find(tokenizeSpoken(spokenPassage));
    const range = found
      ? rangeFromOffsets(this.index, found.from, found.to)
      : null;
    if (!found || !range) {
      // Better no highlight than one left over the wrong text.
      this.clearHighlights();
      this.passageRange = null;
      this.wordMatcher = undefined;
      return false;
    }

    this.passageRange = found;
    this.wordMatcher = undefined;
    this.painted = true;
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
  private refreshIndex(seedAfter: string | null): void {
    if (!this.container) {
      return;
    }
    const next = buildTextIndex(this.container);
    if (
      !this.indexDirty &&
      this.index !== undefined &&
      this.index.text === next.text
    ) {
      return;
    }

    this.index = next;
    this.indexDirty = false;
    this.matcher = new SourceMatcher(next.text);
    // Offsets have moved, so anything derived from the old text is meaningless.
    this.passageRange = null;
    this.wordMatcher = undefined;
    if (seedAfter) {
      // Result discarded: this only advances the cursor past where we were, so
      // a phrase repeated later in the note resolves in reading order.
      this.matcher.find(tokenizeSpoken(seedAfter));
    }
  }

  /** Re-find the passage shortly after the rendered DOM settles. */
  private scheduleRelocate(): void {
    if (this.relocateTimer !== undefined || !this.currentPassage) {
      return;
    }
    this.relocateTimer = window.setTimeout(() => {
      this.relocateTimer = undefined;
      this.locatePassage(this.currentPassage, null);
    }, 120);
  }

  private clearHighlights(): void {
    const registry = highlightRegistry();
    registry?.delete(PASSAGE_HIGHLIGHT);
    registry?.delete(WORD_HIGHLIGHT);
  }

  /**
   * Scroll to the range itself rather than to its element.
   *
   * scrollIntoView() works on elements, and a block can be far taller than the
   * viewport — a paragraph, or a table that has been written on one line — so
   * centring the element throws the view around while the words being spoken
   * stay put. Measuring the range keeps the movement proportional to the text.
   *
   * "nearest" additionally does nothing while the range sits in a comfortable
   * band, so following word by word does not scroll on every word.
   */
  private scrollTo(range: Range, mode: "center" | "nearest"): void {
    const scroller = this.container as HTMLElement | undefined;
    if (!scroller) {
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) {
      return;
    }
    const view = scroller.getBoundingClientRect();
    const comfortableTop = view.top + view.height * 0.2;
    const comfortableBottom = view.top + view.height * 0.75;
    if (
      mode === "nearest" &&
      rect.top >= comfortableTop &&
      rect.bottom <= comfortableBottom
    ) {
      return;
    }
    // Land it a third of the way down: context above, room to read below.
    const target = view.top + view.height * 0.33;
    const delta = rect.top - target;
    if (Math.abs(delta) < 4) {
      return;
    }
    scroller.scrollBy({ top: delta, behavior: "auto" });
  }

  private clearRetry(): void {
    if (this.pendingRetry !== undefined) {
      window.clearTimeout(this.pendingRetry);
      this.pendingRetry = undefined;
    }
  }
}
