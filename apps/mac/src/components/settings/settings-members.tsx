import {
  HistoryIcon,
  KeyRoundIcon,
  MailIcon,
  MailXIcon,
  SendIcon,
  ShieldUserIcon,
  UserMinusIcon,
  UserPlusIcon,
  UserRoundIcon,
} from "lucide-react";
import { RepositoryRequests } from "../repository-connections.js";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, ProjectMember, Snapshot } from "../../types.js";
import {
  governanceCall,
  type GovernanceCatalog,
} from "../project-permissions.js";
import { Button } from "../button.js";
import { PermissionSelect } from "../permission-select.js";
import { ProjectInviteDialog } from "../project-invite-dialog.js";
import {
  ItemContextMenu,
  ItemMenuButton,
  type ItemMenuAction,
} from "../item-menu.js";
import { Modal } from "../modal.js";
import { LoadingRegion } from "../loading-region.js";
import { ActivityIndicator } from "../activity-indicator.js";
import { SettingsHeading } from "./settings-shared.js";
import { useWorkspaceScope } from "../workspace-cache.js";
import { actionableRequest, visibleRequest } from "../../lib/features.js";

const samples: ProjectMember[] = [
  {
    id: "sample-owner",
    name: "Morgan Taylor",
    email: "morgan@example.com",
    role: "owner",
  },
  {
    id: "sample-admin",
    name: "Alex Chen",
    email: "alex@example.com",
    role: "admin",
  },
  {
    id: "sample-member",
    name: "Jamie Rivera",
    email: "jamie@example.com",
    role: "member",
  },
];
const roleName = (role: string) =>
  role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
function MemberIdentity({
  member,
  user,
  userEmail,
}: {
  member: ProjectMember;
  user: string | null;
  userEmail?: string;
}) {
  // Older services omit email; null from a current service means none is known.
  const email =
    member.email === undefined && member.id === user
      ? userEmail?.trim()
      : member.email?.trim();
  const name =
    member.displayName?.trim() ||
    member.name?.trim() ||
    email ||
    `Member ${member.id.slice(0, 8)}`;
  const photo = member.avatarData ?? member.avatarUrl;
  return (
    <>
      <span className="settings-member-avatar">
        {photo ? (
          <img src={photo} alt="" width={40} height={40} loading="lazy" />
        ) : (
          name.slice(0, 1).toUpperCase()
        )}
      </span>
      <div className="settings-member-identity">
        <div className="settings-identity-name">
          <strong title={name}>{name}</strong>
          {member.id === user && (
            <span className="settings-device-label">You</span>
          )}
        </div>
        {email && <p title={email}>{email}</p>}
      </div>
    </>
  );
}
export function MemberRows({
  members,
  user,
  userEmail,
  owner,
  roleEditable = owner,
  admin,
  busy,
  onRole,
  onRemove,
  onTransfer,
}: {
  members: ProjectMember[];
  user: string | null;
  userEmail?: string;
  owner: boolean;
  roleEditable?: boolean;
  admin: boolean;
  busy: string;
  onRole: (id: string, role: string) => void;
  onRemove: (member: ProjectMember) => void;
  onTransfer: (member: ProjectMember) => void;
}) {
  const orderedMembers = [...members].sort(
    (a, b) => Number(b.id === user) - Number(a.id === user),
  );
  return (
    <ul className="settings-group settings-member-list">
      {orderedMembers.map((member) => {
        const label = `Actions for ${member.name ?? member.id}`;
        const actions: ItemMenuAction[] = [];
        if (roleEditable && member.role !== "owner")
          actions.push({
            id: "role",
            label: "Change role",
            icon: ShieldUserIcon,
            onSelect: () => {},
            children: ["admin", "member"].map((role) => ({
              id: role,
              label: roleName(role),
              icon: role === "admin" ? ShieldUserIcon : UserRoundIcon,
              disabled: Boolean(busy) || member.role === role,
              onSelect: () => onRole(member.id, role),
            })),
          });
        if (
          ((owner && member.role !== "owner") ||
            (admin && member.role === "member")) &&
          member.id !== user
        ) {
          if (roleEditable)
            actions.push({
              id: "transfer",
              label: "Transfer ownership",
              icon: KeyRoundIcon,
              disabled: Boolean(busy),
              onSelect: () => onTransfer(member),
            });
          actions.push({
            id: "remove",
            label: `Remove ${roleName(member.role)}`,
            icon: UserMinusIcon,
            danger: true,
            separator: actions.length > 0,
            disabled: Boolean(busy),
            onSelect: () => onRemove(member),
          });
        }
        return (
          <ItemContextMenu key={member.id} actions={actions} label={label}>
            <li className="settings-member-row">
              <MemberIdentity
                member={member}
                user={user}
                userEmail={userEmail}
              />
              {busy === member.id && <ActivityIndicator />}
              <div className="settings-member-controls">
                {roleEditable && member.role !== "owner" ? (
                  <PermissionSelect
                    label={`Role for ${member.name ?? member.id}`}
                    value={member.role}
                    options={[
                      { value: "admin", label: "Admin" },
                      { value: "member", label: "Member" },
                    ]}
                    disabled={Boolean(busy)}
                    onChange={(role) => onRole(member.id, role)}
                  />
                ) : (
                  <span className="settings-member-role">
                    {roleName(member.role)}
                  </span>
                )}
                {actions.length > 0 && (
                  <ItemMenuButton
                    actions={actions}
                    label={label}
                    disabled={Boolean(busy)}
                  />
                )}
              </div>
            </li>
          </ItemContextMenu>
        );
      })}
    </ul>
  );
}
export function SettingsMembers({
  state,
  project,
  onReviews,
  onLogs,
}: {
  state: Snapshot;
  project: Project;
  onReviews: () => void;
  onLogs: () => void;
}) {
  const projectId = project.id;
  const call = useCallback(
    <T,>(action: string, input: Record<string, unknown> = {}) =>
      governanceCall<T>(action, { projectId, ...input }),
    [projectId],
  );
  const scope = useWorkspaceScope();
  const client = useQueryClient();
  // The last catalog the service returned, stored natively for this profile.
  const stored = state.governance?.find(
    (entry) => entry.projectId === projectId,
  )?.catalog as Partial<GovernanceCatalog> | undefined;
  const catalog = useQuery({
    queryKey: ["governance-catalog", scope, projectId],
    queryFn: async () => {
      const catalog = await call<GovernanceCatalog>("catalog");
      if (!Array.isArray(catalog.members))
        throw new Error("The service returned an invalid member list.");
      return { ...catalog, requests: catalog.requests ?? [] };
    },
    // Show the cached list at once and still ask the service on every visit.
    refetchOnMount: "always",
  });
  const { refetch } = catalog;
  // Cancel even an initial read before refetching: otherwise Query deduplicates
  // it and a response from the old policy can consume the invalidation.
  const revision = useRef([scope, projectId, project.policyRevision]);
  useEffect(() => {
    const [previousScope, id, value] = revision.current;
    revision.current = [scope, projectId, project.policyRevision];
    if (
      previousScope !== scope ||
      id !== projectId ||
      value === project.policyRevision
    )
      return;
    const filters = {
      queryKey: ["governance-catalog", scope, projectId],
      exact: true,
    };
    let active = true;
    void client.cancelQueries(filters).then(() => {
      if (active) void client.refetchQueries({ ...filters, type: "active" });
    });
    return () => {
      active = false;
    };
  }, [client, scope, projectId, project.policyRevision]);
  const [extended, setExtended] = useState(false);
  useEffect(() => {
    if (!catalog.isFetching) return;
    const timer = setTimeout(() => setExtended(true), 8000);
    return () => {
      clearTimeout(timer);
      setExtended(false);
    };
  }, [catalog.isFetching]);
  // Roles come only from a service answer; the stored list just fills rows.
  const query = {
    data: catalog.data ?? null,
    loading: catalog.isFetching,
    error: catalog.error ? String(catalog.error) : "",
    extended,
    refresh: () => refetch(),
  };
  const members =
    catalog.data?.members ??
    (Array.isArray(stored?.members) ? stored.members : null);
  const pendingInvites = query.data?.pendingInvites ?? [];
  const requests = (query.data?.requests ?? []).filter(
    (request) => request.projectId === projectId && visibleRequest(request),
  );
  const pendingRequests = requests.filter(actionableRequest);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [invite, setInvite] = useState(false),
    [confirmation, setConfirmation] = useState<{
      action: "remove-member" | "transfer-ownership";
      member: ProjectMember;
    } | null>(null),
    [revoking, setRevoking] = useState(""),
    [revokeUnsupported, setRevokeUnsupported] = useState(false);
  // A 503 can mean the provider accepted the email without confirming it.
  // This uncertainty is local to this view; reopening Members shows Pending.
  const [unconfirmedDelivery, setUnconfirmedDelivery] = useState<
    ReadonlySet<string>
  >(new Set());
  const markDeliveryUnconfirmed = useCallback(
    (email: string, unconfirmed: boolean) => {
      setUnconfirmedDelivery((current) => {
        const next = new Set(current);
        if (unconfirmed) next.add(email);
        else next.delete(email);
        return next;
      });
    },
    [],
  );
  const active = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const owner = project.role === "owner" && query.data?.owner === true;
  const admin =
    project.role === "admin" &&
    query.data?.role === "admin" &&
    Boolean(query.data.rolePolicies);
  const staleAuthority =
    /(?:403|409):/.test(error) && (query.loading || Boolean(query.error));
  async function mutate(
    id: string,
    action: () => Promise<unknown>,
    message: string,
  ) {
    if (locked.current || staleAuthority) return;
    locked.current = true;
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await action();
      if (active.current) {
        setNotice(message);
        setConfirmation(null);
        setRevoking("");
        await query.refresh();
      }
    } catch (error) {
      if (active.current) {
        // Rate limit and delivery messages from the service are shown as written.
        setError(
          String(error)
            .replace(/^Error:\s*/, "")
            .replace(/^(?:429|503):\s*/, ""),
        );
        if (/(?:403|409):/.test(String(error))) {
          setConfirmation(null);
          setRevoking("");
          await query.refresh();
        }
      }
    } finally {
      locked.current = false;
      if (active.current) setBusy("");
    }
  }
  const resend = (email: string) =>
    void mutate(
      `invite:${email}`,
      async () => {
        try {
          await invoke("cloud_action", {
            action: "invite",
            input: { projectId, email },
          });
          markDeliveryUnconfirmed(email, false);
        } catch (error) {
          if (/^503:/.test(String(error))) markDeliveryUnconfirmed(email, true);
          throw error;
        }
      },
      `Invite sent again to ${email}.`,
    );
  const revoke = (email: string) =>
    void mutate(
      `invite:${email}`,
      async () => {
        try {
          await invoke("cloud_action", {
            action: "revoke-invite",
            input: { projectId, email },
          });
          markDeliveryUnconfirmed(email, false);
        } catch (error) {
          if (!/^404:/.test(String(error))) throw error;
          setRevokeUnsupported(true);
          setRevoking("");
          throw new Error(
            "Revoking invites needs an updated Orka service. Ask your service admin to update it.",
            { cause: error },
          );
        }
      },
      `Invite to ${email} revoked.`,
    );
  return (
    <>
      <SettingsHeading
        title="Members"
        description="Manage project members and their roles."
        action={
          (owner || admin) && (
            <Button
              className="settings-add-member"
              disabled={Boolean(busy) || staleAuthority}
              onClick={() => setInvite(true)}
            >
              <UserPlusIcon size={16} />
              Invite member
            </Button>
          )
        }
      />
      <LoadingRegion
        id={`settings-members:${projectId}`}
        label="Loading members…"
        data={members}
        sample={samples}
        loading={!members && query.loading}
        empty={members?.length === 0}
        emptyMessage={
          <p>
            No members were returned. Refresh to check your access.{" "}
            <Button
              disabled={query.loading}
              onClick={() => void query.refresh()}
            >
              {query.loading ? "Refreshing…" : "Refresh"}
            </Button>
          </p>
        }
        error={
          !members && query.error ? (
            <p role="alert">
              Members are unavailable.{" "}
              <Button onClick={() => void query.refresh()}>Retry</Button>
            </p>
          ) : undefined
        }
      >
        {(visibleMembers) => (
          <MemberRows
            members={visibleMembers}
            user={state.user}
            userEmail={state.accountProfile?.email}
            owner={owner || (!members && project.role === "owner")}
            roleEditable={owner && Boolean(query.data?.rolePolicies)}
            admin={admin}
            busy={busy || (staleAuthority ? "refresh" : "")}
            onRole={(userId, role) =>
              void mutate(
                userId,
                () =>
                  call("member-role", {
                    userId,
                    role,
                    expectedPolicyRevision: query.data?.policyRevision,
                  }),
                "Role updated.",
              )
            }
            onRemove={(member) =>
              setConfirmation({ action: "remove-member", member })
            }
            onTransfer={(member) =>
              setConfirmation({ action: "transfer-ownership", member })
            }
          />
        )}
      </LoadingRegion>
      {(owner || admin) && pendingInvites.length > 0 && (
        <section aria-label="Pending invites">
          <h3>Pending invites ({pendingInvites.length})</h3>
          <ul className="settings-group settings-member-list">
            {pendingInvites.map((invite) => {
              const label = `Actions for invite to ${invite.email}`;
              const disabled = Boolean(busy) || staleAuthority;
              const actions: ItemMenuAction[] = [
                {
                  id: "resend",
                  label: "Resend",
                  icon: SendIcon,
                  disabled,
                  onSelect: () => resend(invite.email),
                },
              ];
              if (!revokeUnsupported)
                actions.push({
                  id: "revoke",
                  label: "Revoke",
                  icon: MailXIcon,
                  danger: true,
                  separator: true,
                  disabled,
                  onSelect: () => setRevoking(invite.email),
                });
              return (
                <ItemContextMenu
                  key={invite.email}
                  actions={actions}
                  label={label}
                >
                  <li className="settings-member-row">
                    <span className="settings-member-avatar">
                      <MailIcon size={20} aria-hidden="true" />
                    </span>
                    <div className="settings-member-identity">
                      <div className="settings-identity-name">
                        <strong title={invite.email}>{invite.email}</strong>
                        <span className="settings-device-label">
                          {unconfirmedDelivery.has(invite.email)
                            ? "Delivery unconfirmed"
                            : "Pending"}
                        </span>
                      </div>
                      <p>
                        Expires{" "}
                        <time dateTime={invite.expiresAt}>
                          {new Date(invite.expiresAt).toLocaleString()}
                        </time>
                      </p>
                    </div>
                    {busy === `invite:${invite.email}` && <ActivityIndicator />}
                    <div className="settings-member-controls">
                      <span className="settings-member-role">Member</span>
                      <ItemMenuButton
                        actions={actions}
                        label={label}
                        disabled={disabled}
                      />
                    </div>
                  </li>
                </ItemContextMenu>
              );
            })}
          </ul>
        </section>
      )}
      {query.error && members && (
        <p role="alert">
          Couldn’t refresh members.{" "}
          <Button onClick={() => void query.refresh()}>Retry</Button>
        </p>
      )}
      {query.extended && (
        <p>Still loading members. You can use the other settings.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {requests.length > 0 && (
        <Button onClick={onReviews}>
          {pendingRequests.length > 0
            ? `Review pending requests (${pendingRequests.length})`
            : "View requests and history"}
        </Button>
      )}
      {query.data && (
        <Button size="sm" variant="secondary" onClick={onLogs}>
          <HistoryIcon size={16} aria-hidden="true" /> View logs
        </Button>
      )}
      <RepositoryRequests project={project} state={state} />
      {invite && (
        <ProjectInviteDialog
          title="Invite member"
          projectId={projectId}
          projectName={project.name}
          onDelivery={(email, confirmed) =>
            markDeliveryUnconfirmed(email, !confirmed)
          }
          onClose={() => {
            setInvite(false);
            void query.refresh();
          }}
        />
      )}
      {revoking && (
        <Modal
          title="Revoke invite?"
          className="settings-confirm"
          onClose={() => {
            if (!busy) setRevoking("");
          }}
          size="compact"
          closeButton={false}
          footer={
            <>
              <Button
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => setRevoking("")}
              >
                Stay
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={Boolean(busy)}
                onClick={() => revoke(revoking)}
              >
                {busy && <ActivityIndicator />}
                Revoke invite
              </Button>
            </>
          }
        >
          <p>Links sent to {revoking} will stop working.</p>
          {error && <p role="alert">{error}</p>}
        </Modal>
      )}
      {confirmation && (
        <Modal
          title={
            confirmation.action === "remove-member"
              ? "Remove member?"
              : "Transfer ownership?"
          }
          heading={
            confirmation.action === "remove-member"
              ? `Remove ${confirmation.member.name ?? "this member"}?`
              : `Transfer ownership to ${confirmation.member.name ?? "this member"}?`
          }
          className="settings-confirm"
          onClose={() => {
            if (!busy) setConfirmation(null);
          }}
          size="compact"
          closeButton={false}
          footer={
            <>
              <Button
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => setConfirmation(null)}
              >
                Stay
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={Boolean(busy)}
                onClick={() =>
                  void mutate(
                    confirmation.member.id,
                    () =>
                      call(confirmation.action, {
                        userId: confirmation.member.id,
                        expectedPolicyRevision: query.data?.policyRevision,
                      }),
                    confirmation.action === "remove-member"
                      ? "Member removed."
                      : "Ownership transferred.",
                  )
                }
              >
                {busy && <ActivityIndicator />}
                {confirmation.action === "remove-member"
                  ? "Remove member"
                  : "Transfer ownership"}
              </Button>
            </>
          }
        >
          <p>
            {confirmation.action === "remove-member"
              ? "Their access to shared content will end. Private local work stays on their Mac, and queued writes are checked again when they reconnect."
              : "They will become the Owner. You will become a Member with the project’s Member permissions."}
          </p>
          {error && <p role="alert">{error}</p>}
        </Modal>
      )}
    </>
  );
}
