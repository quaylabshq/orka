import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inviteExpiredOrUsedMessage, inviteExpiry } from "./project-invite.js";

export type InvitePreview =
  | { status: "available"; projectName: string; expiresAt: string }
  | { status: "unavailable" }
  | { status: "unsupported" };

export type InviteDialog = {
  title: string;
  expires: string;
  error: string;
  unavailable: boolean;
};

export function useInvitePreview(
  token: string,
  serviceUrl: string,
): InviteDialog | undefined {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  useEffect(() => {
    setPreview(null);
    if (!token) return;
    const input: { token: string; serviceUrl?: string } = { token };
    if (serviceUrl) input.serviceUrl = serviceUrl;
    let canceled = false;
    void invoke<InvitePreview>("invite_preview", input)
      .then((value) => {
        if (!canceled) setPreview(value);
      })
      .catch(() => {
        if (!canceled) setPreview({ status: "unsupported" });
      });
    return () => {
      canceled = true;
    };
  }, [serviceUrl, token]);
  if (!token) return undefined;
  if (preview?.status === "available")
    return {
      title: `Join ${preview.projectName}`,
      expires: inviteExpiry(preview.expiresAt),
      error: "",
      unavailable: false,
    };
  if (preview?.status === "unavailable")
    return {
      title: "Join project",
      expires: "",
      error: inviteExpiredOrUsedMessage,
      unavailable: true,
    };
  return undefined;
}
