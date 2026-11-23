import React, { useEffect, useState } from "react";
import { renderMermaid } from "./mermaid-renderer.js";

/** Fenced Mermaid blocks become diagrams only in the formatted reader. */
export function MermaidDiagram({
  source,
  fallback,
}: {
  source: string;
  fallback: React.ReactNode;
}) {
  const [result, setResult] = useState<{
    source: string;
    svg?: string;
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void renderMermaid(source).then(
      (svg) => {
        if (active) setResult({ source, svg });
      },
      () => {
        if (active) setResult({ source, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [source]);
  const current = result?.source === source ? result : null;
  if (current?.svg)
    return (
      <div
        className="mermaid-diagram"
        role="img"
        tabIndex={0}
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: current.svg }}
      />
    );
  return (
    <div className="mermaid-fallback">
      {current?.failed ? (
        <>
          <p className="mermaid-status" role="status">
            Diagram unavailable. Showing source.
          </p>
          {fallback}
        </>
      ) : (
        <pre tabIndex={0} role="group" aria-label="Mermaid source">
          <code className="language-mermaid">{source}</code>
        </pre>
      )}
    </div>
  );
}
