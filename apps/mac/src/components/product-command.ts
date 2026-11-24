import {
  invoke as nativeInvoke,
  type InvokeArgs,
  type InvokeOptions,
} from "@tauri-apps/api/core";
import { productAction } from "./desktop-usage.js";
import type { ProductEvent } from "./product-event.js";

type Outcomes = Readonly<Record<string, ProductEvent>>;
// Only user-initiated operations whose acknowledged result confirms the outcome.
// Reads, polling, retries inside the transport, and arguments never enter the event.
const acknowledged: Readonly<Record<string, Outcomes>> = {
  project_command: {
    leave: "project_left",
    archive: "project_archived",
    restore: "project_restored",
    delete: "project_deleted",
    purge: "project_purged",
    "remove-source": "source_removed",
    "reset-source-remote": "source_remote_reset",
  },
  repository_command: {
    begin: "repository_auth_started",
    "cancel-authorization": "repository_auth_cancelled",
    bind: "repository_linked",
    unlink: "repository_unlinked",
    "request-access": "repository_access_requested",
    review: "repository_access_reviewed",
    clone: "repository_clone_started",
  },
  governance_command: {
    policy: "permissions_override_changed",
    inherit: "permissions_override_changed",
    "member-role": "member_role_changed",
    "remove-member": "member_removed",
    "request-access": "access_requested",
    activate: "permissions_migration_completed",
    "keep-skill-copies": "skill_local_copy_kept",
  },
  env_command: {
    import: "env_draft_imported",
    "clone-set": "env_set_cloned",
    publish: "env_set_published",
    apply: "env_apply_completed",
    request: "env_device_requested",
    approve: "env_device_approved",
    accept: "env_device_unlocked",
    access: "env_access_changed",
    delete: "env_set_deleted",
    rebase: "env_conflict_resolved",
  },
  resource_command: {
    reveal: "resource_finder_opened",
    "retry-upload": "upload_retry_requested",
  },
  plugin_authorization: {
    cancel: "connector_consent_cancelled",
    revoke: "connector_revoked",
  },
};
const simple: Outcomes = {
  open_editor: "resource_editor_opened",
  disconnect_project_source: "source_disconnected",
  export_bundle: "resource_bundle_exported",
  export_project: "project_exported",
  import_bundle: "resource_bundle_imported",
  sync_now: "sync_manual_requested",
  retry_uploads: "sync_retry_requested",
  start_source_sync: "sync_manual_requested",
};

export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  const record = productAction();
  const fields =
    args && "action" in args
      ? args.action
      : args && "operation" in args
        ? args.operation
        : "";
  const action = typeof fields === "string" ? fields : "";
  const actions = Object.hasOwn(acknowledged, command)
    ? acknowledged[command]
    : undefined;
  const success =
    actions && Object.hasOwn(actions, action)
      ? actions[action]
      : Object.hasOwn(simple, command)
        ? simple[command]
        : undefined;
  try {
    const result = await (options === undefined
      ? nativeInvoke<T>(command, args)
      : nativeInvoke<T>(command, args, options));
    if (success) record(success);
    if (
      command === "plugin_authorization" &&
      action === "approve" &&
      result &&
      typeof result === "object" &&
      "approved" in result &&
      result.approved === true
    )
      record("connector_authorized");
    return result;
  } catch (error) {
    if (
      command === "env_command" &&
      (action === "apply" || action === "publish")
    )
      record(action === "apply" ? "env_apply_blocked" : "env_publish_failed");
    throw error;
  }
}
