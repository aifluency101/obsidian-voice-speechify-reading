/**
 * Addressing text inside rendered HTML.
 *
 * Reading view has no document offsets — it is a DOM tree — so to highlight a
 * passage there we flatten the rendered text nodes into one string, match
 * against that, and map the resulting offsets back onto (node, offset) pairs to
 * build a DOM Range.
 *
 * The flattening and the offset lookup are kept here, free of Obsidian and of
 * the Highlight API, so the arithmetic can be unit-tested without a DOM.
 */

export interface TextIndexEntry<TNode = Text> {
  node: TNode;
  /** offset of this node's first character within the flattened text */
  start: number;
  /** offset one past this node's last character */
  end: number;
}

export interface TextIndex<TNode = Text> {
  text: string;
  entries: TextIndexEntry<TNode>[];
}

export interface NodePosition<TNode = Text> {
  node: TNode;
  /** offset within that node */
  offset: number;
}

/**
 * The node and local offset holding flattened offset `offset`.
 *
 * Binary search: a rendered note is thousands of text nodes and this runs for
 * every word boundary the engine reports.
 */
export function locateOffset<TNode>(
  index: TextIndex<TNode>,
  offset: number,
): NodePosition<TNode> | null {
  const entries = index.entries;
  if (entries.length === 0) {
    return null;
  }
  const target = Math.max(0, Math.min(offset, index.text.length));

  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = entries[mid];
    if (target < entry.start) {
      high = mid - 1;
    } else if (target >= entry.end) {
      low = mid + 1;
    } else {
      return { node: entry.node, offset: target - entry.start };
    }
  }

  // `offset` can sit exactly at the end of the text, which belongs to no entry;
  // clamp to the end of the last node so a range can still close there.
  const last = entries[entries.length - 1];
  if (target >= last.end) {
    return { node: last.node, offset: last.end - last.start };
  }
  return null;
}

/**
 * Flatten the text nodes under `root` into one string plus an offset table.
 * Nodes inside elements marked as not rendered are skipped, so hidden or
 * collapsed content cannot swallow a match.
 */
export function buildTextIndex(root: Element): TextIndex {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node) => {
      const parent = (node as Text).parentElement;
      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }
      // Obsidian keeps un-mounted sections around; their text is not on screen
      // and matching into them would highlight nothing visible.
      if (parent.closest(".is-collapsed, [hidden]")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const entries: TextIndexEntry[] = [];
  let text = "";
  let previousBlock: Element | null = null;
  let current = walker.nextNode() as Text | null;
  while (current) {
    const value = current.data;
    if (value.length > 0) {
      // Without a separator the last word of one block and the first of the
      // next are glued into a single token ("CategoriesMinaj"), which forces the
      // matcher to skip and lets a passage balloon across several paragraphs.
      const block = blockOf(current);
      if (previousBlock !== null && block !== previousBlock) {
        text += "\n";
      }
      previousBlock = block;

      entries.push({
        node: current,
        start: text.length,
        end: text.length + value.length,
      });
      text += value;
    }
    current = walker.nextNode() as Text | null;
  }
  return { text, entries };
}

const BLOCK_SELECTOR =
  "p, div, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, figcaption, section";

/** The block-level element a text node belongs to, for boundary detection. */
function blockOf(node: Text): Element | null {
  return node.parentElement?.closest(BLOCK_SELECTOR) ?? null;
}

/** Build a DOM Range spanning flattened offsets [from, to). */
export function rangeFromOffsets(
  index: TextIndex,
  from: number,
  to: number,
): Range | null {
  const start = locateOffset(index, from);
  const end = locateOffset(index, to);
  if (!start || !end) {
    return null;
  }
  const range = start.node.ownerDocument.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    // Offsets can fall out of step if the DOM changed under us mid-read.
    return null;
  }
  return range.collapsed ? null : range;
}

/**
 * A Range spanning two different rendered sections.
 *
 * Obsidian renders each block as its own element, but a spoken passage is a few
 * hundred characters and routinely runs across several of them — a heading and
 * the paragraphs under it, say. A Range may start in one element and end in
 * another as long as they share an ancestor, which sections of a note do.
 */
export function rangeAcross(
  startIndex: TextIndex,
  startOffset: number,
  endIndex: TextIndex,
  endOffset: number,
): Range | null {
  const start = locateOffset(startIndex, startOffset);
  const end = locateOffset(endIndex, endOffset);
  if (!start || !end) {
    return null;
  }
  const range = start.node.ownerDocument.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  // setEnd before setStart in document order throws or collapses; either way
  // there is nothing sensible to paint.
  return range.collapsed ? null : range;
}
