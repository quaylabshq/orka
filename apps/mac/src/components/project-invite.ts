export function normalizeServiceUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid service URL");
  return url.href.replace(/\/$/, "");
}

export function sameServiceUrl(left: string, right: string): boolean {
  try {
    return normalizeServiceUrl(left) === normalizeServiceUrl(right);
  } catch {
    return false;
  }
}

const expiredMessage =
  "This invite has expired. Ask the project owner for a new invite.";
const usedMessage =
  "This invite was already used or is no longer valid. Ask the project owner for a new invite.";
const expiredOrUsedMessage =
  "This invite has expired or was already used. Ask the project owner for a new invite.";
const archivedMessage =
  "This project is archived, so its invites no longer work.";
const wrongAccountMessage = (email: string) =>
  `This invite was sent to ${email}. Sign in with that email address to join.`;

/**
 * The native bridge puts the HTTP status in front of every server message, so a
 * failed join reads "400: Invite expired or already used". Join errors are shown
 * as one plain line each, and running a line through this twice returns it
 * unchanged so both the join flow and the dialog can call it.
 */
export function joinErrorMessage(error: unknown): string {
  const message = (
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : ""
  )
    .replace(/^\d{3}:\s*/, "")
    .trim();
  if (!message) return "Couldn’t join this project. Try again.";
  const wrongAccount = message.match(
    /^This invite was sent to (.+?)\. Sign in with that (?:verified )?email address to join\.?$/,
  );
  if (wrongAccount) return wrongAccountMessage(wrongAccount[1]);
  if (/^This invite has expired\./.test(message)) return expiredMessage;
  if (/^This invite was already used\b/.test(message)) return usedMessage;
  // Servers before invite states shipped one message for both outcomes.
  if (/^Invite expired or already used\b/.test(message))
    return expiredOrUsedMessage;
  if (/^This project is archived\b/.test(message)) return archivedMessage;
  return message;
}

export function parseProjectInvite(value: string): {
  token: string;
  serviceUrl?: string;
} {
  const input = value.trim();
  if (/^[a-f0-9]{48}$/.test(input)) return { token: input };
  try {
    const url = new URL(input);
    if (url.hash || url.username || url.password || input.length > 2048)
      throw new Error();
    if (url.protocol === "orka:" && url.hostname === "join" && !url.port) {
      const token = url.pathname.match(/^\/([a-f0-9]{48})$/)?.[1];
      if (
        !token ||
        [...url.searchParams.keys()].some((key) => key !== "server") ||
        url.searchParams.getAll("server").length > 1
      )
        throw new Error();
      const server = url.searchParams.get("server");
      if (server !== null) {
        const serviceUrl = normalizeServiceUrl(server);
        if (new URL(serviceUrl).pathname !== "/") throw new Error();
        return { token, serviceUrl };
      }
      return { token };
    }
    const token = url.pathname.match(/^\/join\/([a-f0-9]{48})$/)?.[1];
    if (!token || url.search) throw new Error();
    return { token, serviceUrl: normalizeServiceUrl(url.origin) };
  } catch {
    throw new Error("Paste a valid Orka invite link or token.");
  }
}
