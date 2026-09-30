export type WebMcpToolAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
};

export type WebMcpToolExecutionOptions = {
  signal: AbortSignal;
};

/**
 * What a host actually hands `execute`. The WebMCP shims in the wild differ: some pass a signal,
 * some pass an options object without one, and some pass other affordances entirely. Tools are
 * written against WebMcpToolExecutionOptions and never see this shape, because registration
 * normalizes it first.
 */
export type WebMcpHostExecutionOptions = Partial<WebMcpToolExecutionOptions> &
  Record<string, unknown>;

export type WebMcpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  execute: (input: unknown, options: WebMcpToolExecutionOptions) => Promise<unknown> | unknown;
};

/** A definition as a host may call it: the options argument is entirely at the host's discretion. */
export type RegisteredWebMcpTool = Omit<WebMcpToolDefinition, "execute"> & {
  execute: (input: unknown, options?: WebMcpHostExecutionOptions) => Promise<unknown> | unknown;
};

export type WebMcpRegisterToolOptions = {
  exposedTo?: string[];
  signal?: AbortSignal;
};

export type WebMcpModelContext = {
  registerTool: (
    tool: RegisteredWebMcpTool,
    options?: WebMcpRegisterToolOptions,
  ) => Promise<void> | void;
};

declare global {
  interface Document {
    modelContext?: WebMcpModelContext;
  }
}
