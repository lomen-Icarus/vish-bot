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
  `
  ALTER TABLE users ADD COLUMN stream_intake INTEGER;
  `,
  `
  UPDATE users SET notify_notices = 0;
  `,
  `
  CREATE TABLE ai_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reported INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE news_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL UNIQUE,
    title TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_scanned_at TEXT,
    last_error TEXT
  );
  CREATE TABLE news_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    external_id TEXT NOT NULL,
    url TEXT,
    published_at TEXT NOT NULL,
    text TEXT NOT NULL,
    photo_url TEXT,
    topic TEXT,
    title TEXT,
    sent_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (source_id, external_id)
  );
  CREATE TABLE news_complaints (
    item_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (item_id, user_id)
  );
  `,
  `
  ALTER TABLE users ADD COLUMN remind_distance_min INTEGER;
  ALTER TABLE users ADD COLUMN cal_token TEXT;
  ALTER TABLE users ADD COLUMN cal_alarm_min INTEGER;
  CREATE UNIQUE INDEX users_cal_token ON users (cal_token) WHERE cal_token IS NOT NULL;
  CREATE TABLE announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    admin_id INTEGER,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE TABLE webinars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    slot INTEGER,
    start INTEGER,
    "end" INTEGER,
    subject TEXT NOT NULL,
    type TEXT NOT NULL,
    teacher TEXT NOT NULL,
    position TEXT,
    degree TEXT,
    subgroup INTEGER,
    title TEXT,
    groups_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX webinars_date ON webinars (date);
  CREATE INDEX webinars_teacher ON webinars (teacher);
  `,
  `
  ALTER TABLE webinars ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 1;
  `,
  `
  CREATE INDEX idx_change_events_group_date ON change_events (group_key, date, id);
  `,
  `
  ALTER TABLE users ADD COLUMN poster_theme TEXT;
  `,
  `
  CREATE TABLE poisk_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    query TEXT NOT NULL,
    student TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX poisk_log_user_day ON poisk_log (user_id, day);
  `,
  `
  UPDATE users SET topics = '["announcements"]' WHERE topics IS NULL OR trim(topics) = '' OR trim(topics) = '[]';
  `,
  `
  CREATE TABLE teacher_map (
    key TEXT PRIMARY KEY,
    teacher_id INTEGER,
    name TEXT NOT NULL,
    vish INTEGER NOT NULL DEFAULT 0,
    groups_json TEXT NOT NULL DEFAULT '[]',
    subjects_json TEXT NOT NULL DEFAULT '[]',
    department TEXT,
    degree TEXT,
    photo_url TEXT,
    photo_file_id TEXT,
    source TEXT NOT NULL,
    checked_at TEXT
  );
  CREATE INDEX teacher_map_vish ON teacher_map (vish);
  CREATE INDEX teacher_map_teacher ON teacher_map (teacher_id);
  `,
  `
  CREATE TABLE watch_teachers (
    user_id INTEGER NOT NULL,
    teacher_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, teacher_id)
  );
  CREATE INDEX watch_teachers_teacher ON watch_teachers (teacher_id);
  `,
  `
  CREATE TABLE slide_decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    subject TEXT NOT NULL,
    teacher TEXT,
    title TEXT,
    groups_json TEXT NOT NULL DEFAULT '[]',
    slides INTEGER NOT NULL DEFAULT 0,
    file TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    file_id TEXT,
    sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX slide_decks_date ON slide_decks (date);
  ALTER TABLE users ADD COLUMN want_slides INTEGER NOT NULL DEFAULT 1;
  `,
  `
  -- «Усиленная анонимность»: бот перестаёт связывать этот телеграм-аккаунт с
  -- человеком из файла старост и не здоровается по имени. Выключается обратно.
  ALTER TABLE users ADD COLUMN anon INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Разовая уборка: до правки в тексте ошибки VK лежал полный адрес запроса
  -- вместе с сервисным токеном, и он оседал здесь (а оттуда шёл админу в
  -- /news_scan). Код больше так не делает, но старые строки надо стереть.
  UPDATE news_sources SET last_error = 'ошибка скрыта: в ней был токен, подробности в логах' WHERE last_error LIKE '%access_token%';
  `,
  `
  -- Как показывать преподавателя в расписании: bold (с выделением), plain
  -- (обычным текстом), off (не показывать вовсе).
  ALTER TABLE users ADD COLUMN teacher_view TEXT NOT NULL DEFAULT 'bold';
  `,
  `
  -- Режим преподавателя: вместо группы у человека — он сам. teacher_ref —
  -- ключ человека (t<id> из справочника портала или w<hash> со страницы
  -- вебинаров), teacher_name — ФИО из реестра преподавателей.
  ALTER TABLE users ADD COLUMN teacher_mode INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN teacher_ref TEXT;
  ALTER TABLE users ADD COLUMN teacher_name TEXT;
  `,
];
