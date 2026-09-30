import { cloudflareRequest } from "./env.ts";

/** Workers Builds currently supplies user tokens; local/Actions installs may use account tokens. */
export async function verifyCloudflareToken(account: string) {
  const accountToken = await cloudflareRequest<{ status?: string }>(
    `/accounts/${account}/tokens/verify`,
  );
  if (
    accountToken.response.ok &&
    accountToken.envelope.success &&
    accountToken.envelope.result?.status === "active"
  ) {
    return accountToken;
  }
  return cloudflareRequest<{ status?: string }>("/user/tokens/verify");
}
