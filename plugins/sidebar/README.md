# Makosh Sidebar

Project tree sorted by recent thread activity, with reversible hiding of projects and threads and a Show hidden toggle.

Right-click a project or thread and choose **Скрыть**. Use **Показать скрытое** at the top to reveal hidden entries, then **Вернуть** in their menus to restore them. Hidden projects hide their threads, including pinned threads. Nothing is deleted or archived. Preferences are saved only in this browser profile; they do not sync across clients. Internal BB helper threads stay excluded.

Projects and folders sort by their newest visible thread activity, including pinned threads. Empty projects follow; equal timestamps sort alphabetically. Select **Makosh Sidebar** under Settings → Appearance → Sidebar after installation.

Development: `npm ci`, `npm run check`, `npm run build`. Installation changes the running BB and requires owner approval. No project names, project order, archive state, or thread visibility fields are modified. Hidden settings use browser localStorage. Reloading resets the Show hidden toggle.

The tree layout is ported from Tree Sidebar (MIT); see the repository THIRD_PARTY_NOTICES.md. Live BB installation and visual acceptance are separate from unit checks.

Set **Корневая папка проектов** in plugin settings to an absolute directory path. That directory is omitted; its immediate folders are the first level. Projects outside it are omitted, with an exception for running threads. Empty root shows all project locations.

**Без проекта** is always present and starts collapsed, including when empty. Expand it to browse personal-project chats. Collapsed folders, pins and the projectless section show only running threads. Hidden projects or threads also expose running threads, which disappear again when execution ends. Running means starting, active or stopping; internal helper threads remain excluded. Preferences about hiding are preserved.

Branches emptied by thread hiding are omitted, including worktree branches. Originally empty projects remain available.

Hiding a project also hides separately registered descendant projects and worktrees under its directory. Running descendants remain visible independently. Path matching respects directory boundaries.

Threads with subthreads have a separate expand/collapse chevron. Collapsing keeps the parent navigable and shows only starting, active or stopping descendants, including deeper levels; expanding restores the full subtree. Finished descendants disappear while collapsed. Subtrees start expanded.

The **Активные** section shows running threads (starting, active, stopping) and threads the host marks unread until they are read. It includes all projects, including hidden ones and personal chats; archived/internal helper threads are excluded. Parent context is retained for an active subthread. A qualifying parent brings its subtree; subtrees start collapsed and expose running descendants according to the shared rules. Project lists keep their existing placement.

In Active only, collapsed subtrees also expose unread descendants so a completed result stays reachable until read. Other sections keep their running-only collapsed behavior.

### Длинные списки тредов

В каждой раскрытой папке по умолчанию показаны первые 5 тредов. Кнопка «Показать больше» раскрывает остальные, «Показать меньше» возвращает короткий список. В настройках плагина поле «Тредов в папке» принимает целое число от 1 до 1000. Вложенные папки не входят в лимит; раздел «Активные» не ограничивается.
