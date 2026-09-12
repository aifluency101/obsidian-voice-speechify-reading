import { findSectionForLine, lineOfOffset } from "../src/ui/previewSections";

describe("Unit Tests - Reading view section mapping", () => {
  const source = [
    "# Title",
    "",
    "First paragraph.",
    "",
    "- item one",
    "- item two",
  ].join("\n");

  test("maps a source offset to its line", () => {
    expect(lineOfOffset(source, 0)).toBe(0);
    expect(lineOfOffset(source, source.indexOf("First"))).toBe(2);
    expect(lineOfOffset(source, source.indexOf("item two"))).toBe(5);
  });

  test("clamps offsets outside the text", () => {
    expect(lineOfOffset(source, -10)).toBe(0);
    expect(lineOfOffset(source, 10_000)).toBe(5);
    expect(lineOfOffset("", 5)).toBe(0);
  });

  test("finds the section covering a line", () => {
    const sections = [
      { id: "title", lineStart: 0, lineEnd: 0 },
      { id: "para", lineStart: 2, lineEnd: 2 },
      { id: "list", lineStart: 4, lineEnd: 5 },
    ];
    expect(findSectionForLine(sections, 0)?.id).toBe("title");
    expect(findSectionForLine(sections, 2)?.id).toBe("para");
    expect(findSectionForLine(sections, 5)?.id).toBe("list");
    expect(findSectionForLine(sections, 3)).toBeUndefined();
  });

  test("prefers the tightest range when sections nest", () => {
    // a list item inside the list it belongs to
    const sections = [
      { id: "list", lineStart: 4, lineEnd: 9 },
      { id: "item", lineStart: 6, lineEnd: 6 },
    ];
    expect(findSectionForLine(sections, 6)?.id).toBe("item");
    expect(findSectionForLine(sections, 8)?.id).toBe("list");
  });

  test("copes with no sections at all", () => {
    expect(findSectionForLine([], 3)).toBeUndefined();
  });
});
