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
  -- Групповые чаты, где боту разрешено отвечать на обращения. Белый список:
  -- бот, которого добавили в чужой чат, молчит, пока админ его не включит, —
  -- иначе любой мог бы жечь дневной бюджет ИИ.
  CREATE TABLE group_chats (
    chat_id INTEGER PRIMARY KEY,
    title TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    added_by INTEGER,
    created_at TEXT NOT NULL
  );
  -- База ответов владельца: «на такое по смыслу — отвечай вот этим». Её видит
  -- модель в группах; точное совпадение отвечается сразу, без ИИ.
  CREATE TABLE canned_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Режим преподавателя: вместо группы у человека — он сам. teacher_ref —
  -- ключ человека (t<id> из справочника портала или w<hash> со страницы
  -- вебинаров), teacher_name — ФИО из реестра преподавателей.
  ALTER TABLE users ADD COLUMN teacher_mode INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN teacher_ref TEXT;
  ALTER TABLE users ADD COLUMN teacher_name TEXT;
  `,
  `
  -- Болталка в групповых чатах. chat_groups — чаты, где бот есть, и можно ли
  -- ему там отвечать (включает админ бота). chat_usage — расход по дням: и
  -- лимиты, и учёт токенов; как ai_usage, переживает /soon. chat_log — ответы
  -- бота людям в чатах: из них собирается контекст разговора; живёт 3 дня.
  CREATE TABLE chat_groups (
    chat_id INTEGER PRIMARY KEY,
    title TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    present INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE chat_usage (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id, day)
  );
  CREATE INDEX chat_usage_day ON chat_usage (day);
  CREATE TABLE chat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX chat_log_chat_user ON chat_log (chat_id, user_id, created_at);
  -- Эта миграция идёт после group_chats/canned_replies из первой версии
  -- бота в группах (она уже стоит на сервере). Включённые там чаты и лимит
  -- на чат переезжают сюда; база ответов переезжает в файл сценария при
  -- запуске (src/chat/importCanned.ts). Старые таблицы оставлены как есть.
  INSERT OR IGNORE INTO chat_groups (chat_id, title, enabled, present, updated_at)
    SELECT chat_id, title, enabled, 1, created_at FROM group_chats;
  INSERT OR IGNORE INTO meta (key, value)
    SELECT 'chat:limit:chat', value FROM meta WHERE key = 'group:dailyLimit' AND CAST(value AS INTEGER) > 0;
  `,
  // Журнал отправок растёт с каждой рассылкой: индексы, чтобы /soon (удаление
  // по пользователю) и ночная чистка (по дате) не перебирали всю таблицу.
  `
  CREATE INDEX IF NOT EXISTS notifications_log_user ON notifications_log (user_id);
  CREATE INDEX IF NOT EXISTS notifications_log_sent ON notifications_log (sent_at);
  `,
  `
  -- Слайды в личку теперь по умолчанию выключены у всех: включить можно в
  -- настройках. Рассылки ещё не было ни разу, так что выключаем и старым.
  UPDATE users SET want_slides = 0;
  -- Куда в групповых чатах слать слайды вебинаров: чат, тема форума (0 —
  -- общая), предмет и группа ('' — любая группа). Подписку делают прямо в
  -- чате: «@бот сюда слайды по физике».
  CREATE TABLE chat_slide_subs (
    chat_id INTEGER NOT NULL,
    thread_id INTEGER NOT NULL DEFAULT 0,
    subject TEXT NOT NULL,
    subject_norm TEXT NOT NULL,
    group_key TEXT NOT NULL DEFAULT '',
    group_title TEXT,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, thread_id, subject_norm, group_key)
  );
  CREATE INDEX chat_slide_subs_subject ON chat_slide_subs (subject_norm);
  -- Знакомства в чатах: «@ник это Фамилия Имя 12-23». Ник — в нижнем регистре
  -- без «@»; человека без ника знаем по id. Один ник — один человек.
  CREATE TABLE people_intros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    user_id INTEGER,
    name TEXT NOT NULL,
    group_title TEXT,
    chat_id INTEGER NOT NULL,
    introduced_by INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX people_intros_username ON people_intros (username) WHERE username IS NOT NULL;
  CREATE UNIQUE INDEX people_intros_user ON people_intros (user_id) WHERE user_id IS NOT NULL;
  -- Идеи для бота, которые предложили в чатах («а сделай, чтобы…»).
  CREATE TABLE feature_ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX feature_ideas_created ON feature_ideas (created_at);
  `,
  // Нижнее меню: «всегда на экране» / «сворачивается» (по умолчанию, NULL) /
  // «скрыто». menu_sent — отпечаток меню, которое у человека сейчас стоит:
  // присылаем меню заново, только когда оно правда поменялось, а не после
  // каждого перезапуска бота (свёрнутое меню раскрывалось бы само).
  `
  ALTER TABLE users ADD COLUMN menu_mode TEXT;
  ALTER TABLE users ADD COLUMN menu_sent TEXT;
  `,
  // Счётчики нажатий: какая кнопка и сколько раз за день — без id людей.
  // «Министерство Жалоб»: номер обращения и кому отвечать; текста здесь нет —
  // он только в чате админа. anon — админ не видит, кто это; blocked — от
  // этого отправителя обращения больше не принимаются.
  `
  CREATE TABLE ui_counters (
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key)
  );
  CREATE TABLE support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    anon INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX support_tickets_user ON support_tickets (user_id, created_at);
  CREATE TABLE support_blocks (
    user_id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  `,
  // Заявки студентов на запись своих пар (этап 2). rec_requests — заявка и её
  // состояние; envelope_json (шифровка логина и пароля) хранится только пока
  // расшифровка ещё законна, дальше обнуляется. rec_slots — зеркало слотов с
  // записывалки для экрана /slots и карты. recorder_state — открытый ключ
  // записывалки (его присылает сама записывалка в отчёте) и прочие пометки.
  `
  CREATE TABLE rec_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT,
    group_key TEXT NOT NULL,
    group_title TEXT NOT NULL,
    envelope_json TEXT,
    state TEXT NOT NULL,
    actual_group TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by INTEGER
  );
  CREATE INDEX rec_requests_user ON rec_requests (user_id, created_at);
  CREATE INDEX rec_requests_state ON rec_requests (state);
  CREATE TABLE rec_slots (
    group_key TEXT PRIMARY KEY,
    group_title TEXT NOT NULL,
    request_id INTEGER,
    status TEXT NOT NULL,
    last_ok_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE recorder_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // Чья учётка стоит в слоте записывалки — по её же отчёту (holder_id: номер
  // заявки, 0 — учётка из .env, NULL — записывалка не сообщила). Отзыв слота без
  // заявки запоминает этот номер (slot_holder), чтобы remove убрал ровно ту
  // учётку, что была в слоте, — в том числе осиротевшую учётку студента.
  `
  ALTER TABLE rec_slots ADD COLUMN holder_id INTEGER;
  ALTER TABLE rec_requests ADD COLUMN slot_holder INTEGER;
  `,
  // Пересдачи (ППА): страница группы с портала (разобранная), отметки долгов
  // человека (ключ предмета — subjectKey) и «уже спрашивали в этой волне ППА».
  `
  CREATE TABLE ppa_pages (
    portal_group_id INTEGER PRIMARY KEY,
    html_hash TEXT NOT NULL,
    items_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE ppa_debts (
    user_id INTEGER NOT NULL,
    group_key TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, group_key, subject_key)
  );
  CREATE TABLE ppa_asked (
    user_id INTEGER NOT NULL,
    group_key TEXT NOT NULL,
    wave TEXT NOT NULL,
    asked_at TEXT NOT NULL,
    PRIMARY KEY (user_id, group_key)
  );
  `,
  // Свои кнопки нижнего меню (⚙️ Настройки → 🧩 Кнопки внизу): ключи через
  // запятую в порядке меню; NULL — меню как у всех.
  `
  ALTER TABLE users ADD COLUMN menu_buttons TEXT;
  `,
  // Ссылки-подписки на календарь группы, которые выпускает админ (например,
  // организатору мероприятий): ни к кому не привязаны, живут сами по себе.
  // label — для кого выпущены; ppa — с пересдачами группы; revoked_at — отозвана
  // (ссылка больше не открывается).
  `
  CREATE TABLE cal_feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    group_key TEXT NOT NULL,
    label TEXT NOT NULL,
    ppa INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX cal_feeds_label ON cal_feeds (label);
  `,
  // Люди из мессенджера МАКС (src/max/): у них свой id, а весь бот живёт на
  // id Telegram. Каждому выдаётся внутренний uid от 2^52 — Telegram обещает id
  // не длиннее 52 бит, так что с его чатами uid не пересечётся никогда.
  `
  CREATE TABLE max_users (
    uid INTEGER PRIMARY KEY,
    max_id INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  `,
  // Кто забирает ленты календаря (воронка подписки в /stats): owner — чья
  // лента («u:<id>» личная, «f:<id>» ссылка группы от админа), client — чем
  // забирают (google, yandex, apple, outlook, browser, other; по User-Agent,
  // сам он не хранится). Одна лента на двух устройствах — две строки.
  `
  CREATE TABLE cal_fetches (
    owner TEXT NOT NULL,
    client TEXT NOT NULL,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    PRIMARY KEY (owner, client)
  );
  `,
  // Прямая запись пар в календарь человека (Google; потом Яндекс).
  // cal_links — подключение: зашифрованный refresh token (NULL — отключили),
  // календарь, созданный ботом, для какой группы он назван, состояние
  // (ok — пишем; revoked — доступ отозван; gone — календарь удалён; off —
  // отключил сам). cal_events — какие события бот поставил: uid пары →
  // id события и отпечаток содержимого; по ним сверка не плодит дублей и
  // после перезапуска. oauth_states — одноразовые метки входа (state), 30 минут.
  `
  CREATE TABLE cal_links (
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    token_enc TEXT,
    calendar_id TEXT,
    group_key TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    synced_at TEXT,
    error TEXT,
    PRIMARY KEY (user_id, provider)
  );
  CREATE TABLE cal_events (
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    uid TEXT NOT NULL,
    event_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    date TEXT NOT NULL,
    PRIMARY KEY (user_id, provider, uid)
  );
  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // Министерство Жалоб: блок снимается по номеру обращения. ticket_id — под
  // каким обращением блокировали: по нему блок находится и после /soon (тогда
  // support_tickets человека уже стёрты). Старым блокам — последнее обращение.
  `
  ALTER TABLE support_blocks ADD COLUMN ticket_id INTEGER;
  UPDATE support_blocks SET ticket_id = (SELECT MAX(id) FROM support_tickets t WHERE t.user_id = support_blocks.user_id);
  `,
];
