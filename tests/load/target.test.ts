import { describe, expect, it } from "vitest";
import { validateLoadTarget } from "./target.ts";

const REMOTE_TEST_HOST = "load-test.example.test";
const PROTECTED_HOST = "production.example.test";

describe("load target validation", () => {
  it.each(["http://localhost:8787", "https://127.0.0.1:8787", "http://[::1]:8787"])(
    "allows the local target %s without remote opt-in",
    (target) => {
      expect(() => validateLoadTarget(target, false)).not.toThrow();
    },
  );

  it("allows only the setup-provided remote host with explicit opt-in", () => {
    expect(() =>
      validateLoadTarget(`https://${REMOTE_TEST_HOST}`, true, REMOTE_TEST_HOST, PROTECTED_HOST),
    ).not.toThrow();
    expect(() =>
      validateLoadTarget("https://another.example.test", true, REMOTE_TEST_HOST, PROTECTED_HOST),
    ).toThrow("Remote load tests may target only the explicitly configured test host");
  });

  it("requires a configured host, explicit opt-in, and HTTPS for remote tests", () => {
    expect(() => validateLoadTarget(`https://${REMOTE_TEST_HOST}`, true)).toThrow(
      "Remote load tests may target only the explicitly configured test host",
    );
    expect(() =>
      validateLoadTarget(`https://${REMOTE_TEST_HOST}`, false, REMOTE_TEST_HOST, PROTECTED_HOST),
    ).toThrow("Remote load tests require --allow-remote/LOAD_ALLOW_REMOTE=1");
    expect(() =>
      validateLoadTarget(`http://${REMOTE_TEST_HOST}`, true, REMOTE_TEST_HOST, PROTECTED_HOST),
    ).toThrow("Remote load targets must use HTTPS");
  });

  it("always blocks the setup-provided production hostname", () => {
    expect(() =>
      validateLoadTarget(`https://${PROTECTED_HOST}`, true, PROTECTED_HOST, PROTECTED_HOST),
    ).toThrow("The configured production host is never a valid load-test target");
  });
});
