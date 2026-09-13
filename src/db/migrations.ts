/** Ordered, append-only schema migrations. Never edit a shipped entry; add a new one. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    group_key TEXT,
    subgroup INTEGER,
    format TEXT NOT NULL DEFAULT 'both',
    notify_changes INTEGER NOT NULL DEFAULT 1,
    notify_session INTEGER NOT NULL DEFAULT 0,
    notify_notices INTEGER NOT NULL DEFAULT 1,
    remind_first_min INTEGER,
    remind_each_min INTEGER,
    evening_at TEXT,
    quiet_from TEXT,
    quiet_to TEXT,
    topics TEXT NOT NULL DEFAULT '[]',
    blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE watch_groups (
    user_id INTEGER NOT NULL,
    group_key TEXT NOT NULL,
    PRIMARY KEY (user_id, group_key)
  );

  CREATE TABLE portal_groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    group_key TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE pages (
    portal_group_id INTEGER NOT NULL,
    period INTEGER NOT NULL,
    html_hash TEXT NOT NULL,
    parsed_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    PRIMARY KEY (portal_group_id, period)
  );

  CREATE TABLE occurrences (
    group_key TEXT NOT NULL,
    date TEXT NOT NULL,
    position_key TEXT NOT NULL,
    period INTEGER NOT NULL,
    slot INTEGER,
    start INTEGER,
    "end" INTEGER,
    subject TEXT NOT NULL,
    type TEXT NOT NULL,
    room TEXT,
    teacher TEXT,
    subgroup INTEGER,
    is_distance INTEGER NOT NULL,
    status TEXT NOT NULL,
    extra_json TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (group_key, date, position_key)
  );
  CREATE INDEX idx_occurrences_date ON occurrences (date);

  CREATE TABLE change_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_key TEXT NOT NULL,
    date TEXT NOT NULL,
    period INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_change_events_notified ON change_events (notified, group_key);

  CREATE TABLE reminders_sent (
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (user_id, kind, ref)
  );

  CREATE TABLE notifications_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    sent_at TEXT NOT NULL
  );

  CREATE TABLE ai_usage (
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );

  CREATE TABLE poll_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    ok INTEGER,
    groups_total INTEGER,
    groups_changed INTEGER,
    events INTEGER,
    error TEXT
  );
  `,
];
