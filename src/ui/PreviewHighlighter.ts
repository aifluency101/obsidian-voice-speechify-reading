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
 * Deliberately coarser than the editor path — passage only, no word tracking:
 *
 * Reading view renders sections lazily as you scroll, so any attempt to keep up
 * with the words means re-reading the DOM constantly, and anything that scrolls
 * in response to a DOM change feeds back into more rendering. An earlier version
 * observed mutations and re-located on each one; that loop could not settle and
 * left the view flickering until the app was force-closed.
 *
 * So: the index is rebuilt only when the engine moves to a new passage, the view
 * is scrolled only then, and nothing here reacts to the DOM changing by itself.
 */

const PASSAGE_HIGHLIGHT = "voice-reading-passage";

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
  private painted = false;
  private warnedUnsupported = false;

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
    this.painted = false;
    return true;
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

  /** Word tracking is not attempted in Reading view — see the class comment. */
  setWord(_word: string): void {}

  stop(): void {
    highlightRegistry()?.delete(PASSAGE_HIGHLIGHT);
    this.container = undefined;
    this.index = undefined;
    this.matcher = undefined;
    this.currentPassage = "";
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
    if (!range) {
      // Better no highlight than one left over the wrong text.
      registry.delete(PASSAGE_HIGHLIGHT);
      return;
    }

    registry.set(PASSAGE_HIGHLIGHT, new Highlight(range));
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
