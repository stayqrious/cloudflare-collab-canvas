import type { TextFontFamily } from "@collab/protocol";

export type BoardRole = "viewer" | "editor" | "owner";
export type AccessMode = "private" | "link_view";
export type DrawingPolicy = "editors_enabled" | "owner_only" | "locked";

export interface Env {
  ASSETS: Fetcher;
  BOARD_ROOMS: DurableObjectNamespace;
  ORGANISATION_ROOMS: DurableObjectNamespace;
  BOARD_ASSETS: R2Bucket;
  BOARD_SNAPSHOTS: R2Bucket;
  WORKER_VERSION: WorkerVersionMetadata;
  APP_HOSTNAME: string;
  ORGANISATION_SIGNING_KEYS?: string;
  ALLOWED_ORIGINS?: string;
  WEBHOOK_ALLOWED_ORIGINS?: string;
  ENVIRONMENT?: string;
  SESSION_SIGNING_KEY_CURRENT: string;
  SESSION_SIGNING_KEY_PREVIOUS?: string;
  TURNSTILE_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  BOARD_CREATION_ENABLED?: string;
}

export interface DeviceSession {
  actorId: string;
  issuedAt: number;
  expiresAt: number;
  keyVersion: "current" | "previous";
  boardId?: string;
}

export interface InternalActorContext {
  actorId: string;
  sessionExpiresAt: number;
  requestId: string;
}

export interface SocketAttachment {
  v: 1;
  connectionId: string;
  actorId: string;
  displayName: string;
  role: BoardRole;
  aclVersion: number;
  sessionExpiresAt: number;
  clientInstanceId: string;
  connectedAt: number;
  state: "syncing" | "live";
}

export interface BoardRow {
  [key: string]: SqlStorageValue;
  public_id: string;
  title: string;
  access_mode: AccessMode;
  drawing_policy: DrawingPolicy;
  images_enabled: number;
  organisation_space_id: string | null;
  features_json: string;
  owner_actor_id: string;
  classroom_mode: number;
  organisation_mode: number;
  organisation_id: string | null;
  latest_seq: number;
  next_z: number;
  acl_version: number;
  min_replay_seq: number;
  latest_snapshot_seq: number;
  dirty_since_seq: number | null;
  dirty_since_at_ms: number | null;
  snapshot_live_item_count: number;
  snapshot_live_item_bytes: number;
  usage_checkpoint_seq: number;
  created_at_ms: number;
  updated_at_ms: number;
  archived_at_ms: number | null;
}

export interface MemberRow {
  [key: string]: SqlStorageValue;
  actor_id: string;
  role: BoardRole;
  display_name: string;
  external_participant_id: string | null;
  revoked_at_ms: number | null;
}

export type StrokeStyle = {
  kind: "stroke";
  color: string;
  width: number;
  opacity: number;
};

export type LineStyle = {
  kind: "line";
  color: string;
  width: number;
  opacity: number;
  arrowhead: "none" | "arrow";
};

export type TextStyle = {
  kind: "text";
  color: string;
  fontSize: number;
  fontFamily: TextFontFamily;
  opacity: number;
};

export type StickyStyle = {
  kind: "sticky";
  fill: string;
  textColor: string;
  fontSize: number;
  opacity: number;
};

export type StampStyle = {
  kind: "stamp";
  color: string;
  opacity: number;
};

export type TableStyle = {
  kind: "table";
  borderColor: string;
  fill: string;
  headerFill: string;
  textColor: string;
  fontSize: number;
  opacity: number;
};

export type ZoneStyle = {
  kind: "zone";
  borderColor: string;
  fill: string;
  textColor: string;
  fontSize: number;
  opacity: number;
};

export type ItemStyle =
  | StrokeStyle
  | LineStyle
  | TextStyle
  | StickyStyle
  | StampStyle
  | TableStyle
  | ZoneStyle;
export type Matrix = [number, number, number, number, number, number];

export type PencilGeometry = { points: Array<[number, number]> };
export type LineGeometry = { x1: number; y1: number; x2: number; y2: number };
export type BoxGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type TextGeometry = { x: number; y: number; text: string; embed?: "video" };
export type StickyGeometry = BoxGeometry & { text: string };
export type StampKind = "star" | "check" | "heart" | "question" | "smile" | "sparkle";
export type StampGeometry = {
  x: number;
  y: number;
  size: number;
  stamp: StampKind;
};
export type TableGeometry = {
  x: number;
  y: number;
  columnWidths: number[];
  rowHeights: number[];
  cells: string[][];
  headerRow?: boolean;
};
export type ZoneGeometry = BoxGeometry & { title: string; locked?: boolean };
export type ItemGeometry =
  | PencilGeometry
  | LineGeometry
  | BoxGeometry
  | TextGeometry
  | StickyGeometry
  | StampGeometry
  | TableGeometry
  | ZoneGeometry;
export type BoardItemKind =
  | "pencil"
  | "line"
  | "rectangle"
  | "ellipse"
  | "text"
  | "sticky"
  | "stamp"
  | "table"
  | "zone";

export interface BoardItem {
  id: string;
  groupId?: string;
  sectionId?: string;
  kind: BoardItemKind;
  z: number;
  version: number;
  createdBy: string;
  assistedBy?: "ai";
  style: ItemStyle;
  transform: Matrix;
  geometry: ItemGeometry;
}

export type LogicalItemState = { exists: false } | { exists: true; item: BoardItem };

export interface ItemEffect {
  itemId: string;
  before: LogicalItemState;
  after: LogicalItemState;
  beforeStateToken: string;
  afterStateToken: string;
}

export type ContentAttribution = {
  responsibleBy: string | null;
  lastChangedBy: string | null;
  updatedSeq: number | null;
  updatedAt: number | null;
};

export type ItemAttributionState = {
  lastModifiedBy: string;
  updatedSeq: number;
  updatedAt: number;
  content: ContentAttribution | null;
  tableCells: ContentAttribution[][] | null;
};

export type ItemAttributionEffect = {
  itemId: string;
  before: ItemAttributionState | null;
  after: ItemAttributionState | null;
};

export interface StoredActionPayload {
  publicResult: ServerAction;
  effects: ItemEffect[];
  attributionEffects?: ItemAttributionEffect[];
}

export interface ServerAction {
  v: 1;
  t: "server.action";
  seq: number;
  acceptedAt: number;
  actor: { id: string; displayName: string };
  creators?: Array<{ id: string; displayName: string }>;
  commandId: string;
  actionId: string;
  op: Record<string, unknown>;
}

export interface CanonicalSnapshot {
  format: "cf-whiteboard-json";
  version: 1;
  boardId: string;
  seq: number;
  createdAt: number;
  settings: { title: string };
  items: BoardItem[];
}

export interface ResolvedAccess {
  role: BoardRole;
  displayName: string;
  canView: boolean;
}
