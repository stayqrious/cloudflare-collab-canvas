import "@fontsource-variable/rubik";
import "./styles.css";
// MathLive's own styles and fonts, bundled and served from this origin so the content security
// policy does not have to allow the library to fetch its own.
import "mathlive/static.css";
import "mathlive/fonts.css";
import { ApiClient, ApiError, takeEmbedLaunch, takeFragmentClaim } from "./transport/api";
import {
  acknowledgeRecoveredOwnership,
  BoardApp,
  boardIdFromPath,
  confirmRecoveryClaim,
  renderFatal,
  renderLanding,
  withAdaptiveTurnstile,
} from "./ui/app";
import {
  mountOrganisationAdmin,
  type OrganisationAdminSettings,
  type OrganisationAdminSnapshot,
  takeOrganisationAdminLaunch,
} from "./ui/organisation-admin";
import {
  createReadOnlySpaceViewer,
  createSignedViewerImageAssetLoader,
  viewerAssetTokenFromSessionResponse,
} from "./ui/viewer";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Application root is missing.");

const viewerPath = /^\/viewer\/?$/u.test(window.location.pathname);
const organisationAdminPath = /^\/organisation\/admin\/?$/u.test(window.location.pathname);
const viewerLaunchToken = viewerPath ? takeViewerLaunch() : null;
const organisationAdminLaunch = organisationAdminPath ? takeOrganisationAdminLaunch() : null;
const api = new ApiClient();
let boardId = boardIdFromPath();
const embedPath = /^\/embed(?:\/|$)/u.test(window.location.pathname);
const embedLaunch = takeEmbedLaunch();
const fragmentClaim = embedPath ? null : takeFragmentClaim();

void start();

async function start(): Promise<void> {
  try {
    if (viewerPath) {
      await startViewerRoute();
      return;
    }
    if (organisationAdminPath) {
      if (organisationAdminLaunch === null) {
        throw new ApiError(
          "AUTH_REQUIRED",
          "Open Organisation administration from a signed owner link.",
          401,
        );
      }
      startOrganisationAdminRoute(organisationAdminLaunch.launchToken);
      return;
    }
    if (embedLaunch !== null) {
      showBootMessage("Opening your Space…");
      const launched = await api.startEmbedSession(embedLaunch);
      boardId = launched.board.id;
      history.replaceState(history.state, "", `/embed/b/${encodeURIComponent(launched.board.id)}`);
      await api.ensureSession();
    } else if (embedPath) {
      if (api.embedSessionToken === null) {
        throw new ApiError(
          "AUTH_REQUIRED",
          "Open this Space again from its parent application.",
          401,
        );
      }
      await api.ensureSession();
    } else {
      await api.ensureSession();
    }
    if (!boardId) {
      renderLanding(root as HTMLElement, api);
      return;
    }
    const activeBoardId = boardId;

    if (fragmentClaim) {
      const confirmed = await confirmRecoveryClaim(root as HTMLElement, fragmentClaim);
      if (fragmentClaim.type === "recovery" && !confirmed) {
        renderFatal(
          root as HTMLElement,
          "Recovery cancelled",
          "No ownership changes were made. You can safely close this tab.",
          false,
        );
        return;
      }
      showBootMessage(
        fragmentClaim.type === "invite" ? "Joining your board…" : "Recovering ownership…",
      );
      const claimResult = await withAdaptiveTurnstile(
        root as HTMLElement,
        api.turnstile,
        fragmentClaim.type === "invite" ? "invitation_claim" : "recovery_claim",
        (turnstileToken) =>
          api.claim(
            activeBoardId,
            fragmentClaim,
            fragmentClaim.type === "recovery",
            turnstileToken,
          ),
      );
      if (fragmentClaim.type === "recovery") {
        await acknowledgeRecoveredOwnership(root as HTMLElement, activeBoardId, claimResult);
      }
    }

    showBootMessage("Loading the latest canvas…");
    const bootstrap = await api.bootstrap(activeBoardId);
    await BoardApp.mount(root as HTMLElement, api, bootstrap);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 410) {
        renderFatal(
          root as HTMLElement,
          "Board archived",
          "This board has been permanently archived and can no longer be opened.",
          false,
        );
        return;
      }
      const title =
        error.code === "FORBIDDEN" || error.code === "AUTH_REQUIRED"
          ? "This board is private"
          : "Board unavailable";
      renderFatal(root as HTMLElement, title, error.message);
      return;
    }
    renderFatal(
      root as HTMLElement,
      "Couldn’t open the board",
      "Check your connection and try again.",
    );
  }
}

async function startViewerRoute(): Promise<void> {
  document.title = "SpaceScale — Read-only Space";
  if (viewerLaunchToken === null) {
    createReadOnlySpaceViewer(root as HTMLElement, { manualInput: true });
    return;
  }
  showBootMessage("Opening read-only Space…");
  const response = await fetch("/api/v1/viewer/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: viewerLaunchToken }),
  });
  if (!response.ok) await throwApiResponse(response);
  const viewerAssetToken = viewerAssetTokenFromSessionResponse(response);
  const viewer = createReadOnlySpaceViewer(root as HTMLElement, {
    loadImageAsset: createSignedViewerImageAssetLoader(viewerAssetToken),
  });
  await viewer.loadApiResponse(response);
}

function startOrganisationAdminRoute(launchToken: string): void {
  document.title = "SpaceScale — Organisation administration";
  mountOrganisationAdmin({
    host: root as HTMLElement,
    launchToken,
    operations: {
      load: ({ launchToken: token, signal }) =>
        postJson<OrganisationAdminSnapshot>(
          "/api/v1/organisation-admin/session",
          { token },
          signal,
        ),
      updateWebhook: ({ launchToken: token, webhookUrl, signal }) =>
        postJson<OrganisationAdminSettings>(
          "/api/v1/organisation-admin/webhook",
          { token, webhookUrl },
          signal,
        ),
    },
  });
}

function takeViewerLaunch(): string | null {
  const parameters = new URLSearchParams(
    window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash,
  );
  const token = parameters.get("launch");
  if (token === null || token.trim().length === 0) return null;
  history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}`);
  return token;
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) await throwApiResponse(response);
  return (await response.json()) as T;
}

async function throwApiResponse(response: Response): Promise<never> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const code = error !== null && typeof error.code === "string" ? error.code : "REQUEST_FAILED";
  const message =
    error !== null && typeof error.message === "string"
      ? error.message
      : "The request could not be completed.";
  throw new ApiError(code, message, response.status, payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function showBootMessage(message: string): void {
  const current = (root as HTMLElement).querySelector<HTMLElement>(".boot-screen span:last-child");
  if (current) {
    current.textContent = message;
    return;
  }
  (root as HTMLElement).innerHTML =
    '<div class="boot-screen" role="status" aria-live="polite"><span class="brand-mark" aria-hidden="true">C</span><span></span></div>';
  const text = (root as HTMLElement).querySelector<HTMLElement>(".boot-screen span:last-child");
  if (text) text.textContent = message;
}
