import type { Env } from "../types";
import { HttpError } from "./errors";

export const INTERNAL_ACTOR_HEADER = "x-whiteboard-internal-actor";
export const INTERNAL_EXPIRY_HEADER = "x-whiteboard-internal-session-expiry";
export const INTERNAL_REQUEST_ID_HEADER = "x-whiteboard-internal-request-id";

const INTERNAL_HEADERS = [
  INTERNAL_ACTOR_HEADER,
  INTERNAL_EXPIRY_HEADER,
  INTERNAL_REQUEST_ID_HEADER,
] as const;

export function expectedOrigin(request: Request, env: Env): string {
  const url = new URL(request.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
    return url.origin;
  }
  return `https://${env.APP_HOSTNAME}`;
}

export function requireSecureTransport(request: Request): void {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "[::1]"
  ) {
    throw new HttpError(400, "BAD_REQUEST", "HTTPS is required.");
  }
}

export function requireSameOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("origin");
  if (origin === null || origin !== expectedOrigin(request, env)) {
    throw new HttpError(403, "FORBIDDEN", "The request origin is not allowed.");
  }
}

export function withSecurityHeaders(
  response: Response,
  request: Request,
  env: Pick<Env, "ALLOWED_ORIGINS">,
  requestId: string,
): Response {
  const headers = new Headers(response.headers);
  const pathname = new URL(request.url).pathname;
  const embedDocument = pathname === "/embed" || pathname.startsWith("/embed/");
  const frameAncestors = embedDocument ? configuredFrameAncestors(env.ALLOWED_ORIGINS) : "'none'";
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );
  headers.set(
    "Content-Security-Policy",
    // The style hashes allow only the deterministic styles emitted by pinned MathJax 4.1.3.
    // style-src-attr is relaxed on its own because MathLive lays its maths field and on-screen
    // keyboard out with inline style attributes. It permits nothing that can run: stylesheets and
    // <style> blocks stay bound by style-src, so the hashes above still gate every one of them.
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src-attr 'unsafe-inline'; style-src 'self' 'sha256-e5jd7xQq9aULFFMD0eTEu9T1k/67HYr2XT/IFRaDiI0=' 'sha256-3ZSLWaOQtqrQ6iNoyQlBEIKBi4iPfnn6qanv5SmcYbg=' 'sha256-bgFI+8WNpZyQTg52T+OSNh5Vbm0kkPnj/kOliAUyReE=' 'sha256-khzm1f0RgYGW/mmWtJrCL6sPH/UAtSpOwXMy3ZMP/7g=' 'sha256-1vpkuyno8q93JaTq08t8TmhBkkzmlLq7oQUIJpOeDIQ='; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-src https://challenges.cloudflare.com https://www.youtube-nocookie.com https://player.vimeo.com; object-src 'none'; base-uri 'none'; frame-ancestors " +
      frameAncestors +
      "; form-action 'self'",
  );
  if (embedDocument) headers.delete("X-Frame-Options");
  else headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("X-Request-Id", requestId);
  const init: ResponseInit & { webSocket?: WebSocket } = {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  if (socket !== undefined && socket !== null) init.webSocket = socket;
  return new Response(response.body, init);
}

export function configuredFrameAncestors(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return "'none'";
  const configuration = value.trim();
  if (configuration.length > 2_048) return "'none'";
  if (configuration === "*") return "*";

  const sources = configuration.split(",").map((source) => source.trim());
  if (sources.length === 0 || sources.length > 20 || sources.some((source) => !source)) {
    return "'none'";
  }

  const origins = new Set<string>();
  for (const source of sources) {
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      return "'none'";
    }
    const localHttp =
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]");
    if (parsed.protocol !== "https:" && !localHttp) return "'none'";
    if (
      source.includes("*") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== source
    ) {
      return "'none'";
    }
    origins.add(parsed.origin);
  }
  return [...origins].join(" ") || "'none'";
}

export function makeInternalRequest(
  original: Request,
  actorId: string,
  sessionExpiresAt: number,
  requestId: string,
): Request {
  const headers = new Headers(original.headers);
  for (const header of INTERNAL_HEADERS) headers.delete(header);
  headers.delete("authorization");
  headers.set(INTERNAL_ACTOR_HEADER, actorId);
  headers.set(INTERNAL_EXPIRY_HEADER, String(sessionExpiresAt));
  headers.set(INTERNAL_REQUEST_ID_HEADER, requestId);
  return new Request(original, { headers });
}

export function stripInternalHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const header of INTERNAL_HEADERS) headers.delete(header);
  return new Request(request, { headers });
}
