export const PRODUCT_NAME = "SpaceScale";
export const BRAND_MARK_URL = "/spacescale-mark.svg";
export const PRODUCT_HOME_LABEL = `${PRODUCT_NAME} home`;
export const DEFAULT_DOCUMENT_TITLE = `${PRODUCT_NAME} — AI-enabled collaborative learning`;
export const BRAND_MARK_HTML = `<img class="brand-mark" src="${BRAND_MARK_URL}" alt="" aria-hidden="true" width="32" height="32" />`;

export function brandedDocumentTitle(boardTitle?: string): string {
  const title = boardTitle?.trim();
  return title ? `${title} — ${PRODUCT_NAME}` : DEFAULT_DOCUMENT_TITLE;
}
