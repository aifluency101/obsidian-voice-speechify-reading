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
 * a DOM Range registered under a name and styled with ::highlight(), which
 * paints without touching the DOM Obsidian owns and re-renders.
 *
 * The hard part is that Reading view renders sections lazily as you scroll, so
 * the DOM moves underneath any position we hold. Chasing it does not work — an
 * earlier version observed mutations and re-located on each one, and since
 * locating scrolls and scrolling renders, that loop never settled and left the
 * view flickering until the app was force-closed.
 *
 * Instead the note is rendered in full *before* reading starts, via the preview
 * renderer's `showAll` flag (undocumented, so feature-detected and restored
 * afterwards). With the DOM stationary the index stays valid, and word-level
 * tracking is safe because scrolling no longer causes rendering.
 *
 * When that flag is unavailable the class degrades deliberately: passages only,
 * no word tracking, since that is what was making the lazy DOM churn.
 */

const PASSAGE_HIGHLIGHT = "voice-reading-passage";
const WORD_HIGHLIGHT = "voice-reading-word";

/** The preview renderer's virtualisation switch. Not in the public typings. */
interface PreviewRenderer {
  showAll?: boolean;
}
interface PreviewInternals {
  renderer?: PreviewRenderer;
  rerender?: (full?: boolean) => void;
}

/** `Highlight` and `CSS.highlights` are newer than the TS DOM lib in use. */
interface HighlightRegistry {
  set(name: string, highlight: object): void;
  delete(name: string): void;
}
type HighlightConstructor = new (...ranges: Range[]) => object;

declare const Highlight: HighlightConstructor | undefined;

function highlightRegistry(): HighlightRegistry | undefined {
  const registry = (CSS as unknown as { highlights?: HighlightRegistry })
    .highlights;
  return registry && typeof Highlight !== "undefined" ? registry : undefined;
}

export class PreviewHighlighter {
  private container?: Element;
  private index?: TextIndex;
  private matcher?: SourceMatcher;
  private currentPassage = "";
  private passageRange: { from: number; to: number } | null = null;
  private wordMatcher?: SourceMatcher;
  private painted = false;
  private warnedUnsupported = false;
  /** the note is rendered whole, so positions hold and words can be tracked */
  private fullyRendered = false;
  private renderer?: PreviewRenderer;
  private previousShowAll?: boolean;

  /**
   * True only once a highlight has actually been painted. Finding a container
   * is not the same as working — Reading view populates lazily, so an early
   * attempt can land on an element with no text in it yet, and the caller needs
   * to know to try again.
   */
  get isActive(): boolean {
    return !!this.container && this.painted;
  }

  /** Begin a pass over `view`. Returns false when this cannot work here. */
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
    this.currentPassage = "";
    this.passageRange = null;
    this.wordMatcher = undefined;
    this.painted = false;
    this.fullyRendered = this.forceFullRender(view);
    return true;
  }

  /**
   * Ask the preview renderer to stop virtualising and lay the whole note out.
   *
   * `showAll` is not in the public typings, so it is feature-detected and the
   * previous value restored when reading stops — Obsidian goes back to
   * rendering only what is on screen. Returns false if the flag is not there,
   * in which case the caller runs in the coarser, lazy-DOM-safe mode.
   */
  private forceFullRender(view: MarkdownView): boolean {
    const preview = view.previewMode as unknown as PreviewInternals;
    const renderer = preview?.renderer;
    if (!renderer || typeof renderer.showAll !== "boolean") {
      return false;
    }
    try {
      this.renderer = renderer;
      this.previousShowAll = renderer.showAll;
      if (!renderer.showAll) {
        renderer.showAll = true;
        preview.rerender?.(true);
      }
      return true;
    } catch {
      this.renderer = undefined;
      this.previousShowAll = undefined;
      return false;
    }
  }

  private restoreRendering(): void {
    if (this.renderer && this.previousShowAll !== undefined) {
      try {
        this.renderer.showAll = this.previousShowAll;
      } catch {
        // the view may already be gone; nothing to restore onto
      }
    }
    this.renderer = undefined;
    this.previousShowAll = undefined;
    this.fullyRendered = false;
  }

  setPassage(spokenPassage: string): void {
    if (!this.container || spokenPassage === this.currentPassage) {
      return;
    }
    // The passage being *left* seeds the search cursor. Seeding with the one we
    // are about to look for would advance the cursor straight past it.
    const previous = this.currentPassage;
    this.currentPassage = spokenPassage;
    this.locate(spokenPassage, previous);
  }

  /**
   * Only attempted once the note is laid out in full — otherwise following the
   * words means re-reading a DOM that is still moving.
   */
  setWord(word: string): void {
    const registry = highlightRegistry();
    if (
      !this.fullyRendered ||
      !registry ||
      !Highlight ||
      !this.index ||
      !this.passageRange ||
      !word
    ) {
      return;
    }
    // One matcher per passage, advanced word by word: rebuilding it per word
    // would restart at the passage's beginning and keep re-finding the first
    // occurrence of a repeated word.
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
    if (!range) {
      return;
    }
    registry.set(WORD_HIGHLIGHT, new Highlight(range));
  }

  stop(): void {
    const registry = highlightRegistry();
    registry?.delete(PASSAGE_HIGHLIGHT);
    registry?.delete(WORD_HIGHLIGHT);
    this.restoreRendering();
    this.container = undefined;
    this.index = undefined;
    this.matcher = undefined;
    this.currentPassage = "";
    this.passageRange = null;
    this.wordMatcher = undefined;
    this.painted = false;
  }

  /** A seek moved backwards; let the next search start from the top again. */
  rewind(): void {
    this.matcher?.reset();
    this.currentPassage = "";
  }

  // --- internals ---

  private locate(spokenPassage: string, seedAfter: string): void {
    const registry = highlightRegistry();
    if (!registry || !Highlight || !spokenPassage) {
      return;
    }

    // Rebuilt per passage: sections mount as the note scrolls, which moves every
    // offset. Cheap enough at this rate, and it avoids holding stale positions.
    const next = buildTextIndex(this.container as Element);
    if (!this.index || this.index.text !== next.text) {
      this.index = next;
      this.matcher = new SourceMatcher(next.text);
      if (seedAfter) {
        // Result discarded: this only advances the cursor past where we were,
        // so a phrase repeated later in the note resolves in reading order.
        this.matcher.find(tokenizeSpoken(seedAfter));
      }
    }

    const found = this.matcher?.find(tokenizeSpoken(spokenPassage));
    const range = found
      ? rangeFromOffsets(this.index, found.from, found.to)
      : null;
    if (!range || !found) {
      // Better no highlight than one left over the wrong text.
      registry.delete(PASSAGE_HIGHLIGHT);
      registry.delete(WORD_HIGHLIGHT);
      this.passageRange = null;
      this.wordMatcher = undefined;
      return;
    }

    this.passageRange = found;
    this.wordMatcher = undefined;
    registry.set(PASSAGE_HIGHLIGHT, new Highlight(range));
    registry.delete(WORD_HIGHLIGHT);
    this.painted = true;
    this.scrollTo(range);
  }

  /**
   * Scroll to the range itself rather than to its element: a block can be far
   * taller than the viewport, and centring the element throws the view around
   * while the words being spoken barely move.
   *
   * Only called on a passage change, and only when the text is actually out of
   * view — scrolling in response to anything more frequent feeds Reading view's
   * lazy rendering back into itself.
   */
  private scrollTo(range: Range): void {
    const scroller = this.container as HTMLElement | undefined;
    if (!scroller) {
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) {
      return;
    }
    const view = scroller.getBoundingClientRect();
    if (
      rect.top >= view.top + view.height * 0.15 &&
      rect.bottom <= view.top + view.height * 0.8
    ) {
      return; // already comfortably on screen
    }
    const delta = rect.top - (view.top + view.height * 0.33);
    if (Math.abs(delta) < 8) {
      return;
    }
    scroller.scrollBy({ top: delta, behavior: "auto" });
  }
}
