import { locateOffset, type TextIndex } from "../src/ui/domTextIndex";

/** Stand-in for Text nodes; locateOffset only ever returns them. */
type FakeNode = { id: string };

function indexOf(...chunks: [string, string][]): TextIndex<FakeNode> {
  let text = "";
  const entries = chunks.map(([id, value]) => {
    const entry = {
      node: { id },
      start: text.length,
      end: text.length + value.length,
    };
    text += value;
    return entry;
  });
  return { text, entries };
}

describe("Unit Tests - DOM text index", () => {
  const index = indexOf(["a", "Hello "], ["b", "brave "], ["c", "new world"]);

  test("finds the node and local offset for a flattened offset", () => {
    expect(locateOffset(index, 0)).toEqual({ node: { id: "a" }, offset: 0 });
    expect(locateOffset(index, 5)).toEqual({ node: { id: "a" }, offset: 5 });
    // first character of the second node
    expect(locateOffset(index, 6)).toEqual({ node: { id: "b" }, offset: 0 });
    expect(locateOffset(index, 12)).toEqual({ node: { id: "c" }, offset: 0 });
    expect(locateOffset(index, 15)).toEqual({ node: { id: "c" }, offset: 3 });
  });

  test("clamps an offset at the very end onto the last node", () => {
    const end = index.text.length;
    expect(locateOffset(index, end)).toEqual({ node: { id: "c" }, offset: 9 });
  });

  test("clamps out-of-range offsets rather than returning nonsense", () => {
    expect(locateOffset(index, -5)).toEqual({ node: { id: "a" }, offset: 0 });
    expect(locateOffset(index, 9999)).toEqual({ node: { id: "c" }, offset: 9 });
  });

  test("returns null for an empty index", () => {
    expect(locateOffset({ text: "", entries: [] }, 0)).toBeNull();
  });

  test("walks a realistic number of nodes correctly", () => {
    // binary search has to agree with a linear scan at every offset
    const chunks: [string, string][] = Array.from({ length: 200 }, (_, i) => [
      `n${i}`,
      `word${i} `,
    ]);
    const big = indexOf(...chunks);
    for (let offset = 0; offset < big.text.length; offset += 7) {
      const found = locateOffset(big, offset)!;
      const entry = big.entries.find(
        (e) => offset >= e.start && offset < e.end,
      )!;
      expect(found.node).toBe(entry.node);
      expect(found.offset).toBe(offset - entry.start);
    }
  });
});
