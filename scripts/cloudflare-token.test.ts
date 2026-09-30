import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCloudflareToken } from "./cloudflare-token.ts";
import { cloudflareRequest } from "./env.ts";

vi.mock("./env.ts", () => ({ cloudflareRequest: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("Cloudflare token verification", () => {
  it("accepts an active account-owned token", async () => {
    const result = {
      response: new Response(),
      envelope: { success: true, result: { status: "active" } },
    };
    vi.mocked(cloudflareRequest).mockResolvedValue(result);
    expect(await verifyCloudflareToken("account")).toBe(result);
    expect(cloudflareRequest).toHaveBeenCalledExactlyOnceWith("/accounts/account/tokens/verify");
  });

  it("falls back to the user-token endpoint used by Workers Builds", async () => {
    const user = {
      response: new Response(),
      envelope: { success: true, result: { status: "active" } },
    };
    vi.mocked(cloudflareRequest)
      .mockResolvedValueOnce({
        response: new Response(null, { status: 403 }),
        envelope: { success: false },
      })
      .mockResolvedValueOnce(user);
    expect(await verifyCloudflareToken("account")).toBe(user);
    expect(cloudflareRequest).toHaveBeenLastCalledWith("/user/tokens/verify");
  });

  it("returns failure when neither token verification succeeds", async () => {
    const failed = { response: new Response(null, { status: 401 }), envelope: { success: false } };
    vi.mocked(cloudflareRequest).mockResolvedValue(failed);
    expect((await verifyCloudflareToken("account")).envelope.success).toBe(false);
  });
});
