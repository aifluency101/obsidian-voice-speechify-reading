import { MarkdownView, Notice } from "obsidian";
import { SourceMatcher, tokenizeSpoken } from "../utils/sourceWords";
import { buildTextIndex, rangeFromOffsets } from "./domTextIndex";
import { lineOfOffset, type PreviewSectionRegistry } from "./previewSections";

/**
 * Follow-along highlighting in Reading view.
 *
 * Reading view is rendered HTML with no CodeMirror document behind it, so the
 * editor's decorations cannot apply. Ranges are painted with the CSS Custom
 * Highlight API instead, which does not touch the DOM Obsidian owns.
 *
 * The position is resolved through Obsidian's own mapping rather than by
 * reading the DOM:
 *
 *   spoken passage → matched in the markdown source → source line
 *     → the section element Obsidian rendered that line into → range within it
 *
 * The first step is the matching already proven against the editor path; the
 * second comes from `getSectionInfo`, which Obsidian maintains and re-supplies
 * on every re-render. Only the last step touches the DOM, and only within one
 * small section — so lazy rendering cannot invalidate a position we hold, and
 * nothing needs to watch for it.
 */

const PASSAGE_HIGHLIGHT = "voice-reading-passage";
const WORD_HIGHLIGHT = "voice-reading-word";

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
  private source = "";
  private sourcePath = "";
  private matcher?: SourceMatcher;
  private currentPassage = "";
  private painted = false;
  private warnedUnsupported = false;
  /** the section the current passage was found in, and where in it */
  private passageElement?: HTMLElement;
  private passageWithin: { from: number; to: number } | null = null;
  private wordMatcher?: SourceMatcher;

  constructor(private sections: PreviewSectionRegistry) {}

  /** True only once a highlight has actually been painted. */
  get isActive(): boolean {
    return !!this.matcher && this.painted;
  }

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

    this.source = view.getViewData();
    this.sourcePath = view.file?.path ?? "";
    if (!this.source || !this.sourcePath) {
      return false;
    }
    this.matcher = new SourceMatcher(this.source);
    this.currentPassage = "";
    this.painted = false;
    this.clearLocation();
    return true;
  }

  setPassage(spokenPassage: string): void {
    if (!this.matcher || spokenPassage === this.currentPassage) {
      return;
    }
    // The passage being *left* seeds the cursor; seeding with the one we are
    // about to search for would advance it straight past.
    this.currentPassage = spokenPassage;
    this.locate(spokenPassage);
  }

  setWord(word: string): void {
    const registry = highlightRegistry();
    if (
      !registry ||
      !Highlight ||
      !word ||
      !this.passageElement ||
      !this.passageWithin ||
      !this.passageElement.isConnected
    ) {
      return;
    }
    const index = buildTextIndex(this.passageElement);
    if (!this.wordMatcher) {
      this.wordMatcher = new SourceMatcher(
        index.text.slice(this.passageWithin.from, this.passageWithin.to),
      );
    }
    const within = this.wordMatcher.find(tokenizeSpoken(word));
    if (!within) {
      return;
    }
    const range = rangeFromOffsets(
      index,
      this.passageWithin.from + within.from,
      this.passageWithin.from + within.to,
    );
    if (range) {
      registry.set(WORD_HIGHLIGHT, new Highlight(range));
    }
  }

  stop(): void {
    const registry = highlightRegistry();
    registry?.delete(PASSAGE_HIGHLIGHT);
    registry?.delete(WORD_HIGHLIGHT);
    this.matcher = undefined;
    this.source = "";
    this.sourcePath = "";
    this.currentPassage = "";
    this.painted = false;
    this.clearLocation();
  }

  /** A seek moved backwards; let the next search start from the top again. */
  rewind(): void {
    this.matcher?.reset();
    this.currentPassage = "";
  }

  // --- internals ---

  private locate(spokenPassage: string): void {
    const registry = highlightRegistry();
    if (!registry || !Highlight || !this.matcher) {
      return;
    }

    // 1. Where is this passage in the markdown?
    const inSource = this.matcher.find(tokenizeSpoken(spokenPassage));
    if (!inSource) {
      this.clearHighlights(registry);
      return;
    }

    // 2. Which rendered section did Obsidian build that line into?
    const line = lineOfOffset(this.source, inSource.from);
    const element = this.sections.elementForLine(this.sourcePath, line);
    if (!element) {
      // Not rendered (or not on screen). Leave the note alone rather than
      // highlighting the wrong thing; the next passage will try again.
      this.clearHighlights(registry);
      return;
    }

    // 3. Find the passage inside that one section and paint it.
    const index = buildTextIndex(element);
    const within = new SourceMatcher(index.text).find(
      tokenizeSpoken(spokenPassage),
    );
    const range = within
      ? rangeFromOffsets(index, within.from, within.to)
      : // A passage can span sections; falling back to the whole element keeps
        // the reader oriented rather than dropping the highlight entirely.
        rangeFromOffsets(index, 0, index.text.length);
    if (!range) {
      this.clearHighlights(registry);
      return;
    }

    this.passageElement = element;
    this.passageWithin = within ?? { from: 0, to: index.text.length };
    this.wordMatcher = undefined;
    registry.set(PASSAGE_HIGHLIGHT, new Highlight(range));
    registry.delete(WORD_HIGHLIGHT);
    this.painted = true;
    this.scrollTo(range);
  }

  private clearHighlights(registry: HighlightRegistry): void {
    registry.delete(PASSAGE_HIGHLIGHT);
    registry.delete(WORD_HIGHLIGHT);
    this.clearLocation();
  }

  private clearLocation(): void {
    this.passageElement = undefined;
    this.passageWithin = null;
    this.wordMatcher = undefined;
  }

  /**
   * Scroll to the range, and only when it is off screen. Called on a passage
   * change only: scrolling in response to anything more frequent makes Reading
   * view render more, which is the feedback loop that caused flickering.
   */
  private scrollTo(range: Range): void {
    const scroller = this.passageElement?.closest(
      ".markdown-preview-view",
    ) as HTMLElement | null;
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
      return;
    }
    const delta = rect.top - (view.top + view.height * 0.33);
    if (Math.abs(delta) < 8) {
      return;
    }
    scroller.scrollBy({ top: delta, behavior: "auto" });
  }
}
