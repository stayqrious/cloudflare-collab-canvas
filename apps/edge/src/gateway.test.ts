/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import gateway from "./gateway";
import type { Env } from "./types";

type TestSession = { cookie: string; csrfToken: string };

afterEach(async () => reset());

async function createSession(): Promise<TestSession> {
  const response = await SELF.fetch("http://localhost/api/v1/session", {
    method: "POST",
    headers: { Origin: "http://localhost" },
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("Session response did not set a cookie.");
  const body = (await response.json()) as { csrfToken?: unknown };
  if (typeof body.csrfToken !== "string") throw new Error("Session response omitted CSRF data.");
  return { cookie: setCookie.split(";", 1)[0] ?? "", csrfToken: body.csrfToken };
}

function createBoard(session: TestSession, clientAddress?: string): Promise<Response> {
  return SELF.fetch("http://localhost/api/v1/boards", {
    method: "POST",
    headers: {
      Origin: "http://localhost",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      "Content-Type": "application/json",
      ...(clientAddress === undefined ? {} : { "CF-Connecting-IP": clientAddress }),
    },
    body: JSON.stringify({ title: "Gateway routing test" }),
  });
}

describe("gateway board routing", () => {
  it("fails closed before session or Turnstile work when creation is disabled", async () => {
    const response = await gateway.fetch(
      new Request("http://localhost/api/v1/boards", {
        method: "POST",
        headers: { Origin: "http://localhost" },
      }),
      { BOARD_CREATION_ENABLED: "false" } as Env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "TEMPORARILY_UNAVAILABLE",
        message: "New board creation is temporarily unavailable.",
      },
    });
  });

  it("applies security headers to the static application shell", async () => {
    const response = await SELF.fetch("http://localhost/");

    expect(response.status).toBe(200);
    const contentSecurityPolicy = response.headers.get("content-security-policy");
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy).toContain(
      "frame-src https://challenges.cloudflare.com https://www.youtube-nocookie.com https://player.vimeo.com",
    );
    expect(contentSecurityPolicy).toContain("font-src 'self' data:");
    expect(contentSecurityPolicy).toContain("style-src 'self' 'sha256-");
    // Inline style attributes are allowed on their own, for MathLive's field and keyboard. They
    // cannot run anything; stylesheets and <style> blocks stay bound by style-src and its hashes.
    expect(contentSecurityPolicy).toContain("style-src-attr 'unsafe-inline'");
    // Every other directive must still refuse inline content, which is the point of the policy.
    const relaxed = (contentSecurityPolicy ?? "")
      .split(";")
      .map((directive) => directive.trim())
      .filter((directive) => directive.includes("'unsafe-inline'"))
      .map((directive) => directive.split(/\s+/u)[0]);
    expect(relaxed).toEqual(["style-src-attr"]);
    expect(contentSecurityPolicy).not.toContain("'unsafe-eval'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("creates and exposes a board through its authoritative room", async () => {
    const session = await createSession();
    const response = await createBoard(session);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { board?: { id?: unknown } };
    const boardId = body.board?.id;
    expect(boardId).toMatch(/^b_[A-Za-z0-9_-]{22}$/u);
    if (typeof boardId !== "string") throw new Error("Board response omitted its ID.");

    const bootstrap = await SELF.fetch(`http://localhost/api/v1/boards/${boardId}/bootstrap`, {
      headers: { Cookie: session.cookie },
    });
    expect(bootstrap.status).toBe(200);
  });

  it("lets the authoritative room reject a canonical-looking unknown ID", async () => {
    const session = await createSession();
    const boardId = "b_ZZZZZZZZZZZZZZZZZZZZZZ";
    const response = await SELF.fetch(`http://localhost/api/v1/boards/${boardId}/bootstrap`, {
      headers: { Cookie: session.cookie },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND", message: "Board not found." },
    });
  });

  it("throttles repeated board creation per actor before allocating another room", async () => {
    const session = await createSession();
    const clientAddress = "198.51.100.77";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await createBoard(session, clientAddress)).status).toBe(201);
    }
    const limited = await createBoard(session, clientAddress);

    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});
