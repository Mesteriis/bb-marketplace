// The Russian texts of the Remote Hub interface in one place. Components ask for a key; nothing in a component is a literal
// sentence. Texts that come from the core as codes (errors, refusals) are mapped here too, so the core stays language-free.
const ru = {
  "app.title": "Remote Hub",

  "sidebar.search": "Поиск подключений и гостей",
  "sidebar.open": "Открыто сейчас",
  "sidebar.connections": "Подключения",
  "sidebar.ungrouped": "Без группы",
  "sidebar.empty": "Подключений пока нет",
  "sidebar.nothingFound": "Ничего не найдено",
  "sidebar.more": "ещё {count}…",
  "sidebar.add": "Добавить",
  "sidebar.add.profile": "Подключение SSH или RDP",
  "sidebar.add.pve": "Proxmox VE",
  "sidebar.add.import": "Импорт",
  "sidebar.edit": "Изменить",
  "sidebar.credentials": "Учётные данные",
  "sidebar.agents": "Активность агентов",

  "kind.terminal": "терминал",
  "kind.desktop": "рабочий стол",
  "kind.graphics": "графика",
  "kind.nodeShell": "оболочка",

  "pve.node": "Узел {name}",
  "pve.filter.all": "Все",
  "pve.filter.running": "Работают",
  "pve.filter.lxc": "LXC",
  "pve.filter.vm": "VM",
  "pve.stopped": "выключен",
  "pve.template": "шаблон",
  "pve.refresh": "Обновить",
  "pve.needsApproval": "macOS не разрешил этой сборке читать сохранённый пароль",
  "pve.allow": "Разрешить доступ",
  "pve.unreadable": "Список не прочитан ({code})",

  "session.connecting": "подключение",
  "session.active": "подключено",
  "session.waiting": "ждёт входа",
  "session.lost": "связь потеряна",
  "session.reconnecting": "переподключение {attempt} из {max}",
  "session.disconnected": "отключено",
  "session.notConnected": "не подключено",
  "session.error": "ошибка",
  "session.disconnect": "Отключить",
  "session.reconnect": "Переподключить",
  "session.close": "Закрыть",
  "session.drivenByYou": "управляете вы",
  "session.drivenByAgent": "управляет агент",
  "session.takeControl": "Взять управление",
  "session.scrollbackHint": "Прежний вывод — в прокрутке выше",

  "desk.empty.title": "Выберите подключение слева",
  "desk.empty.hint": "Открытые сессии остаются в списке «Открыто сейчас», пока вы их не закроете.",
  "desk.one": "Одна",
  "desk.two": "Две рядом",
  "desk.count": "{count} рядом",
} as const;

export type TextKey = keyof typeof ru;

/** The text of `key`, with `{name}` placeholders filled from `vars`. A placeholder with no value stays visible. */
export function tx(key: TextKey, vars?: Readonly<Record<string, string | number>>): string {
  const text: string = ru[key];
  if (vars === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** "1 гость", "2 гостя", "5 гостей": the count with the Russian plural form of [one, few, many]. */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  const form = mod100 >= 11 && mod100 <= 14 ? forms[2] : mod10 === 1 ? forms[0] : mod10 >= 2 && mod10 <= 4 ? forms[1] : forms[2];
  return `${n} ${form}`;
}
