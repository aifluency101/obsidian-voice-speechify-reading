import type { MarkdownPostProcessorContext } from "obsidian";

/**
 * Where each rendered Reading-view element came from in the source.
 *
 * Obsidian hands this over: a markdown post-processor is called once per
 * section as it is rendered, and `ctx.getSectionInfo(el)` returns the source
 * line range that section was built from. That mapping is maintained by
 * Obsidian and re-supplied on every re-render, which is what makes it reliable
 * where reading the DOM is not — Reading view renders lazily, so anything
 * derived by scanning it goes stale the moment another section mounts.
 *
 * The line arithmetic and the lookup are kept free of the DOM so they can be
 * unit-tested.
 */

export interface SectionEntry {
  element: HTMLElement;
  lineStart: number;
  lineEnd: number;
  /** Re-read from Obsidian at lookup time; the docs say prefer a fresh call. */
  refresh: () => { lineStart: number; lineEnd: number } | null;
}

/** The 0-based line containing `offset` in `text`. */
export function lineOfOffset(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

/**
 * The rendered section covering `line`. Prefers the tightest range, so a line
 * inside a list item resolves to that item rather than the whole list.
 */
export function findSectionForLine<
  T extends { lineStart: number; lineEnd: number },
>(entries: T[], line: number): T | undefined {
  let best: T | undefined;
  for (const entry of entries) {
    if (line < entry.lineStart || line > entry.lineEnd) {
      continue;
    }
    if (
      !best ||
      entry.lineEnd - entry.lineStart < best.lineEnd - best.lineStart
    ) {
      best = entry;
    }
  }
  return best;
}

/**
 * Collects section elements per file as Obsidian renders them.
 *
 * Registered once for the plugin's lifetime; entries for elements that have
 * been detached are dropped on the next lookup, so a re-render replaces them
 * rather than accumulating.
 */
export class PreviewSectionRegistry {
  private byPath = new Map<string, SectionEntry[]>();
  private textByPath = new Map<string, string>();

  /** Call from a markdown post-processor. */
  record(element: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const info = ctx.getSectionInfo(element);
    if (!info) {
      return;
    }
    // Keep the very text those line numbers index into. Matching against
    // anything else — the file read back from the view, say — risks a different
    // line origin: a note with a properties block has its frontmatter counted
    // in one and not the other, and then every lookup is off by its length.
    this.textByPath.set(ctx.sourcePath, info.text);
    const entries = this.byPath.get(ctx.sourcePath) ?? [];
    entries.push({
      element,
      lineStart: info.lineStart,
      lineEnd: info.lineEnd,
      refresh: () => {
        const fresh = ctx.getSectionInfo(element);
        return fresh
          ? { lineStart: fresh.lineStart, lineEnd: fresh.lineEnd }
          : null;
      },
    });
    this.byPath.set(ctx.sourcePath, entries);
  }

  /** Live sections for `path`, refreshed and with detached elements dropped. */
  sections(path: string): SectionEntry[] {
    const entries = this.byPath.get(path);
    if (!entries) {
      return [];
    }
    const live: SectionEntry[] = [];
    for (const entry of entries) {
      if (!entry.element.isConnected) {
        continue;
      }
      const fresh = entry.refresh();
      if (fresh) {
        entry.lineStart = fresh.lineStart;
        entry.lineEnd = fresh.lineEnd;
      }
      live.push(entry);
    }
    this.byPath.set(path, live);
    return live;
  }

  /** The rendered element covering `line` of `path`, if it is on screen. */
  elementForLine(path: string, line: number): HTMLElement | undefined {
    return findSectionForLine(this.sections(path), line)?.element;
  }

  /** The document text that this file's section line numbers refer to. */
  sourceText(path: string): string | undefined {
    return this.textByPath.get(path);
  }

  clear(): void {
    this.byPath.clear();
    this.textByPath.clear();
  }
}
