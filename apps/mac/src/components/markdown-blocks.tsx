import { CopyIcon, InfoIcon } from "lucide-react";
import type { Blockquote, Parent, Root } from "mdast";
import React from "react";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { CopyLinkButton } from "./copy-link-button.js";
import { Icon } from "./icon.js";
import { MermaidDiagram } from "./mermaid-diagram.js";
import { useToasts } from "./toasts.js";

const alertMarker =
  /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r\n?|\n|$)/;

function markCallout(quote: Blockquote, source: string) {
  const paragraph = quote.children[0];
  if (
    paragraph?.type !== "paragraph" ||
    paragraph.position?.start.line !== quote.position?.start.line
  )
    return;
  const first = paragraph.children[0];
  const offset = first?.position?.start.offset;
  if (
    first?.type !== "text" ||
    !first.value.startsWith("[!") ||
    offset === undefined
  )
    return;

  // Check the authored line so escaped markers and same-line markup keep
  // their literal meaning even after Markdown has parsed the paragraph.
  const marker = alertMarker.exec(source.slice(offset));
  if (!marker) return;
  const label = marker[1][0] + marker[1].slice(1).toLowerCase();
  first.value = first.value.replace(alertMarker, "");
  if (!first.value) {
    paragraph.children.shift();
    if (paragraph.children[0]?.type === "break") paragraph.children.shift();
  }
  if (!paragraph.children.length) quote.children.shift();
  quote.data = {
    ...quote.data,
    hName: "aside",
    hProperties: { ariaLabel: label },
  };
}

const remarkCallouts: Plugin<[], Root> = () => (tree, file) => {
  const source = file.toString();
  function visit(parent: Parent) {
    for (const node of parent.children) {
      if (node.type === "blockquote") markCallout(node, source);
      if ("children" in node) visit(node);
    }
  }
  visit(tree);
};

export const markdownRemarkPlugins = [remarkGfm, remarkCallouts];

export function MarkdownCallout({
  children,
  "aria-label": label,
}: React.ComponentProps<"aside">) {
  return (
    <aside className="markdown-callout" aria-label={label}>
      <div className="markdown-callout-title">
        <Icon icon={InfoIcon} size="sm" />
        {label}
      </div>
      {children}
    </aside>
  );
}

const languageNames = new Map([
  ["sh", "Shell"],
  ["bash", "Bash"],
  ["js", "JavaScript"],
  ["ts", "TypeScript"],
  ["json", "JSON"],
]);

function CodeCopyButton({ source }: { source: string }) {
  const { notify } = useToasts();
  return (
    <CopyLinkButton
      value={source}
      label="Copy"
      accessibleLabel="Copy code"
      copiedMessage="Code copied"
      errorTitle="Couldn’t copy code"
      icon={CopyIcon}
      variant="tertiary"
      onError={(error) => {
        if (error)
          notify({
            kind: "error",
            title: "Couldn’t copy code. Select the code and copy it manually.",
          });
      }}
    />
  );
}

export function MarkdownPre({ children }: React.ComponentProps<"pre">) {
  const code = React.Children.toArray(children)[0];
  if (
    !React.isValidElement<{ className?: string; children?: React.ReactNode }>(
      code,
    ) ||
    code.type !== "code"
  )
    return <pre>{children}</pre>;
  const text = code.props.children ?? "";
  if (typeof text !== "string") return <pre>{children}</pre>;
  const source = text.replace(/\n$/, "");
  const language = code.props.className
    ?.split(/\s+/)
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length);
  if (language === "mermaid") return <MermaidDiagram source={source} />;
  const label = language ? (languageNames.get(language) ?? language) : "Code";
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span>{label}</span>
        <CodeCopyButton source={source} />
      </div>
      <pre
        role="region"
        aria-label={language ? `${label} code` : "Code"}
        tabIndex={0}
      >
        {children}
      </pre>
    </div>
  );
}
