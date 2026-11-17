import { createHash } from "node:crypto";
import type { Resource } from "@portable/protocol";
import { orkaTools as definitions } from "../../packages/protocol/src/mcp.js";
import type { Store } from "./store.js";
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class OrkaReader {
  constructor(
    private store: Store,
    private user: string,
    private origin: string,
  ) {}
  sessions(projectId: string, filter: unknown) {
    return this.run("list_sessions", {
      projectId,
      ...(filter as object),
    }) as Promise<{
      sessions: { id: string }[];
      nextCursor: number | { revision: number; resourceId: string } | null;
    }>;
  }
  run(name: string, input: unknown) {
    return this.store.invoke("reader", {
      name,
      input,
      user: this.user,
      origin: this.origin,
    });
  }
}
export const orkaTools = definitions.map((t) => ({
  ...t,
  run: (input: unknown, reader: OrkaReader) =>
    reader.run(t.name, t.schema.parse(input)),
}));
export const readSession = (store: Store, resource: Resource) =>
  store.invoke("readSession", { resource });
