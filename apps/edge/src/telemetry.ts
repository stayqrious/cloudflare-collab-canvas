import { sha256Base64Url } from "./crypto";
import type { Env } from "./types";

type RuntimeMetadataEnv = Pick<Env, "ENVIRONMENT" | "WORKER_VERSION">;

export type RuntimeTelemetryContext = {
  environment: string;
  workerVersionId: string;
  boardIdHash?: string;
};

export type DurableObjectTelemetryContext = RuntimeTelemetryContext & {
  durableObjectVersion: string;
};

/**
 * Returns the common indexed fields for gateway telemetry. The fallback values
 * make malformed local test bindings visible without dropping required fields;
 * deployed environments always bind both values through the setup-generated Wrangler config.
 */
export async function runtimeTelemetryContext(
  env: RuntimeMetadataEnv,
  boardId?: string,
): Promise<RuntimeTelemetryContext> {
  const environment = nonEmptyString(env.ENVIRONMENT) ?? "unknown";
  const workerVersionId = nonEmptyString(env.WORKER_VERSION?.id) ?? "unknown";
  if (boardId === undefined) return { environment, workerVersionId };
  return { environment, workerVersionId, boardIdHash: await boardIdHash(boardId) };
}

/** Common fields for BoardRoom events, with the version metadata binding under
 * both the Worker-wide and Durable Object-specific contract names. */
export async function durableObjectTelemetryContext(
  env: RuntimeMetadataEnv,
  boardId?: string,
): Promise<DurableObjectTelemetryContext> {
  const context = await runtimeTelemetryContext(env, boardId);
  return { ...context, durableObjectVersion: context.workerVersionId };
}

/**
 * Board IDs are high-entropy bearer-like route components. Emit only a stable,
 * one-way digest so logs can correlate a board without exposing its route.
 */
export async function boardIdHash(boardId: string): Promise<string> {
  return `bh_${await sha256Base64Url(boardId)}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
