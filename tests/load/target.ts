export function validateLoadTarget(
  baseUrl: string,
  allowRemote: boolean,
  remoteHostname = process.env.LOAD_REMOTE_HOSTNAME?.trim(),
  protectedHostname = process.env.APP_HOSTNAME?.trim(),
): void {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The load target must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The load target may not contain credentials, a query, or a fragment.");
  }

  const local = isLocalHostname(url.hostname);
  if (!local && url.protocol !== "https:") {
    throw new Error("Remote load targets must use HTTPS.");
  }
  if (!local && protectedHostname && url.hostname === protectedHostname) {
    throw new Error("The configured production host is never a valid load-test target.");
  }
  if (!local && (!remoteHostname || url.hostname !== remoteHostname)) {
    throw new Error("Remote load tests may target only the explicitly configured test host.");
  }
  if (!local && !allowRemote) {
    throw new Error(
      "Remote load tests require --allow-remote/LOAD_ALLOW_REMOTE=1 to prevent accidental production traffic.",
    );
  }
}

export function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
