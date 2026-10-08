<div align="center">

<img src="apps/windows/src-tauri/icons/128x128@2x.png" width="112" alt="AniMori">

# HAniMori

### Смотрите аниме и ведите списки AniList на русском — на ПК и ТВ. Доступен просмотри 18+ контента.

Неофициальный клиент AniList для Windows и Android TV. Программа сама обращается
к API и подставляет русские названия и описания из Shikimori —
браузер и менеджер скриптов не нужны.

[![Версия](https://img.shields.io/badge/версия-3.1.0-02A9FF?style=flat-square&labelColor=0B1622)](https://github.com/foulnike/Animori/releases)
[![Лицензия](https://img.shields.io/badge/лицензия-MIT-02A9FF?style=flat-square&labelColor=0B1622)](LICENSE)
[![Windows](https://img.shields.io/badge/Windows%2010%2F11-0078D4?style=flat-square&logo=windows&logoColor=white)](apps/windows)
[![Android TV](https://img.shields.io/badge/Android%20TV%207.0%2B-3DDC84?style=flat-square&logo=androidtv&logoColor=black)](apps/android-tv)

**[Скачать для Windows](https://github.com/foulnike/Animori/releases/latest)** ·
**[Скачать APK для Android TV](https://github.com/foulnike/Animori/releases)** ·
[Сборка из исходников](#сборка)

</div>

<p align="center">
  <img src="apps/windows/assets/screenshots/home.png" width="92%" alt="Главная: календарь выхода, продолжение просмотра, полки">
</p>

## Почему это удобно

- **Список открывается без сети.** Правки хранятся на устройстве: AniList не
  падает, страница не нужна. Статус, оценка, серии, пересмотры, даты и заметка
  меняются прямо в шторке.
- **Продолжение в один клик.** История помнит, где вы остановились.
- **Русские названия подставляет сама программа.** AniList даёт карточку,
  Shikimori — русский тайтл и описание.
- **Свой плеер внутри.** Серия, озвучка, качество, два источника.
- **Ни рекламы, ни телеметрии, ни своих серверов.** Токен, настройки и кэш лежат
  на вашей машине.
- **Список никуда не отправляется.** Изменения не уходят ни в AniList, ни в
  Шикимори.

## Настольное приложение

**Windows 10/11**, мышь и клавиатура. Установщик, MSI или портативный архив без
установки — в [выпусках](https://github.com/foulnike/Animori/releases/latest).

<table>
  <tr>
    <td width="50%"><img src="apps/windows/assets/screenshots/lists.jpg" alt="Моё: списки по статусам"><br><sub><b>Список.</b> Живёт на устройстве, открывается без сети.</sub></td>
    <td width="50%"><img src="apps/windows/assets/screenshots/media.jpg" alt="Карточка тайтла"><br><sub><b>Тайтл.</b> Русское описание, кадры, трейлер, персонажи, опенинги.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="apps/windows/assets/screenshots/stats.png" alt="Статистика"><br><sub><b>Статистика.</b> Время просмотра, ваши оценки против оценок сообщества.</sub></td>
    <td width="50%"><img src="apps/windows/assets/screenshots/settings.png" alt="Настройки"><br><sub><b>Настройки.</b> Темы, перенос списка, прокси, журнал отладки.</sub></td>
  </tr>
</table>

Перенос списка из AniList, с Шикимори по нику или файлом выгрузки MyAnimeList.
Спасти можно тем же XML, который принимают AniList, Шикимори и Kitsu, либо
копией в облако. Смотрите в отдельном окне или транслируйте на телевизор.
Подробности — в [apps/windows](apps/windows).

## Приложение для телевизора

**Android TV, Android 7.0 и новее**, управление с пульта.

<p align="center">
  <img src="apps/android-tv/screens/preview-calendar.png" width="23%" alt="Календарь выхода серий">
  <img src="apps/android-tv/screens/preview-recs.png" width="23%" alt="Полки рекомендаций">
  <img src="apps/android-tv/screens/preview-lists.png" width="23%" alt="Мои списки">
  <img src="apps/android-tv/screens/preview-card.png" width="23%" alt="Карточка тайтла">
</p>

<p align="center"><sub>Календарь · Рекомендации · Списки · Карточка</sub></p>

APK в [выпусках](https://github.com/foulnike/Animori/releases):
`AniMori_3.1.0_armv7.apk` для 32-разрядных приставок и `AniMori_3.1.0_arm64.apk`
для 64-разрядных. Установка из неизвестных источников, ставится с пульта.
Подробности — в [apps/android-tv](apps/android-tv).

## Сборка

Нужен Node.js 20 или новее; для Android дополнительно Android SDK и NDK.

```bash
npm ci
npm test
npm run typecheck
```

Разработка — из каталога приложения:

```bash
cd apps/windows   && npm run tauri dev
cd apps/android-tv && npm run tauri -- android dev
```

Выпуск делается тегом: `windows-v3.1.0` или `android-tv-v3.1.0`.

## Устройство репозитория

| Каталог | Что в нём |
| :--- | :--- |
| `packages/core` | Общее ядро: данные, снимок, облачная копия, видео |
| `apps/windows` | Настольное приложение: экраны и оболочка |
| `apps/android-tv` | Приложение для телевизора: экраны и оболочка |
| `docs` | Документация: правовая и для разработчиков — [оглавление](docs/README.md) |

## Лицензия

[MIT](LICENSE). Зависимости приходят со своими лицензиями — перечень в
[THIRD-PARTY.md](THIRD-PARTY.md), он собирается из `package-lock.json`. Русские названия и
описания приходят из [Shikimori](https://shikimori.one);
датасет собирается в [animori-data](https://github.com/foulnike/animori-data). Проект
неофициальный и с командой AniList не связан.

## Правовые документы

- [Политика обработки персональных данных](docs/PRIVACY.md) (русская и английская версии)
- [Условия использования](docs/TERMS.md) (русская и английская версии)
