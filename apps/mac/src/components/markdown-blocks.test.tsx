import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import Markdown from "react-markdown";
import { afterEach, expect, test } from "vitest";
import { markdownRemarkPlugins } from "./markdown-blocks.js";
import { markdownComponents } from "./resource-content.js";
import { ToastProvider } from "./toasts.js";

afterEach(cleanup);

function read(source: string) {
  return render(
    <ToastProvider scope="markdown-test">
      <Markdown
        remarkPlugins={markdownRemarkPlugins}
        components={markdownComponents}
      >
        {source}
      </Markdown>
    </ToastProvider>,
  );
}

test.each(["Note", "Tip", "Important", "Warning", "Caution"])(
  "renders the %s marker while preserving the formatted body",
  (label) => {
    read(
      `> [!${label.toUpperCase()}]  \r\n> **Keep** the first line.\r\n>\r\n> - Complete the check.`,
    );
    const note = screen.getByRole("complementary", { name: label });
    expect(note.querySelector("strong")?.textContent).toBe("Keep");
    expect(note.querySelector("li")?.textContent).toBe("Complete the check.");
    expect(note.querySelector("br")).toBeNull();
    expect(note.textContent).not.toContain("[!");
  },
);

test.each([
  "> [!NOTE] **Same-line text**",
  "> [!NOTE] and text",
  "> \\[!NOTE]\n> Escaped marker",
  "> &#91;!NOTE]\n> Encoded marker",
  "> [!note]\n> Lowercase",
  "> [!UNKNOWN]",
  "> `[!NOTE]`",
  "> Start as a regular quotation.\n>\n> [!TIP]\n> Later marker.",
])("keeps literal marker %s in a quotation", (source) => {
  const { container } = read(source);
  expect(container.querySelector("blockquote")).toBeTruthy();
  expect(screen.queryByRole("complementary")).toBeNull();
});

test("indented code has a copy action, inline code remains inline", () => {
  read("Run `pnpm` here.\n\n    pnpm test\n      # Keep this indentation");
  expect(screen.getByRole("region", { name: "Code" }).textContent).toBe(
    "pnpm test\n  # Keep this indentation\n",
  );
  expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(1);
});
