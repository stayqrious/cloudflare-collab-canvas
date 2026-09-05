const RAW_EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const IDENTIFIER_HASH_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;

export type OrganisationAdminLaunch = {
  launchToken: string;
};

export type OrganisationAdminPerson = {
  displayName: string;
  /** Stable, non-reversible identifier supplied by the trusted admin API. */
  identifierHash?: string | null;
};

export type OrganisationAdminBoard = {
  id: string;
  name: string;
  owners: readonly OrganisationAdminPerson[];
  participants: readonly OrganisationAdminPerson[];
  /** Already-signed view-only URL. The browser module never creates credentials. */
  viewerUrl: string;
};

export type OrganisationAdminSetting = {
  key: string;
  label: string;
  value: string | number | boolean | null;
  description?: string | null;
};

export type OrganisationAdminSettings = {
  webhookUrl: string | null;
  /** Safe-to-display Organisation settings. Raw email addresses must not be supplied. */
  details: readonly OrganisationAdminSetting[];
};

export type OrganisationAdminSnapshot = {
  organisation: {
    id: string;
    name: string;
  };
  settings: OrganisationAdminSettings;
  boards: readonly OrganisationAdminBoard[];
};

export type OrganisationAdminOperations = {
  load(input: { launchToken: string; signal: AbortSignal }): Promise<OrganisationAdminSnapshot>;
  updateWebhook(input: {
    launchToken: string;
    webhookUrl: string | null;
    signal: AbortSignal;
  }): Promise<OrganisationAdminSettings>;
};

export type OrganisationAdminController = {
  reload(): Promise<void>;
  destroy(): void;
};

export type OrganisationAdminViewPerson = {
  label: string;
  identifierHint: string | null;
};

export type OrganisationAdminViewBoard = {
  id: string;
  name: string;
  owners: OrganisationAdminViewPerson[];
  participants: OrganisationAdminViewPerson[];
  viewerUrl: string | null;
};

export type OrganisationAdminViewModel = {
  organisationId: string;
  organisationName: string;
  webhookUrl: string | null;
  details: Array<{
    key: string;
    label: string;
    description?: string | null;
    displayValue: string;
  }>;
  boards: OrganisationAdminViewBoard[];
  ownerCount: number;
  participantCount: number;
};

export function takeOrganisationAdminLaunch(
  locationValue: Pick<Location, "hash" | "pathname" | "search"> = window.location,
  historyValue: Pick<History, "replaceState" | "state"> = window.history,
): OrganisationAdminLaunch | null {
  if (!/^\/organisation\/admin\/?$/u.test(locationValue.pathname)) return null;
  const parameters = new URLSearchParams(
    locationValue.hash.startsWith("#") ? locationValue.hash.slice(1) : locationValue.hash,
  );
  const launchToken = parameters.get("launch");
  if (launchToken === null || launchToken.trim().length === 0) return null;

  historyValue.replaceState(
    historyValue.state,
    "",
    `${locationValue.pathname}${locationValue.search}`,
  );
  return { launchToken };
}

export function validateOrganisationWebhookUrl(value: string): string | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Enter a complete HTTPS webhook URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Webhook URLs must use HTTPS.");
  }
  return parsed.href;
}

export function buildOrganisationAdminViewModel(
  snapshot: OrganisationAdminSnapshot,
  baseUrl = "https://spacescale.invalid/",
): OrganisationAdminViewModel {
  const ownerHashes = new Set<string>();
  const participantHashes = new Set<string>();
  const boards = snapshot.boards.map((board) => {
    const owners = board.owners.map((person) => presentPerson(person, ownerHashes));
    const participants = board.participants.map((person) =>
      presentPerson(person, participantHashes),
    );
    return {
      id: board.id,
      name: redactEmails(board.name).trim() || "Untitled Space",
      owners,
      participants,
      viewerUrl: safeViewerUrl(board.viewerUrl, baseUrl),
    };
  });

  return {
    organisationId: redactEmails(snapshot.organisation.id),
    organisationName: redactEmails(snapshot.organisation.name).trim() || "Organisation",
    webhookUrl: snapshot.settings.webhookUrl,
    details: snapshot.settings.details.map((setting) => ({
      key: setting.key,
      label: redactEmails(setting.label),
      description:
        setting.description === null || setting.description === undefined
          ? setting.description
          : redactEmails(setting.description),
      displayValue: formatSettingValue(setting.value),
    })),
    boards,
    ownerCount: countPeople(
      boards.flatMap((board) => board.owners),
      ownerHashes,
    ),
    participantCount: countPeople(
      boards.flatMap((board) => board.participants),
      participantHashes,
    ),
  };
}

export function mountOrganisationAdmin(options: {
  host: HTMLElement;
  launchToken: string;
  operations: OrganisationAdminOperations;
}): OrganisationAdminController {
  const { host, launchToken, operations } = options;
  const documentValue = host.ownerDocument;
  let activeRequest: AbortController | null = null;
  let snapshot: OrganisationAdminSnapshot | null = null;
  let errorMessage: string | null = null;
  let loading = true;
  let saving = false;
  let generation = 0;

  host.dataset.organisationAdmin = "true";

  const render = (): void => {
    const root = element(documentValue, "main", "ssa-admin");
    root.setAttribute("aria-busy", loading || saving ? "true" : "false");

    if (loading && snapshot === null) {
      root.append(renderHeader(documentValue, null), renderState(documentValue, "Loading…", false));
      host.replaceChildren(root);
      return;
    }

    if (errorMessage !== null && snapshot === null) {
      const retry = button(documentValue, "Try again", "ssa-button ssa-button--primary");
      retry.addEventListener("click", () => void load());
      root.append(
        renderHeader(documentValue, null),
        renderState(documentValue, errorMessage, true, retry),
      );
      host.replaceChildren(root);
      return;
    }

    if (snapshot === null) return;
    const baseUrl = documentValue.defaultView?.location.href ?? "https://spacescale.invalid/";
    const view = buildOrganisationAdminViewModel(snapshot, baseUrl);
    const refresh = button(documentValue, loading ? "Refreshing…" : "Refresh", "ssa-button");
    refresh.disabled = loading || saving;
    refresh.addEventListener("click", () => void load(false));
    root.append(renderHeader(documentValue, view, refresh));

    const live = element(documentValue, "p", "ssa-live");
    live.setAttribute("aria-live", "polite");
    if (errorMessage !== null) live.textContent = errorMessage;
    root.append(live, renderSummary(documentValue, view));

    const content = element(documentValue, "div", "ssa-layout");
    content.append(renderSettings(documentValue, view), renderBoards(documentValue, view));
    root.append(content);
    host.replaceChildren(root);

    const webhookForm = root.querySelector<HTMLFormElement>("[data-webhook-form]");
    webhookForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (saving) return;
      const input = webhookForm.elements.namedItem("webhookUrl");
      if (!(input instanceof HTMLInputElement)) return;
      void saveWebhook(input.value);
    });
  };

  const load = async (clear = true): Promise<void> => {
    const requestGeneration = ++generation;
    activeRequest?.abort();
    activeRequest = new AbortController();
    loading = true;
    errorMessage = null;
    if (clear) snapshot = null;
    render();
    try {
      const loaded = await operations.load({ launchToken, signal: activeRequest.signal });
      if (requestGeneration !== generation) return;
      snapshot = loaded;
    } catch (error) {
      if (requestGeneration !== generation || isAbortError(error)) return;
      errorMessage = readableError(error, "Organisation details could not be loaded.");
    } finally {
      if (requestGeneration === generation) {
        loading = false;
        render();
      }
    }
  };

  const saveWebhook = async (rawValue: string): Promise<void> => {
    let webhookUrl: string | null;
    try {
      webhookUrl = validateOrganisationWebhookUrl(rawValue);
    } catch (error) {
      errorMessage = readableError(error, "The webhook URL is invalid.");
      render();
      return;
    }

    const requestGeneration = ++generation;
    activeRequest?.abort();
    activeRequest = new AbortController();
    saving = true;
    errorMessage = null;
    render();
    try {
      const settings = await operations.updateWebhook({
        launchToken,
        webhookUrl,
        signal: activeRequest.signal,
      });
      if (requestGeneration !== generation || snapshot === null) return;
      snapshot = { ...snapshot, settings };
    } catch (error) {
      if (requestGeneration !== generation || isAbortError(error)) return;
      errorMessage = readableError(error, "The webhook URL could not be saved.");
    } finally {
      if (requestGeneration === generation) {
        saving = false;
        render();
      }
    }
  };

  void load();
  return {
    reload: () => load(false),
    destroy: () => {
      generation += 1;
      activeRequest?.abort();
      delete host.dataset.organisationAdmin;
      host.replaceChildren();
    },
  };
}

function renderHeader(
  documentValue: Document,
  view: OrganisationAdminViewModel | null,
  action?: HTMLElement,
): HTMLElement {
  const header = element(documentValue, "header", "ssa-header");
  const identity = element(documentValue, "div", "ssa-header__identity");
  const mark = element(documentValue, "span", "ssa-mark");
  mark.textContent = "S";
  mark.setAttribute("aria-hidden", "true");
  const copy = element(documentValue, "div", "ssa-header__copy");
  const eyebrow = element(documentValue, "p", "ssa-eyebrow");
  eyebrow.textContent = "SpaceScale Organisation";
  const title = element(documentValue, "h1", "ssa-title");
  title.textContent = view?.organisationName ?? "Administration";
  copy.append(eyebrow, title);
  identity.append(mark, copy);
  header.append(identity);
  if (action !== undefined) header.append(action);
  return header;
}

function renderSummary(documentValue: Document, view: OrganisationAdminViewModel): HTMLElement {
  const summary = element(documentValue, "section", "ssa-summary");
  summary.setAttribute("aria-label", "Organisation summary");
  summary.append(
    metric(documentValue, String(view.boards.length), "Spaces"),
    metric(documentValue, String(view.ownerCount), "Owners"),
    metric(documentValue, String(view.participantCount), "Participants"),
  );
  return summary;
}

function metric(documentValue: Document, value: string, label: string): HTMLElement {
  const card = element(documentValue, "div", "ssa-metric");
  const strong = element(documentValue, "strong", "ssa-metric__value");
  strong.textContent = value;
  const span = element(documentValue, "span", "ssa-metric__label");
  span.textContent = label;
  card.append(strong, span);
  return card;
}

function renderSettings(documentValue: Document, view: OrganisationAdminViewModel): HTMLElement {
  const section = element(documentValue, "section", "ssa-card ssa-settings");
  section.append(sectionHeading(documentValue, "Settings", "Organisation-wide configuration"));

  const form = element(documentValue, "form", "ssa-form") as HTMLFormElement;
  form.dataset.webhookForm = "true";
  const label = element(documentValue, "label", "ssa-label");
  label.htmlFor = "ssa-organisation-webhook";
  label.textContent = "Webhook URL";
  const inputRow = element(documentValue, "div", "ssa-input-row");
  const input = documentValue.createElement("input");
  input.id = "ssa-organisation-webhook";
  input.name = "webhookUrl";
  input.type = "url";
  input.inputMode = "url";
  input.placeholder = "https://partner.example/webhooks/spacescale";
  input.value = view.webhookUrl ?? "";
  input.className = "ssa-input";
  const save = button(documentValue, "Save", "ssa-button ssa-button--primary");
  save.type = "submit";
  inputRow.append(input, save);
  const help = element(documentValue, "p", "ssa-help");
  help.textContent =
    "Leave blank to remove the webhook. The receiver must be allowed by deployment policy.";
  form.append(label, inputRow, help);
  section.append(form);

  if (view.details.length > 0) {
    const details = element(documentValue, "dl", "ssa-details");
    for (const setting of view.details) {
      const row = element(documentValue, "div", "ssa-details__row");
      const term = documentValue.createElement("dt");
      term.textContent = setting.label;
      if (setting.description) term.title = setting.description;
      const definition = documentValue.createElement("dd");
      definition.textContent = setting.displayValue;
      row.append(term, definition);
      details.append(row);
    }
    section.append(details);
  }
  return section;
}

function renderBoards(documentValue: Document, view: OrganisationAdminViewModel): HTMLElement {
  const section = element(documentValue, "section", "ssa-card ssa-boards");
  section.append(sectionHeading(documentValue, "Spaces", "Every Space in this Organisation"));
  if (view.boards.length === 0) {
    const empty = element(documentValue, "div", "ssa-empty");
    const strong = documentValue.createElement("strong");
    strong.textContent = "No Spaces yet";
    const copy = documentValue.createElement("p");
    copy.textContent = "Spaces will appear here after they are first opened.";
    empty.append(strong, copy);
    section.append(empty);
    return section;
  }

  const scroll = element(documentValue, "div", "ssa-table-scroll");
  const table = element(documentValue, "table", "ssa-table");
  const caption = documentValue.createElement("caption");
  caption.textContent = "Organisation Spaces, owners, participants, and view-only links";
  const head = documentValue.createElement("thead");
  const headRow = documentValue.createElement("tr");
  for (const label of ["Space", "Owners", "Participants", "View only"]) {
    const cell = documentValue.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = documentValue.createElement("tbody");
  for (const board of view.boards) {
    const row = documentValue.createElement("tr");
    const name = documentValue.createElement("td");
    const strong = documentValue.createElement("strong");
    strong.textContent = board.name;
    const id = element(documentValue, "span", "ssa-board-id");
    id.textContent = board.id;
    name.append(strong, id);
    const owners = documentValue.createElement("td");
    owners.append(renderPeople(documentValue, board.owners, "No owner"));
    const participants = documentValue.createElement("td");
    participants.append(renderPeople(documentValue, board.participants, "No participants"));
    const viewer = documentValue.createElement("td");
    if (board.viewerUrl === null) {
      const unavailable = element(documentValue, "span", "ssa-muted");
      unavailable.textContent = "Unavailable";
      viewer.append(unavailable);
    } else {
      const link = documentValue.createElement("a");
      link.href = board.viewerUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "ssa-view-link";
      link.textContent = "Open viewer";
      link.setAttribute("aria-label", `Open view-only version of ${board.name}`);
      viewer.append(link);
    }
    row.append(name, owners, participants, viewer);
    body.append(row);
  }
  table.append(caption, head, body);
  scroll.append(table);
  section.append(scroll);
  return section;
}

function renderPeople(
  documentValue: Document,
  people: readonly OrganisationAdminViewPerson[],
  emptyLabel: string,
): HTMLElement {
  const list = element(documentValue, "ul", "ssa-people");
  if (people.length === 0) {
    const item = element(documentValue, "li", "ssa-muted");
    item.textContent = emptyLabel;
    list.append(item);
    return list;
  }
  for (const person of people) {
    const item = documentValue.createElement("li");
    const label = documentValue.createElement("span");
    label.textContent = person.label;
    item.append(label);
    if (person.identifierHint !== null) {
      const identifier = documentValue.createElement("small");
      identifier.textContent = person.identifierHint;
      identifier.title = "Stable hashed participant identifier";
      item.append(identifier);
    }
    list.append(item);
  }
  return list;
}

function sectionHeading(documentValue: Document, title: string, copy: string): HTMLElement {
  const heading = element(documentValue, "div", "ssa-section-heading");
  const h2 = documentValue.createElement("h2");
  h2.textContent = title;
  const paragraph = documentValue.createElement("p");
  paragraph.textContent = copy;
  heading.append(h2, paragraph);
  return heading;
}

function renderState(
  documentValue: Document,
  message: string,
  error: boolean,
  action?: HTMLElement,
): HTMLElement {
  const state = element(documentValue, "section", `ssa-state${error ? " ssa-state--error" : ""}`);
  state.setAttribute("role", error ? "alert" : "status");
  const copy = documentValue.createElement("p");
  copy.textContent = message;
  state.append(copy);
  if (action !== undefined) state.append(action);
  return state;
}

function presentPerson(
  person: OrganisationAdminPerson,
  hashes: Set<string>,
): OrganisationAdminViewPerson {
  const identifierHash = safeIdentifierHash(person.identifierHash);
  if (identifierHash !== null) hashes.add(identifierHash);
  const label = redactEmails(person.displayName)
    .replaceAll("[private identifier]", " ")
    .replace(/[<>()[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    label:
      label ||
      (identifierHash === null ? "Participant" : `Participant ${identifierHash.slice(0, 6)}`),
    identifierHint: identifierHash === null ? null : `#${identifierHash.slice(0, 16)}`,
  };
}

function countPeople(people: readonly OrganisationAdminViewPerson[], hashes: Set<string>): number {
  if (hashes.size > 0) {
    const withoutHash = people.filter((person) => person.identifierHint === null).length;
    return hashes.size + withoutHash;
  }
  return people.length;
}

function safeIdentifierHash(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return IDENTIFIER_HASH_PATTERN.test(normalized) ? normalized : null;
}

function safeViewerUrl(value: string, baseUrl: string): string | null {
  try {
    const parsed = new URL(value, baseUrl);
    if (parsed.protocol === "https:") return parsed.href;
    const base = new URL(baseUrl);
    if (parsed.protocol === "http:" && parsed.origin === base.origin) return parsed.href;
    return null;
  } catch {
    return null;
  }
}

function formatSettingValue(value: OrganisationAdminSetting["value"]): string {
  if (value === null || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  return redactEmails(String(value));
}

function redactEmails(value: string): string {
  return value.replace(RAW_EMAIL_PATTERN, "[private identifier]");
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function element<K extends keyof HTMLElementTagNameMap>(
  documentValue: Document,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const result = documentValue.createElement(tag);
  result.className = className;
  return result;
}

function button(documentValue: Document, label: string, className: string): HTMLButtonElement {
  const result = documentValue.createElement("button");
  result.type = "button";
  result.className = className;
  result.textContent = label;
  return result;
}

export const ORGANISATION_ADMIN_CSS = `
  [data-organisation-admin="true"] { color: #172033; background: #f4f6fb; overflow: auto; }
  .ssa-admin { box-sizing: border-box; width: min(1440px, 100%); min-height: 100%; margin: 0 auto; padding: 32px; font: 15px/1.5 "Rubik Variable", Rubik, ui-sans-serif, system-ui, sans-serif; }
  .ssa-admin *, .ssa-admin *::before, .ssa-admin *::after { box-sizing: border-box; }
  .ssa-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
  .ssa-header__identity { display: flex; align-items: center; gap: 14px; min-width: 0; }
  .ssa-mark { display: grid; flex: 0 0 44px; width: 44px; height: 44px; place-items: center; border-radius: 14px; color: white; background: linear-gradient(145deg, #6d42ed, #4530a9); font-size: 22px; font-weight: 800; box-shadow: 0 8px 22px rgb(81 57 180 / 24%); }
  .ssa-eyebrow { margin: 0 0 2px; color: #675f78; font-size: 12px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
  .ssa-title { overflow: hidden; margin: 0; color: #171325; font-size: clamp(25px, 4vw, 34px); line-height: 1.15; text-overflow: ellipsis; white-space: nowrap; }
  .ssa-live { min-height: 24px; margin: -18px 0 8px; color: #a32235; font-size: 13px; }
  .ssa-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 20px; }
  .ssa-metric { display: flex; align-items: baseline; gap: 10px; padding: 17px 19px; border: 1px solid #e0e4ee; border-radius: 16px; background: #fff; box-shadow: 0 8px 28px rgb(29 20 68 / 5%); }
  .ssa-metric__value { color: #35205f; font-size: 25px; line-height: 1; }
  .ssa-metric__label { color: #736e7d; font-size: 13px; font-weight: 650; }
  .ssa-layout { display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); align-items: start; gap: 20px; }
  .ssa-card { overflow: hidden; border: 1px solid #e0e4ee; border-radius: 18px; background: #fff; box-shadow: 0 10px 34px rgb(29 20 68 / 6%); }
  .ssa-section-heading { padding: 20px 22px 15px; border-bottom: 1px solid #eceef4; }
  .ssa-section-heading h2 { margin: 0; color: #1f1930; font-size: 18px; }
  .ssa-section-heading p { margin: 3px 0 0; color: #797384; font-size: 13px; }
  .ssa-form { padding: 20px 22px; }
  .ssa-label { display: block; margin-bottom: 7px; color: #332a45; font-size: 13px; font-weight: 700; }
  .ssa-input-row { display: flex; align-items: stretch; gap: 8px; }
  .ssa-input { min-width: 0; width: 100%; border: 1px solid #ccc8d7; border-radius: 11px; padding: 10px 11px; color: #171325; background: #fff; font: inherit; outline: none; }
  .ssa-input:focus { border-color: #6d42ed; box-shadow: 0 0 0 3px rgb(109 66 237 / 13%); }
  .ssa-help { margin: 8px 0 0; color: #81798c; font-size: 12px; }
  .ssa-button { border: 1px solid #d4d0dc; border-radius: 10px; padding: 9px 13px; color: #392f4c; background: #fff; font: inherit; font-size: 13px; font-weight: 700; line-height: 1.2; cursor: pointer; }
  .ssa-button:hover { background: #f7f4fc; }
  .ssa-button:focus-visible, .ssa-view-link:focus-visible { outline: 3px solid rgb(109 66 237 / 30%); outline-offset: 2px; }
  .ssa-button:disabled { opacity: .55; cursor: wait; }
  .ssa-button--primary { border-color: #5932c9; color: #fff; background: #6540d8; }
  .ssa-button--primary:hover { background: #5632c4; }
  .ssa-details { margin: 0; border-top: 1px solid #eceef4; }
  .ssa-details__row { display: grid; grid-template-columns: 1fr auto; gap: 14px; padding: 12px 22px; border-bottom: 1px solid #f0f1f5; }
  .ssa-details__row:last-child { border-bottom: 0; }
  .ssa-details dt { color: #615a6c; font-size: 13px; }
  .ssa-details dd { margin: 0; color: #2e263b; font-size: 13px; font-weight: 700; text-align: right; }
  .ssa-table-scroll { overflow-x: auto; }
  .ssa-table { width: 100%; border-collapse: collapse; }
  .ssa-table caption { position: absolute; overflow: hidden; width: 1px; height: 1px; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  .ssa-table th { padding: 12px 16px; color: #6e6878; background: #faf9fc; font-size: 11px; letter-spacing: .06em; text-align: left; text-transform: uppercase; }
  .ssa-table td { min-width: 150px; padding: 15px 16px; border-top: 1px solid #eceef4; vertical-align: top; }
  .ssa-table td:first-child { min-width: 190px; }
  .ssa-board-id { display: block; margin-top: 2px; color: #908a99; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .ssa-people { display: flex; flex-wrap: wrap; gap: 5px; margin: 0; padding: 0; list-style: none; }
  .ssa-people li { display: flex; align-items: center; gap: 5px; max-width: 230px; border-radius: 999px; padding: 4px 8px; color: #3c3151; background: #f0ecfa; font-size: 12px; }
  .ssa-people li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ssa-people small { color: #777082; font: 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .ssa-view-link { display: inline-flex; align-items: center; border-radius: 9px; padding: 7px 10px; color: #5130b2; background: #f1ecff; font-size: 12px; font-weight: 750; text-decoration: none; white-space: nowrap; }
  .ssa-view-link:hover { background: #e8dfff; }
  .ssa-muted { color: #8e8798 !important; background: transparent !important; }
  .ssa-empty, .ssa-state { display: grid; min-height: 220px; place-items: center; align-content: center; padding: 32px; color: #776f82; text-align: center; }
  .ssa-empty strong { color: #3b3346; font-size: 16px; }
  .ssa-empty p, .ssa-state p { margin: 5px 0 14px; }
  .ssa-state--error { color: #9f2435; }
  @media (max-width: 900px) { .ssa-admin { padding: 22px; } .ssa-layout { grid-template-columns: 1fr; } .ssa-settings { order: 1; } .ssa-boards { order: 2; } }
  @media (max-width: 560px) { .ssa-admin { padding: 16px; } .ssa-summary { grid-template-columns: 1fr; gap: 8px; } .ssa-header { align-items: flex-start; } .ssa-mark { width: 38px; height: 38px; flex-basis: 38px; border-radius: 12px; } .ssa-title { font-size: 24px; } .ssa-input-row { align-items: stretch; flex-direction: column; } }
`;
