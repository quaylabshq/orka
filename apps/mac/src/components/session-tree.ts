import type { ProjectResource } from "../types.js";

/** Each fork's parent and each parent's forks, in collection order. A
 * missing parent, a cycle, or another project or repository links nothing. */
export function sessionTree(resources: ProjectResource[]) {
  const parentId = (resource: ProjectResource) =>
    resource.fork?.parentId ?? resource.nativeForkParentId ?? "";
  const byId = new Map(
    resources.map((resource) => [resource.resourceId, resource]),
  );
  const parents = new Map<string, string>();
  const children = new Map<string, ProjectResource[]>();
  for (const resource of resources) {
    const parent = byId.get(parentId(resource));
    if (
      resource.kind !== "session" ||
      parent?.kind !== "session" ||
      parent.projectId !== resource.projectId ||
      parent.sourceId !== resource.sourceId
    )
      continue;
    const seen = new Set([resource.resourceId]);
    let ancestor: ProjectResource | undefined = parent;
    while (ancestor && !seen.has(ancestor.resourceId)) {
      seen.add(ancestor.resourceId);
      ancestor = byId.get(parentId(ancestor));
    }
    if (ancestor) continue;
    parents.set(resource.resourceId, parent.resourceId);
    const siblings = children.get(parent.resourceId) ?? [];
    siblings.push(resource);
    children.set(parent.resourceId, siblings);
  }
  return { parents, children };
}
