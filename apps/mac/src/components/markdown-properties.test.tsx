import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormattedFileMarkdown } from "./resource-content.js";

import { readMarkdownProperties } from "./markdown-properties.js";

afterEach(cleanup);

const file = (header: string) => `---\n${header}\n---\n\n# Handoff\n`;

describe("Markdown file properties", () => {
  it("reads a YAML mapping and preserves the remaining Markdown exactly", () => {
    const body = "\r\n# Handoff\r\n\r\n  Keep this indentation.\r\n";
    const result = readMarkdownProperties(
      "\uFEFF---\r\nname: Friday\r\nmetadata: {type: project}\r\n---\r\n" +
        body,
    );
    expect(result).toEqual({
      rows: [
        { path: "name", value: "Friday" },
        { path: "metadata.type", value: "project" },
      ],
      body,
    });
  });

  it("retains ordered leaves, ambiguous keys, literal values and empty collections", () => {
    const result = readMarkdownProperties(
      file(
        [
          '"metadata.type": literal',
          "reviewers: [{name: Maya}]",
          "revision: 9007199254740993",
          "enabled: false",
          'empty: ""',
          "pending:",
          "flags: {}",
          "steps: []",
          "owner: |-",
          "  Maya",
          "  Release lead",
        ].join("\n"),
      ),
    );
    expect(result?.rows.map(({ path, value }) => [path, value])).toEqual([
      ['["metadata.type"]', "literal"],
      ["reviewers[0].name", "Maya"],
      ["revision", "9007199254740993"],
      ["enabled", "false"],
      ["empty", '""'],
      ["pending", "null"],
      ["flags", "{}"],
      ["steps", "[]"],
      ["owner", "Maya\nRelease lead"],
    ]);
  });

  it("represents empty sequence items and both block and flow null properties", () => {
    const result = readMarkdownProperties(
      file(
        'items:\n  -\n  - null\n  - ~\n  - ""\nflags: {pending, assigned: null}',
      ),
    );
    expect(result?.rows.map(({ path, value }) => [path, value])).toEqual([
      ["items[0]", "null"],
      ["items[1]", "null"],
      ["items[2]", "~"],
      ["items[3]", '""'],
      ["flags.pending", "null"],
      ["flags.assigned", "null"],
    ]);
  });

  it("separates literal punctuation from nested paths and list indices", () => {
    const literal = 'a."b"[0]';
    const result = readMarkdownProperties(
      file(`metadata: {${JSON.stringify(literal)}: literal, a: {b: [nested]}}`),
    );
    expect(result?.rows).toEqual([
      { path: "metadata[" + JSON.stringify(literal) + "]", value: "literal" },
      { path: "metadata.a.b[0]", value: "nested" },
    ]);
  });

  it("distinguishes blank, padded and control-bearing property names", () => {
    const result = readMarkdownProperties(
      file(String.raw`owner: 1
" owner": 2
"owner ": 3
"  ": 4
"own\ter": 5
"own\x7Fer": 6`),
    );
    expect(result?.rows.map((row) => row.path)).toEqual([
      "owner",
      '[" owner"]',
      '["owner "]',
      '["  "]',
      String.raw`["own\ter"]`,
      String.raw`["own\u007fer"]`,
    ]);
  });

  it("accepts the last supported header byte and row", () => {
    const prefix = "label: ";
    const lastValue = "a".repeat(32768 - prefix.length - 1);
    expect(
      readMarkdownProperties(file(prefix + lastValue))?.rows[0].value,
    ).toBe(lastValue);
    expect(readMarkdownProperties(file(prefix + lastValue + "a"))).toBeNull();
    expect(
      readMarkdownProperties(
        file(Array.from({ length: 512 }, (_, i) => `k${i}: true`).join("\n")),
      )?.rows,
    ).toHaveLength(512);
  });

  it("updates the table and body together when the file revision changes", () => {
    const first = file("metadata: {type: handoff}");
    const second = "---\nowner: Maya\n---\n\n## New revision\n";
    const { rerender } = render(<FormattedFileMarkdown content={first} />);
    expect(
      within(screen.getByRole("table", { name: "Properties" })).getByRole(
        "rowheader",
        { name: "metadata.type" },
      ),
    ).toBeTruthy();
    rerender(<FormattedFileMarkdown content={second} />);
    expect(screen.queryByText("metadata.type")).toBeNull();
    expect(screen.getByRole("rowheader", { name: "owner" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "New revision" })).toBeTruthy();
    rerender(<FormattedFileMarkdown content="Only prose now." />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Only prose now.")).toBeTruthy();
    rerender(<FormattedFileMarkdown content={first} showProperties={false} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/metadata:.*handoff/)).toBeTruthy();
  });

  it("keeps a frontmatter-only file readable", () => {
    expect(readMarkdownProperties("---\nname: Friday\n---")).toEqual({
      rows: [{ path: "name", value: "Friday" }],
      body: "",
    });
  });

  it.each([
    ["ordinary Markdown", "# Heading\n\n---\nvalue: one\n---"],
    ["a leading rule", "---\n---\n# Heading"],
    ["an unclosed header", "---\nname: Friday\n"],
    ["an invalid pair", file("name: [unfinished")],
    ["a root list", file("- Maya")],
    ["an empty map", file("{}")],
    ["duplicate keys", file("name: Maya\nname: Ishan")],
    ["an alias", file("first: &name Maya\nsecond: *name")],
    ["a tag", file("name: !!str Friday")],
    ["a complex key", file("? [a, b]\n: value")],
    ["a large header", file("name: " + "日".repeat(11_000))],
    [
      "too many rows",
      file(Array.from({ length: 513 }, (_, i) => `k${i}: 1`).join("\n")),
    ],
    [
      "a deeply nested collection",
      file("steps: " + "[".repeat(34) + "0" + "]".repeat(34)),
    ],
  ])("leaves %s to the ordinary reader intact", (_name, content) => {
    expect(readMarkdownProperties(content)).toBeNull();
  });
});
