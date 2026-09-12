import { MarkdownView, Notice } from "obsidian";
import { SourceMatcher, tokenizeSpoken } from "../utils/sourceWords";
import { buildTextIndex, rangeAcross, rangeFromOffsets } from "./domTextIndex";
import { lineOfOffset, type PreviewSectionRegistry } from "./previewSections";
import type { FollowAlongDiagnostics } from "../utils/followAlongDiagnostics";

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

  constructor(
    private sections: PreviewSectionRegistry,
    private diagnostics: FollowAlongDiagnostics,
  ) {}

  /** True only once a highlight has actually been painted. */
  get isActive(): boolean {
    return !!this.matcher && this.painted;
  }

  start(view: MarkdownView): boolean {
    if (!highlightRegistry()) {
      this.diagnostics.record(
        "preview",
        `no CSS.highlights (CSS.highlights=${typeof (CSS as unknown as { highlights?: unknown }).highlights}, Highlight=${typeof Highlight})`,
      );
      if (!this.warnedUnsupported) {
        this.warnedUnsupported = true;
        new Notice(
          "Voice: this version of Obsidian cannot highlight in Reading view. Switch to Editing view to follow along.",
          6000,
        );
      }
      return false;
    }

    this.sourcePath = view.file?.path ?? "";
    // Prefer the text Obsidian's own section info is expressed in, so the line
    // numbers and the match offsets cannot disagree about where line 0 is.
    const sectionText = this.sections.sourceText(this.sourcePath);
    const viewText = view.getViewData();
    this.source = sectionText ?? viewText;
    if (sectionText && sectionText !== viewText) {
      this.diagnostics.record(
        "preview",
        `using section text (${sectionText.length} chars) not view data (${viewText.length}) — line origins differ`,
      );
    }
    if (!this.source || !this.sourcePath) {
      this.diagnostics.record(
        "preview",
        `no source (chars=${this.source.length}, path=${this.sourcePath || "none"})`,
      );
      return false;
    }
    this.diagnostics.record(
      "preview",
      `ready chars=${this.source.length} sections=${this.sections.sections(this.sourcePath).length}`,
    );
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

    // Sections may only have been recorded after reading began, in which case
    // we started on the view's text. Adopt theirs as soon as it appears.
    const sectionText = this.sections.sourceText(this.sourcePath);
    if (sectionText && sectionText !== this.source) {
      this.source = sectionText;
      this.matcher = new SourceMatcher(sectionText);
      this.diagnostics.record("locate", "re-synced to section text");
    }

    // 1. Where is this passage in the markdown?
    const inSource = this.matcher.find(tokenizeSpoken(spokenPassage));
    if (!inSource) {
      this.diagnostics.record(
        "locate",
        `no source match for "${spokenPassage.slice(0, 40)}"`,
      );
      this.clearHighlights(registry);
      return;
    }

    // 2. Which rendered sections did Obsidian build those lines into?
    //
    // A passage is a few hundred characters and routinely spans several blocks
    // — a heading and the paragraphs under it. Highlighting only the block the
    // passage starts in marks a heading and nothing else, and looks frozen for
    // every passage that starts in the same block.
    const startLine = lineOfOffset(this.source, inSource.from);
    const endLine = lineOfOffset(
      this.source,
      Math.max(inSource.from, inSource.to - 1),
    );
    const startElement = this.sections.elementForLine(
      this.sourcePath,
      startLine,
    );
    const endElement =
      this.sections.elementForLine(this.sourcePath, endLine) ?? startElement;
    if (!startElement || !endElement) {
      this.diagnostics.record(
        "locate",
        `lines ${startLine}-${endLine} not in any rendered section (sections=${this.sections.sections(this.sourcePath).length})`,
      );
      this.clearHighlights(registry);
      return;
    }

    // 3. Trim to where the passage actually begins and ends inside them.
    const spoken = tokenizeSpoken(spokenPassage);
    const startIndex = buildTextIndex(startElement);
    const head = new SourceMatcher(startIndex.text).find(spoken.slice(0, 6));
    const startOffset = head ? head.from : 0;

    const sameElement = startElement === endElement;
    const endIndex = sameElement ? startIndex : buildTextIndex(endElement);
    const tail = new SourceMatcher(endIndex.text).find(spoken.slice(-6));
    const endOffset = tail ? tail.to : endIndex.text.length;

    const range = sameElement
      ? rangeFromOffsets(
          startIndex,
          startOffset,
          Math.max(endOffset, startOffset + 1),
        )
      : rangeAcross(startIndex, startOffset, endIndex, endOffset);
    if (!range) {
      this.diagnostics.record(
        "locate",
        `lines ${startLine}-${endLine}: could not build a range`,
      );
      this.clearHighlights(registry);
      return;
    }
    this.diagnostics.record(
      "locate",
      `painted lines ${startLine}-${endLine}${sameElement ? "" : " (spanning sections)"}`,
    );

    // Word tracking needs one element to index; a passage spanning sections is
    // left with the passage highlight alone rather than a wrong word marker.
    this.passageElement = sameElement ? startElement : undefined;
    this.passageWithin = sameElement
      ? { from: startOffset, to: Math.max(endOffset, startOffset + 1) }
      : null;
    this.wordMatcher = undefined;
    registry.set(PASSAGE_HIGHLIGHT, new Highlight(range));
    registry.delete(WORD_HIGHLIGHT);
    this.painted = true;
    this.scrollTo(range, startElement);
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
   * Scroll the range into view.
   *
   * The scrolling element is found by walking up from the highlighted text
   * rather than assumed: which element actually scrolls differs between
   * Obsidian's layouts, and deriving it from state that a spanning passage does
   * not set meant those passages never scrolled at all — the view lurched on
   * some passages and sat still on others.
   *
   * Called on a passage change only. Scrolling in response to anything more
   * frequent makes Reading view render more, which feeds back into scrolling.
   */
  private scrollTo(range: Range, anchor: HTMLElement): void {
    const scroller = findScroller(anchor);
    if (!scroller) {
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) {
      return;
    }
    const view = scroller.getBoundingClientRect();
    // Mobile puts a toolbar over the bottom of the view, so treat the lower
    // strip as not visible rather than leaving text to be read underneath it.
    const top = view.top + view.height * 0.12;
    const bottom = view.top + view.height * 0.72;
    if (rect.top >= top && rect.bottom <= bottom) {
      return;
    }
    const delta = rect.top - (view.top + view.height * 0.3);
    if (Math.abs(delta) < 8) {
      return;
    }
    scroller.scrollBy({ top: delta, behavior: "auto" });
  }
}

/** The nearest ancestor that actually scrolls, starting from `el` itself. */
function findScroller(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node) {
    const style = getComputedStyle(node);
    const scrollable =
      style.overflowY === "auto" || style.overflowY === "scroll";
    if (scrollable && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}
