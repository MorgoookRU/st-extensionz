# Extensionz для SillyTavern

Набор из семи модулей в одной установке. English version is [below](#english). Каждый модуль включается и выключается отдельно
(**Расширения → Extensionz**), интерфейс на русском и английском (язык выбирается автоматически или вручную).

| Модуль | Что делает |
|---|---|
| 🕵️ **Папа пришёл** | Одно нажатие — и аватарки и картинки превращаются в чёрные прямоугольники, фон исчезает, а «интересные» предложения закрываются чёрными полосами, как в рассекреченных документах. Повторное нажатие возвращает всё как было |
| 🔍 **Поиск по чату и закладки** | Поиск по всему чату, включая старые незагруженные сообщения и свайпы. Закладки на важные сообщения |
| 💾 **Черновики и история ввода** | Набираемый текст не теряется при перезагрузке, закрытии вкладки и переключении чатов. История отправленных сообщений |
| 🧹 **Детектор клише** | Подчёркивает нейросетевые штампы («мурашки по коже», «голос, едва громче шёпота», *shivers down her spine*), считает статистику и может попросить модель их избегать |
| 🔔 **Уведомления и «не гасить экран»** | Звук, вибрация или мигающая вкладка, когда ответ готов. Экран не гаснет, пока модель пишет |
| 📂 **Папки SillyTavern** | Кнопка «Папка SillyTavern» и значки папок в панелях: в приложении для Android открывает встроенный файловый менеджер, в остальных случаях копирует путь |
| ⚡ **Оптимизация (телефон)** | Облегчает интерфейс, не меняя внешний вид (проверено с Moonlit Echoes), плюс скрипты, которые снижают память сервера Node.js |

Проверено на SillyTavern **1.19.0** в Chrome на ПК и в мобильном режиме.

Есть и **приложение для Android** (APK), в котором таверна работает прямо на телефоне, без Termux. См. [ниже](#-приложение-для-android-apk).

## Установка

1. В SillyTavern откройте **Расширения** (иконка с кубиками) → **Install extension**.
2. Вставьте ссылку на репозиторий и нажмите **Install**:
   ```
   https://github.com/MorgoookRU/st-extensionz
   ```
3. Кнопки появятся в меню «волшебной палочки» (слева от поля ввода), настройки — в **Расширения → Extensionz**.

Расширение обновляется автоматически вместе с остальными (`auto_update`).

---

## 🕵️ Папа пришёл (режим паники)

**Как включить** — любым из способов (выключается так же):

- меню ✨ → **Папа пришёл**;
- **Alt + X** (сочетание можно поменять; работает на любой раскладке, в том числе на русской);
- двойное нажатие **Esc**;
- **плавающая кнопка** поверх страницы (включается в настройках, её можно перетащить) — самый быстрый способ на телефоне;
- **касание тремя пальцами** (включается в настройках);
- команда `/panic` (`/panic on`, `/panic off`).

**Что происходит:**

- аватарки, картинки в сообщениях и большие аватарки темы (Moonlit Echoes: стили Echo и Whisper) превращаются
  в сплошные чёрные прямоугольники того же размера, спрайты и фон чата убираются (или всё сильно размывается — на выбор);
- предложения с ключевыми словами закрываются сплошными чёрными полосами. Можно закрашивать всё предложение, только само слово или весь абзац;
- по желанию закрашиваются имена персонажей и персоны — и в тексте, и в заголовках сообщений;
- «случайная цензура» закрывает ещё и часть обычных предложений, чтобы страница выглядела как настоящий рассекреченный файл;
- вкладка браузера переименовывается в «Документ без названия» со значком документа;
- музыка, видео и озвучка ставятся на паузу и продолжаются после отбоя;
- прячутся открытые боковые панели (список персонажей, карточка, World Info) и размывается поле ввода;
- новые сообщения, в том числе приходящие потоком, закрашиваются сразу, до отрисовки на экране.

Сам чат **не изменяется**: всё делается стилями и временной разметкой поверх текста, после отбоя страница
возвращается в исходное состояние.

**Ключевые слова** — по одному в строке или через запятую:

| Запись | Что найдёт |
|---|---|
| `поцелуй` | само слово и его формы: *поцелуя, поцелуем, поцелуями* (для английского: *kiss → kisses, kissed, kissing*) |
| `поцел*` | всё, что начинается на «поцел» |
| `"кровь"` | строго это слово, без других форм |
| `дрожь по спине` | фразу целиком |
| `/регулярка/` | регулярное выражение JavaScript |
| `# текст` | комментарий |

Буквы «е» и «ё» считаются одинаковыми. В комплекте есть готовый список (романтика/18+, насилие, мат —
на русском и английском); его можно отредактировать или вернуть кнопкой «Сбросить по умолчанию».

Опция **«Подсмотреть, зажав полосу»** показывает текст под полосой, только пока вы держите на нём палец или кнопку мыши.

## 🔍 Поиск по чату и закладки

- **Поиск** (меню ✨, **Ctrl + Shift + F** или `/chat-search запрос`) ищет по всем сообщениям чата, в том
  числе по тем, что ещё не загружены на экран, по альтернативным свайпам и (по желанию) по размышлениям.
  Если ввести несколько слов, найдутся сообщения, где есть все; `"точная фраза"` ищется целиком. Есть фильтр
  «Все / Мои / Персонаж». Нажатие на результат прокручивает к сообщению и подсвечивает найденное.
- Кнопки **«В начало» / «В конец»** и **переход к сообщению по номеру**.
- **Закладки**: кнопка ☆ в действиях сообщения (меню «…»), `/pin [номер]` или «В закладки последнее сообщение».
  Список закладок (`/pins`) с заметками. Закладки хранятся в файле чата и не сбиваются, даже если удалить сообщения выше.

## 💾 Черновики и история ввода

- Текст в поле ввода сохраняется для каждого чата отдельно и восстанавливается после перезагрузки, закрытия
  вкладки (актуально для Android, где браузер выгружает вкладки) и переключения между чатами.
- **Alt + ↑ / Alt + ↓** в поле ввода листают ранее отправленные сообщения, как история команд в терминале.
- **История ввода** (меню ✨ или `/input-history`): отправленные сообщения и последний черновик чата — если
  случайно стёрли текст, его можно вернуть.

## 📂 Папки SillyTavern

- Меню ✨ → **Папка SillyTavern**: список папок (все данные, персонажи, чаты, чаты текущего персонажа,
  фоны, аватарки персон, лорбуки, картинки из чатов, вложения, темы, расширения, бэкапы).
- Значок папки появляется рядом с «Импортом» в списке персонажей, World Info, фонах и персонах.
- Команда `/folder characters` (или `chats`, `backgrounds`, `personas`, `worlds`…).
- **В приложении для Android** папка открывается во встроенном файловом менеджере: просмотр, открытие файлов,
  импорт с телефона (кнопка «Импорт файлов»), «Поделиться», переименование и удаление. После возврата таверна
  сама обновляет списки персонажей, лорбуков, фонов и персон.
- **В Termux или на ПК** копируется путь к папке. В Termux папки видны в разделе «Termux» приложения «Файлы».

## 🧹 Детектор клише

- Подчёркивает заезженные фразы в ответах ИИ (волнистой линией, пунктиром или маркером, цвет настраивается).
- **Статистика чата** (меню ✨ или `/slop`): клише на 1000 слов, оценка, график по последним ответам
  (нажатие на столбик переходит к сообщению) и самые частые фразы.
- **«Скопировать как инструкцию»** — готовая строка для Author's Note или системного промпта.
- **Инструкция против клише** (выключена по умолчанию): после каждого ответа в промпт добавляется короткая
  системная заметка с самыми частыми клише текущего чата, чтобы модель их избегала. Настраиваются число фраз,
  глубина вставки и текст шаблона.

Список фраз использует тот же синтаксис, что и ключевые слова.

## 🔔 Уведомления и «не гасить экран»

- Когда ответ готов — короткий звуковой сигнал, вибрация (на телефоне), мигающее название вкладки и/или
  системное уведомление. По умолчанию срабатывает, только если вкладка в фоне, и не срабатывает на быстрых ответах.
- В режиме паники уведомления молчат.
- **Wake Lock**: экран не гаснет, пока генерируется ответ, поэтому телефон не засыпает и не обрывает генерацию.
  Нужен HTTPS или адрес `localhost` / `127.0.0.1`.

## ⚡ Оптимизация для телефона

Модуль ничего не меняет во внешнем виде темы. Замеры на SillyTavern 1.19 с Moonlit Echoes (стиль Echo),
аватаром 2048×3072, фоном 4K и чатом на 1500 сообщений в эмуляции телефона:

| | Без оптимизации | С оптимизацией |
|---|---|---|
| Стриминг ответа (80 перерисовок) | 4,8 с | 1,6 с |
| 60 новых сообщений за сессию | 12,5 с | 5,6 с |
| Элементов на странице | 21 359 | 14 759 |
| Фон 4K в памяти | 31,6 МБ | 7,2 МБ |
| Аватар 2048×3072 в памяти | 24,0 МБ | 8,5 МБ |

Попиксельное сравнение скриншотов: стиль Whisper совпадает на 99,97%, в Echo отличаются только края букв (сглаживание).

**Незаметные оптимизации** (включены по умолчанию):

- сообщения за пределами экрана не отрисовываются, вместе с размытием и большими аватарками темы;
- пока вы внизу чата, на странице остаются только последние N сообщений. Старые возвращает «Show more messages»,
  как после открытия чата;
- огромные фоны и аватарки темы уменьшаются до разрешения экрана. Анимированные картинки не трогаются,
  файлы на диске не меняются;
- картинки в чате декодируются в фоне.

**Меняют внешний вид** (выключены): отключить размытие везде, анимации, тени; заморозить анимированный фон.

**Настройки таверны** — рекомендуемые значения с кнопкой «Применить» (сообщений при открытии чата,
частота обновлений при стриминге и т. д.). Сами по себе ничего не меняются.

**Проверка производительности** показывает число элементов на странице, сколько сообщений сейчас
не рисуется, сколько памяти заняли фон и аватарки до и после уменьшения.

### Сервер (Termux)

Из браузера сервер не настроить, для этого в папке `server/` лежат два скрипта:

```bash
# запуск таверны с экономией памяти Node.js (вместо ./start.sh)
bash ~/SillyTavern/data/default-user/extensions/st-extensionz/server/st-lite.sh

# один раз: облегчённый config.yaml (резервная копия сохраняется, откат: --revert)
node ~/SillyTavern/data/default-user/extensions/st-extensionz/server/apply-lite-config.mjs
```

- `st-lite.sh` запускает Node с флагами `--max-old-space-size=384 --max-semi-space-size=2 --optimize-for-size`
  (лимит меняется переменной `ST_HEAP_MB`), вызывает `termux-wake-lock` и не гоняет `npm install` при каждом
  старте, а только когда изменились зависимости.
- `apply-lite-config.mjs` выключает журнал запросов и автообновление расширений через git, ограничивает
  бэкапы чатов (по умолчанию их число не ограничено, а полная копия пишется раз в 10 секунд), включает ленивую
  загрузку карточек и запрещает скачивание локальных нейросетей. Комментарии в `config.yaml` сохраняются.
  Посмотреть изменения без записи: `--dry-run`.

Замер (чат на 1500 сообщений, подсчёт токенов, сохранение): память Node **358 → 277 МБ в простое,
456 → 283 МБ в пике**. Основной выигрыш дают флаги запуска. Конфиг уменьшает запись на диск и фоновую работу.

Ещё на Android:
- отключите для Termux оптимизацию батареи (Настройки → Приложения → Termux → Батарея → «Без ограничений»);
- на Android 12+ система может убивать фоновые процессы Termux. На Android 14+ это отключается в
  «Для разработчиков» → «Отключить ограничения дочерних процессов»;
- в Chrome «Добавить на главный экран» открывает таверну как отдельное приложение без адресной строки.

## 📱 Приложение для Android (APK)

Неофициальная сборка: SillyTavern и Node.js работают внутри приложения, Termux не нужен. Расширение Extensionz уже встроено.

- **Скачать**: [Releases](https://github.com/MorgoookRU/st-extensionz/releases), файл **SillyTavern-…-arm64.apk**
  (x86_64 для эмуляторов). Установка из браузера или файлового менеджера («Разрешить установку из этого источника»).
- **Первый запуск** распаковывает таверну и один раз собирает интерфейс, это около минуты. Потом запуск занимает секунды.
- **Память**: лимит памяти Node.js подбирается по объёму ОЗУ телефона (256/384/512 МБ), сервер запускается
  с облегчённым `config.yaml` и флагами экономии памяти. Приложение работает как foreground-сервис с уведомлением,
  поэтому Android не убивает его в фоне. Кнопка «Разрешить работу в фоне» снимает оптимизацию батареи.
- **Если система всё-таки выгрузила страницу**, приложение само перезагружает интерфейс, сервер при этом не падает.
- **Данные** лежат внутри приложения. Открыть их можно кнопками папок в таверне (встроенный файловый менеджер)
  или через системное приложение «Файлы» → боковое меню → **SillyTavern**.
- **Скачивания** (экспорт чатов и карточек) сохраняются в «Загрузки/SillyTavern».
- **Обновления**: новые сборки подписаны одним ключом, поэтому ставятся поверх старой версии без потери данных.
  Не удаляйте приложение перед обновлением: удаление стирает чаты.
- **Перенос из Termux**: в папках таверны (кнопка «Импорт файлов») можно скопировать карточки из `characters`,
  чаты из `chats`, фоны и т. д.
- Сервер слушает только `127.0.0.1:8123` и недоступен из сети.

## Слэш-команды

| Команда | Действие |
|---|---|
| `/panic [on\|off\|toggle]` | режим «Папа пришёл» (синоним `/dadcame`) |
| `/chat-search [запрос]` | открыть поиск по чату (синоним `/csearch`) |
| `/pin [номер]` | поставить/снять закладку (по умолчанию на последнее сообщение) |
| `/pins` | список закладок |
| `/input-history` | история ввода |
| `/slop` | статистика клише; возвращает число клише на 1000 слов |
| `/folder [имя]` | папки таверны (синоним `/folders`) |

## Где хранятся данные

- Настройки — в настройках SillyTavern (`extension_settings.stExtensionz`).
- Закладки — в метаданных файла чата.
- Черновики и история ввода — в `localStorage` браузера, на сервер не отправляются.
- Расширение ничего не отправляет в интернет.

---

## English

Seven modules in one install. Each one is switched on and off separately in **Extensions → Extensionz**.
The interface is in English and Russian: the language follows SillyTavern or can be chosen in the settings.

**Install**: **Extensions → Install extension** → `https://github.com/MorgoookRU/st-extensionz`. The buttons appear in the
wand menu (left of the input field). The extension updates itself with the others.

### 🕵️ Dad Came (panic mode)

Triggers (the same ones turn it off): wand menu → **Dad Came**, **Alt+X** (configurable, works on any keyboard layout),
double **Esc**, a draggable **floating button** (the fastest on a phone), a **three-finger tap**, or `/panic [on|off|toggle]`.

- Avatars, chat images and big theme avatars (Moonlit Echoes Echo and Whisper styles) become solid black rectangles of
  the same size. Sprites and the chat background disappear. Or everything is heavily blurred, whichever you choose.
- Sentences with keywords are covered with solid black bars. You can cover the sentence, only the word or the whole paragraph.
- Optionally character and persona names are covered too, and "random redaction" covers some ordinary sentences so the
  page looks like a real declassified file.
- The tab is renamed to "Untitled document", music, video and TTS are paused, side panels are hidden, the input is blurred.
- New messages, including streamed ones, are covered before they are drawn on screen.
- **Peek**: hold a finger or the mouse button on a bar to see the text under it.
- The chat itself is never modified.

Keywords, one per line or comma-separated: `kiss` (also *kisses, kissed, kissing*, and Russian word forms), `kiss*` (anything
starting with it), `"blood"` (this exact word), `shiver down the spine` (a phrase), `/regex/`, `# comment`.
A ready list (romance/18+, violence, swearing in English and Russian) is included. Reset it with "Reset to defaults".

### 🔍 Chat search and bookmarks

- **Search** (wand menu, **Ctrl+Shift+F** or `/chat-search query`) covers every message of the chat, including ones not loaded on
  screen, alternative swipes and, optionally, reasoning. Several words find messages containing all of them; `"exact phrase"`
  finds the phrase. Filter: All / Mine / Character. A tap on a result scrolls to the message and highlights the match.
- **Top / Bottom** buttons and **jump to message by number**.
- **Bookmarks**: the ☆ button in message actions, `/pin [number]`, the list with notes (`/pins`). Stored in the chat file,
  they stay correct even if messages above are deleted.

### 💾 Drafts and input history

- The text in the input field is kept per chat and restored after a reload, a closed tab (Android browsers unload tabs) or a chat switch.
- **Alt+↑ / Alt+↓** in the input go through sent messages like a terminal history.
- **Input history** (wand menu or `/input-history`): sent messages and the last draft of the chat.

### 📂 SillyTavern folders

- Wand menu → **SillyTavern folder**: all data, characters, chats (also of the current character), group chats, backgrounds,
  persona avatars, World Info, chat images, attachments, themes, extensions, backups. Folder icons also appear next to
  "Import" in the character list, World Info, backgrounds and personas. Command: `/folder characters` (or `chats`, `backgrounds`…).
- **In the Android app** the folder opens in the built-in file manager: open files, import from the phone, share, rename, delete.
  When you come back, SillyTavern refreshes the lists of characters, World Info, backgrounds and personas.
- **In Termux or on a PC** the folder path is copied.

### 🧹 Cliché radar

- Underlines worn-out AI phrases in replies (wavy, dotted or highlighter; the color is configurable).
- **Chat stats** (wand menu or `/slop`): clichés per 1000 words, a grade, a chart of recent replies and the most frequent phrases.
- **Copy as instruction** for the Author's Note or system prompt; the optional **anti-cliché note** adds the chat's most frequent
  clichés to the prompt so the model avoids them.

### 🔔 Reply notifications and wake lock

- A chime, vibration, blinking tab title or system notification when a reply is ready (by default only when the tab is in the
  background). Silent in panic mode.
- The screen stays on while a reply is generated (needs HTTPS or `localhost` / `127.0.0.1`).

### ⚡ Performance (phones)

Nothing changes in how your theme looks. Measured on SillyTavern 1.19 with Moonlit Echoes, a 2048×3072 avatar, a 4K background
and a 1500-message chat in phone emulation: streaming a reply 4.8 → 1.6 s, 60 new messages 12.5 → 5.6 s, page elements
21 359 → 14 759, background in memory 31.6 → 7.2 MB, avatar 24.0 → 8.5 MB.

- Off-screen messages are not rendered; while you are at the bottom only the last N messages stay on the page.
- Huge backgrounds and theme avatars are downscaled to screen resolution in memory (files on disk are untouched).
- Options that do change the look are off by default: no blur, no animations, no shadows, frozen animated background.
- Recommended SillyTavern settings with an "Apply" button, and a performance check.
- Server scripts for Termux: `server/st-lite.sh` starts Node.js with memory-saving flags, `server/apply-lite-config.mjs`
  writes a lighter `config.yaml` (with a backup; `--revert` restores it). Node.js memory: 358 → 277 MB idle, 456 → 283 MB peak.

### 📱 Android app (APK)

An unofficial build where SillyTavern and Node.js run inside the app, no Termux needed, with Extensionz built in.
Download **SillyTavern-…-arm64.apk** from [Releases](https://github.com/MorgoookRU/st-extensionz/releases).

- The first start unpacks SillyTavern and builds the interface once (about a minute); later starts take seconds.
- The Node.js memory limit follows the phone's RAM (256/384/512 MB); the server runs as a foreground service with a
  notification, and the app reloads the page by itself if Android kills the renderer.
- Data stays inside the app: open it with the folder buttons in SillyTavern or in the system Files app → side menu → **SillyTavern**.
- Downloads (exported chats and cards) go to Downloads/SillyTavern.
- Updates install over the old version and keep your data (all builds are signed with the same key). Do not uninstall first:
  uninstalling deletes the chats.
- The server listens on `127.0.0.1:8123` only.

### Slash commands

`/panic [on|off|toggle]` (`/dadcame`), `/chat-search [query]` (`/csearch`), `/pin [number]`, `/pins`, `/input-history`,
`/slop`, `/folder [name]` (`/folders`).

### Data

Settings are stored in SillyTavern settings (`extension_settings.stExtensionz`), bookmarks in the chat file metadata,
drafts and input history in the browser's `localStorage`. The extension sends nothing to the internet.
