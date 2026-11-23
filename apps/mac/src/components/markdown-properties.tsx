import React from "react";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

interface Property {
  path: string;
  value: string;
}

const maxHeaderBytes = 32_768;
const maxDepth = 32;
const maxRows = 512;

function propertyPath(parent: string, key: string): string {
  // Quote ambiguous path segments, including whitespace that would disappear
  // at a cell boundary. JSON escapes C0 controls but leaves DEL and C1 intact.
  if (!key || key !== key.trim() || /[.[\]\p{Cc}]/u.test(key)) {
    const quoted = JSON.stringify(key).replace(
      /\p{Cc}/gu,
      (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
    );
    return `${parent}[${quoted}]`;
  }
  return parent ? `${parent}.${key}` : key;
}

export function readMarkdownProperties(
  content: string,
): { rows: Property[]; body: string } | null {
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(content);
  if (!opening) return null;
  const end = /^---[ \t]*(?:\r?\n|$)/gm;
  end.lastIndex = opening[0].length;
  const closing = end.exec(content);
  if (!closing || closing.index - opening[0].length > maxHeaderBytes)
    return null;

  const header = content.slice(opening[0].length, closing.index);
  if (new TextEncoder().encode(header).length > maxHeaderBytes) return null;
  try {
    const doc = parseDocument(header, {
      logLevel: "silent",
      intAsBigInt: true,
    });
    if (
      doc.errors.length ||
      doc.warnings.length ||
      !isMap(doc.contents) ||
      !doc.contents.items.length
    )
      return null;
    const rows: Property[] = [];

    function collect(node: unknown, path: string, depth: number): boolean {
      // Inspect the parsed nodes directly. Aliases, complex keys and explicit
      // tags retain the ordinary Markdown preview; never resolve them to JS.
      if (depth > maxDepth || rows.length >= maxRows) return false;
      // A key with no value in a flow mapping (e.g. {ready}) has no
      // scalar node, even though it represents the same null as "ready:".
      if (node === null) {
        rows.push({ path, value: "null" });
        return true;
      }
      if (!isMap(node) && !isSeq(node) && !isScalar(node)) return false;
      if (node.tag || node.anchor) return false;
      if (isMap(node) && node.items.length) {
        return node.items.every(
          ({ key, value }) =>
            isScalar(key) &&
            typeof key.value === "string" &&
            !key.tag &&
            !key.anchor &&
            collect(value, propertyPath(path, key.value), depth + 1),
        );
      }
      if (isSeq(node) && node.items.length) {
        return node.items.every((item, index) =>
          collect(item, `${path}[${index}]`, depth + 1),
        );
      }
      let value: string;
      if (isScalar(node)) {
        value =
          typeof node.value === "string"
            ? node.value || '""'
            : node.source || String(node.value);
      } else {
        value = isMap(node) ? "{}" : "[]";
      }
      rows.push({ path, value });
      return true;
    }

    return collect(doc.contents, "", 0)
      ? { rows, body: content.slice(end.lastIndex) }
      : null;
  } catch {
    return null;
  }
}

export function MarkdownProperties({ rows }: { rows: Property[] }) {
  return (
    <div
      className="markdown-table markdown-properties"
      role="region"
      aria-label="File properties"
      tabIndex={0}
    >
      <table aria-label="Properties">
        <thead>
          <tr>
            <th scope="col">Property</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ path, value }) => (
            <tr key={path}>
              <th scope="row" className="whitespace-pre-wrap">
                {path}
              </th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
