import { safeLog } from "./logging";
import type { DurableObjectTelemetryContext } from "./telemetry";

export interface SchemaMigration {
  version: number;
  name: string;
  sql: string;
}

/**
 * The board feature map exactly as migration 11 shipped it. A migration's SQL is
 * immutable once applied, so this literal must never track DEFAULT_BOARD_FEATURES:
 * changing a default there would otherwise rewrite history and leave a board that
 * migrates late disagreeing with its mirrored `images_enabled` column.
 */
const MIGRATION_11_DEFAULT_FEATURES_JSON =
  '{"pencil":true,"line":true,"lineSnapping":true,"square":true,"rectangle":true,"triangle":true,"rhombus":true,"pentagon":true,"hexagon":true,"circle":true,"text":true,"stickyNotes":true,"stamps":true,"images":false,"tables":true,"sections":true,"protractor":true,"eraser":true,"partialEraser":true,"objectTransforms":true,"grouping":true,"templates":true,"organisationTemplates":true,"voting":true,"spotlight":true}';

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "board_authority",
    sql: `
      CREATE TABLE board (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        public_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        access_mode TEXT NOT NULL CHECK (access_mode IN ('private', 'link_view')),
        drawing_policy TEXT NOT NULL DEFAULT 'editors_enabled'
          CHECK (drawing_policy IN ('editors_enabled', 'owner_only', 'locked')),
        owner_actor_id TEXT NOT NULL,
        owner_recovery_hash BLOB NOT NULL,
        latest_seq INTEGER NOT NULL DEFAULT 0,
        next_z INTEGER NOT NULL DEFAULT 1,
        acl_version INTEGER NOT NULL DEFAULT 1,
        min_replay_seq INTEGER NOT NULL DEFAULT 0,
        latest_snapshot_seq INTEGER NOT NULL DEFAULT 0,
        dirty_since_seq INTEGER,
        dirty_since_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        archived_at_ms INTEGER
      );

      CREATE TABLE members (
        actor_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
        display_name TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER
      ) WITHOUT ROWID;

      CREATE UNIQUE INDEX members_one_active_owner
        ON members(role)
        WHERE role = 'owner' AND revoked_at_ms IS NULL;

      CREATE TABLE invitations (
        invitation_id TEXT PRIMARY KEY,
        token_hash BLOB NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
        label TEXT,
        max_uses INTEGER NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0,
        expires_at_ms INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER
      ) WITHOUT ROWID;

      CREATE TABLE items (
        item_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        z_order INTEGER NOT NULL,
        version_seq INTEGER NOT NULL,
        state_token TEXT NOT NULL,
        created_by TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        min_x REAL,
        min_y REAL,
        max_x REAL,
        max_y REAL
      ) WITHOUT ROWID;

      CREATE UNIQUE INDEX items_z_order ON items(z_order);
      CREATE INDEX items_live_paint_order ON items(deleted, z_order);

      CREATE TABLE actions (
        seq INTEGER PRIMARY KEY,
        action_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        affected_item_ids_json TEXT NOT NULL CHECK (json_valid(affected_item_ids_json)),
        undoable INTEGER NOT NULL CHECK (undoable IN (0, 1)),
        target_action_seq INTEGER,
        accepted_at_ms INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX actions_action_id ON actions(action_id);
      CREATE UNIQUE INDEX actions_command_id ON actions(command_id);

      CREATE TABLE history_entries (
        normal_action_seq INTEGER PRIMARY KEY,
        actor_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'undone', 'invalidated')),
        last_transition_seq INTEGER NOT NULL
      );

      CREATE INDEX history_undo_stack
        ON history_entries(actor_id, state, normal_action_seq DESC);
      CREATE INDEX history_redo_stack
        ON history_entries(actor_id, state, last_transition_seq DESC);

      CREATE TABLE history_state (
        actor_id TEXT PRIMARY KEY,
        history_version INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE snapshots (
        seq INTEGER PRIMARY KEY,
        r2_json_key TEXT NOT NULL,
        r2_svg_key TEXT,
        sha256 TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        byte_count INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('automatic', 'named', 'pre_clear')),
        label TEXT,
        created_by TEXT,
        created_at_ms INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX snapshots_r2_json_key ON snapshots(r2_json_key);

      CREATE TABLE scheduled_jobs (
        job_name TEXT PRIMARY KEY,
        due_at_ms INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        updated_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 2,
    name: "http_idempotency_and_usage",
    sql: `
      CREATE TABLE http_receipts (
        actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        status INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (actor_id, idempotency_key, operation)
      ) WITHOUT ROWID;

      CREATE INDEX http_receipts_created_at ON http_receipts(created_at_ms);

      CREATE TABLE usage_counters (
        day_utc TEXT PRIMARY KEY,
        incoming_frames INTEGER NOT NULL DEFAULT 0,
        billed_request_estimate INTEGER NOT NULL DEFAULT 0,
        rows_read_estimate INTEGER NOT NULL DEFAULT 0,
        rows_written_estimate INTEGER NOT NULL DEFAULT 0,
        r2_reads INTEGER NOT NULL DEFAULT 0,
        r2_writes INTEGER NOT NULL DEFAULT 0,
        r2_bytes INTEGER NOT NULL DEFAULT 0,
        actions INTEGER NOT NULL DEFAULT 0,
        snapshots INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
    `,
  },
  {
    version: 3,
    name: "action_compaction_lineage",
    sql: `
      ALTER TABLE history_entries ADD COLUMN action_id TEXT;
      ALTER TABLE history_entries ADD COLUMN payload_json TEXT
        CHECK (payload_json IS NULL OR json_valid(payload_json));

      UPDATE history_entries
      SET action_id = (
        SELECT actions.action_id FROM actions
        WHERE actions.seq = history_entries.normal_action_seq
      ),
      payload_json = (
        SELECT actions.payload_json FROM actions
        WHERE actions.seq = history_entries.normal_action_seq
      );

      CREATE UNIQUE INDEX history_entries_action_id ON history_entries(action_id)
        WHERE action_id IS NOT NULL;

      CREATE TABLE action_receipts (
        command_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        accepted_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX action_receipts_accepted_at
        ON action_receipts(accepted_at_ms);
    `,
  },
  {
    version: 4,
    name: "prospective_snapshot_accounting",
    sql: `
      ALTER TABLE board ADD COLUMN snapshot_live_item_count INTEGER NOT NULL DEFAULT -1
        CHECK (snapshot_live_item_count >= -1);
      ALTER TABLE board ADD COLUMN snapshot_live_item_bytes INTEGER NOT NULL DEFAULT -1
        CHECK (snapshot_live_item_bytes >= -1);
    `,
  },
  {
    version: 5,
    name: "checkpointed_usage_accounting",
    sql: `
      ALTER TABLE actions ADD COLUMN usage_incoming_frames INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE actions ADD COLUMN usage_rows_read_estimate INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE actions ADD COLUMN usage_rows_written_estimate INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE actions ADD COLUMN usage_r2_reads INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE actions ADD COLUMN usage_r2_writes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE actions ADD COLUMN usage_r2_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE actions ADD COLUMN usage_snapshots INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE board ADD COLUMN usage_checkpoint_seq INTEGER NOT NULL DEFAULT 0;

      -- Existing actions predate per-action accounting. Start the durable
      -- checkpoint cursor at the current authority rather than presenting
      -- invented zero-cost estimates for historical traffic.
      UPDATE board SET usage_checkpoint_seq = latest_seq;
    `,
  },
  {
    version: 6,
    name: "classroom_multi_owner",
    sql: `
      DROP INDEX members_one_active_owner;

      ALTER TABLE board ADD COLUMN classroom_mode INTEGER NOT NULL DEFAULT 0
        CHECK (classroom_mode IN (0, 1));
    `,
  },
  {
    version: 7,
    name: "durable_activity_attribution",
    sql: `
      CREATE TABLE activity_log (
        seq INTEGER PRIMARY KEY,
        action_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        affected_item_ids_json TEXT NOT NULL CHECK (json_valid(affected_item_ids_json)),
        accepted_at_ms INTEGER NOT NULL
      );

      INSERT INTO activity_log(
        seq, action_id, actor_id, display_name, kind, affected_item_ids_json, accepted_at_ms
      )
      SELECT seq, action_id, actor_id,
        CASE WHEN json_type(payload_json, '$.publicResult.actor.displayName') = 'text'
          THEN json_extract(payload_json, '$.publicResult.actor.displayName')
          ELSE 'Participant'
        END,
        kind, affected_item_ids_json, accepted_at_ms
      FROM actions;

      CREATE TRIGGER actions_activity_log_after_insert
      AFTER INSERT ON actions
      BEGIN
        INSERT INTO activity_log(
          seq, action_id, actor_id, display_name, kind, affected_item_ids_json, accepted_at_ms
        ) VALUES (
          NEW.seq, NEW.action_id, NEW.actor_id,
          CASE WHEN json_type(NEW.payload_json, '$.publicResult.actor.displayName') = 'text'
            THEN json_extract(NEW.payload_json, '$.publicResult.actor.displayName')
            ELSE 'Participant'
          END,
          NEW.kind, NEW.affected_item_ids_json, NEW.accepted_at_ms
        );
      END;
    `,
  },
  {
    version: 8,
    name: "private_board_image_assets",
    sql: `
      ALTER TABLE board ADD COLUMN images_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (images_enabled IN (0, 1));

      CREATE TABLE board_assets (
        asset_id TEXT PRIMARY KEY
          CHECK (length(asset_id) = 49 AND substr(asset_id, 1, 6) = 'asset_'),
        sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 43),
        r2_key TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL
          CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
        intrinsic_width INTEGER NOT NULL CHECK (intrinsic_width BETWEEN 1 AND 4096),
        intrinsic_height INTEGER NOT NULL CHECK (intrinsic_height BETWEEN 1 AND 4096),
        byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 5242880),
        state TEXT NOT NULL CHECK (state IN ('pending', 'committed')),
        created_by TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        committed_at_ms INTEGER
      ) WITHOUT ROWID;

      CREATE INDEX board_assets_state_created_at
        ON board_assets(state, created_at_ms);
    `,
  },
  {
    version: 9,
    name: "item_content_attribution",
    sql: `
      CREATE TABLE item_attribution (
        item_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) WITHOUT ROWID;

      CREATE TABLE snapshot_attribution (
        seq INTEGER PRIMARY KEY,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      );
    `,
  },
  {
    version: 10,
    name: "organisation_scoped_boards",
    sql: `
      ALTER TABLE board ADD COLUMN organisation_id TEXT
        CHECK (
          organisation_id IS NULL OR (
            length(organisation_id) = 24 AND
            substr(organisation_id, 1, 2) = 'o_' AND
            organisation_id NOT GLOB '*[^A-Za-z0-9_-]*'
          )
        );

      ALTER TABLE board ADD COLUMN organisation_mode INTEGER NOT NULL DEFAULT 0
        CHECK (
          (organisation_mode = 0 AND organisation_id IS NULL) OR
          (organisation_mode = 1 AND organisation_id IS NOT NULL)
        );

      ALTER TABLE board ADD COLUMN organisation_space_id TEXT;
    `,
  },
  {
    version: 11,
    name: "board_feature_settings",
    sql: `
      ALTER TABLE board ADD COLUMN features_json TEXT NOT NULL
        DEFAULT '${MIGRATION_11_DEFAULT_FEATURES_JSON}'
        CHECK (json_valid(features_json));

      -- Image uploads predate the complete feature map. Carry their effective
      -- value forward once, then keep the legacy column mirrored while older
      -- code paths are removed.
      UPDATE board
      SET features_json = replace(features_json, '"images":false', '"images":true')
      WHERE images_enabled = 1;
    `,
  },
  {
    version: 12,
    name: "organisation_participant_identifiers",
    sql: `
      ALTER TABLE members ADD COLUMN external_participant_id TEXT;
    `,
  },
  {
    version: 13,
    name: "object_comments",
    sql: `
      CREATE TABLE comments (
        comment_id TEXT PRIMARY KEY
          CHECK (
            length(comment_id) = 24 AND
            substr(comment_id, 1, 2) = 'c_' AND
            comment_id NOT GLOB '*[^A-Za-z0-9_-]*'
          ),
        target_item_id TEXT NOT NULL,
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'orphaned')),
        created_by TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        resolved_by TEXT,
        resolved_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL,
        CHECK (
          (state = 'resolved' AND resolved_by IS NOT NULL AND resolved_at_ms IS NOT NULL) OR
          (state != 'resolved' AND resolved_by IS NULL AND resolved_at_ms IS NULL)
        )
      ) WITHOUT ROWID;

      CREATE INDEX comments_target_state
        ON comments(target_item_id, state, created_at_ms);
      CREATE INDEX comments_state_updated
        ON comments(state, updated_at_ms DESC);
    `,
  },
  {
    version: 14,
    name: "comment_assistance",
    sql: `
      ALTER TABLE comments ADD COLUMN assisted_by TEXT
        CHECK (assisted_by IS NULL OR assisted_by = 'ai');
      ALTER TABLE comments ADD COLUMN assistance_tool TEXT
        CHECK (assistance_tool IS NULL OR (length(assistance_tool) BETWEEN 1 AND 64));
      ALTER TABLE comments ADD COLUMN assistance_action TEXT
        CHECK (assistance_action IS NULL OR length(assistance_action) <= 32);
    `,
  },
  {
    version: 15,
    name: "comment_media",
    sql: `
      ALTER TABLE comments ADD COLUMN media_kind TEXT
        CHECK (media_kind IS NULL OR media_kind IN ('image', 'video'));
      ALTER TABLE comments ADD COLUMN media_json TEXT
        CHECK (
          (media_json IS NULL AND media_kind IS NULL) OR
          (media_json IS NOT NULL AND media_kind IS NOT NULL AND
           length(media_json) BETWEEN 2 AND 4096)
        );
    `,
  },
] as const;

export const ORGANISATION_SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "organisation_templates",
    sql: `
      CREATE TABLE organisation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        organisation_id TEXT NOT NULL UNIQUE
          CHECK (
            length(organisation_id) = 24 AND
            substr(organisation_id, 1, 2) = 'o_' AND
            organisation_id NOT GLOB '*[^A-Za-z0-9_-]*'
          ),
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE templates (
        template_id TEXT PRIMARY KEY
          CHECK (length(template_id) = 26 AND substr(template_id, 1, 4) = 'tpl_'),
        name TEXT NOT NULL,
        description TEXT,
        items_json TEXT NOT NULL CHECK (json_valid(items_json)),
        byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 2 AND 524288),
        created_by TEXT NOT NULL
          CHECK (length(created_by) = 24 AND substr(created_by, 1, 2) = 'a_'),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX templates_updated_at
        ON templates(updated_at_ms DESC, template_id);

      CREATE TABLE spaces (
        board_id TEXT PRIMARY KEY
          CHECK (length(board_id) = 24 AND substr(board_id, 1, 2) = 'b_'),
        space_id TEXT NOT NULL,
        title TEXT NOT NULL,
        archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
        members_json TEXT NOT NULL CHECK (json_valid(members_json)),
        settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
        updated_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX spaces_updated_at
        ON spaces(updated_at_ms DESC, board_id);
    `,
  },
  {
    version: 2,
    name: "organisation_webhook_settings",
    sql: `
      ALTER TABLE organisation ADD COLUMN webhook_url TEXT;
      ALTER TABLE organisation ADD COLUMN webhook_updated_by TEXT;
      ALTER TABLE organisation ADD COLUMN webhook_updated_at_ms INTEGER;
    `,
  },
] as const;

export function applyMigrations(
  storage: DurableObjectStorage,
  telemetry: DurableObjectTelemetryContext = {
    environment: "unknown",
    workerVersionId: "unknown",
    durableObjectVersion: "unknown",
  },
): void {
  const sql = storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at_ms INTEGER NOT NULL
    )
  `);

  const applied = new Map(
    sql
      .exec<{ version: number; name: string }>(
        "SELECT version, name FROM _sql_schema_migrations ORDER BY version",
      )
      .toArray()
      .map((row) => [row.version, row.name]),
  );

  for (const migration of SCHEMA_MIGRATIONS) {
    const existingName = applied.get(migration.version);
    if (existingName !== undefined && existingName !== migration.name) {
      throw new Error(`Schema migration ${migration.version} has an unexpected name.`);
    }
    if (existingName !== undefined) continue;
    storage.transactionSync(() => {
      const raced = sql
        .exec<{ name: string }>(
          "SELECT name FROM _sql_schema_migrations WHERE version = ?",
          migration.version,
        )
        .toArray()[0];
      if (raced !== undefined) {
        if (raced.name !== migration.name) throw new Error("Schema migration ledger conflict.");
        return;
      }
      sql.exec(migration.sql);
      sql.exec(
        "INSERT INTO _sql_schema_migrations(version, name, applied_at_ms) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        Date.now(),
      );
    });
    safeLog("info", "schema.migrated", {
      ...telemetry,
      result: migration.name,
      seq: migration.version,
    });
  }
}

export function applyOrganisationMigrations(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at_ms INTEGER NOT NULL
    )
  `);

  const applied = new Map(
    sql
      .exec<{ version: number; name: string }>(
        "SELECT version, name FROM _sql_schema_migrations ORDER BY version",
      )
      .toArray()
      .map((row) => [row.version, row.name]),
  );

  for (const migration of ORGANISATION_SCHEMA_MIGRATIONS) {
    const existingName = applied.get(migration.version);
    if (existingName !== undefined && existingName !== migration.name) {
      throw new Error(`Organisation schema migration ${migration.version} has an unexpected name.`);
    }
    if (existingName !== undefined) continue;
    storage.transactionSync(() => {
      const raced = sql
        .exec<{ name: string }>(
          "SELECT name FROM _sql_schema_migrations WHERE version = ?",
          migration.version,
        )
        .toArray()[0];
      if (raced !== undefined) {
        if (raced.name !== migration.name) {
          throw new Error("Organisation schema migration ledger conflict.");
        }
        return;
      }
      sql.exec(migration.sql);
      sql.exec(
        "INSERT INTO _sql_schema_migrations(version, name, applied_at_ms) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        Date.now(),
      );
    });
  }
}
