import { useMemo } from "react";
import {
  parseDiffFromFile,
  registerCustomTheme,
  type FileDiffOptions,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";

// Pierre renders inside a shadow root. Its supported CSS-variable theme keeps
// syntax colors connected to Orka's tokens instead of copying a second palette.
registerCustomTheme("orka-dark", async () => ({
  name: "orka-dark",
  type: "dark",
  colors: {
    "editor.foreground": "var(--text-primary)",
    "editor.background": "var(--surface-tertiary)",
    "terminal.ansiRed": "var(--red-text)",
    "terminal.ansiGreen": "var(--green-text)",
  },
  tokenColors: [
    { scope: ["comment"], settings: { foreground: "var(--text-tertiary)" } },
    {
      scope: ["string", "markup.inline"],
      settings: { foreground: "var(--brand-copper)" },
    },
    {
      scope: [
        "keyword",
        "storage",
        "constant",
        "entity.name.function",
        "support.function",
        "entity.name.tag",
        "markup.heading",
        "meta.mapping.key.yaml",
      ],
      settings: { foreground: "var(--blue-text)" },
    },
    {
      scope: [
        "punctuation",
        "punctuation.definition.heading.markdown",
        "punctuation.definition.list.begin.markdown",
      ],
      settings: { foreground: "var(--text-tertiary)" },
    },
    { scope: "markup.bold", settings: { fontStyle: "bold" } },
    { scope: "markup.italic", settings: { fontStyle: "italic" } },
    {
      scope: "markup.underline.link",
      settings: { foreground: "var(--blue-text)", fontStyle: "underline" },
    },
  ],
}));

const options: FileDiffOptions<undefined, undefined> = {
  theme: "orka-dark",
  themeType: "dark",
  preferredHighlighter: "shiki-js",
  diffStyle: "unified",
  diffIndicators: "classic",
  disableBackground: false,
  disableFileHeader: true,
  lineDiffType: "word-alt",
  hunkSeparators: "line-info-basic",
  overflow: "scroll",
  // Static, trusted styling only. Skill file contents are passed as text below.
  unsafeCSS: `
    :host {
      --diffs-font-family: var(--font-mono);
      --diffs-header-font-family: "Inter Variable", sans-serif;
      --diffs-font-size: 14px;
      --diffs-line-height: 26px;
      --diffs-gap-block: 0px;
      --diffs-gap-inline: 12px;
      --diffs-bg-context-override: var(--surface-tertiary);
      --diffs-bg-context-gutter-override: var(--border-default);
      --diffs-bg-separator-override: var(--border-default);
      --diffs-fg-number-override: var(--text-tertiary);
      --diffs-addition-color-override: var(--green-text);
      --diffs-deletion-color-override: var(--red-text);
      --diffs-bg-addition-emphasis-override: var(--green-surface);
      --diffs-bg-deletion-emphasis-override: var(--red-surface);
    }
    [data-code] { padding-block: 0; }
    [data-column-number] { font-size: 12px; }
    [data-line-type="change-addition"] { background-color: var(--green-surface); }
    [data-line-type="change-deletion"] { background-color: var(--red-surface); }
    [data-column-number][data-line-type="change-addition"] { color: var(--green-text); }
    [data-column-number][data-line-type="change-deletion"] { color: var(--red-text); }
    [data-line-type="change-addition"] [data-diff-span] { background-color: var(--green-surface); }
    [data-line-type="change-deletion"] [data-diff-span] { background-color: var(--red-surface); }
    [data-separator] { font-size: 12px; }
    [data-expand-button]:focus-visible { outline: 1px solid var(--border-focus); outline-offset: -2px; }
  `,
  onPostRender(node, _instance, phase) {
    if (phase === "unmount") return;
    // Pierre's expand controls have role=button but no keyboard handling yet.
    // Add keyboard semantics to the real controls; Pierre still owns expansion.
    node.shadowRoot
      ?.querySelectorAll<HTMLElement>("[data-gutter] [data-expand-button]")
      .forEach((button) => {
        const separator = button.closest("[data-separator]");
        const count = separator?.querySelector(
          "[data-unmodified-lines]",
        )?.textContent;
        button.tabIndex = 0;
        button.setAttribute("aria-label", `Show ${count ?? "unchanged lines"}`);
        button.onkeydown = (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          button.click();
        };
      });
  },
};

const wrappedOptions: FileDiffOptions<undefined, undefined> = {
  ...options,
  overflow: "wrap",
};

/** The actual Pierre read-only renderer, shared by both comparison flows. */
export function PierreDiff({
  path,
  before,
  after,
  context,
  wrapLines,
}: {
  path: string;
  before: string;
  after: string;
  context: number;
  wrapLines: boolean;
}) {
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        { name: path, contents: before },
        { name: path, contents: after },
        { context },
      ),
    [path, before, after, context],
  );
  return (
    <FileDiff
      fileDiff={fileDiff}
      options={wrapLines ? wrappedOptions : options}
      disableWorkerPool
    />
  );
}
