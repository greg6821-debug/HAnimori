// packages/core/src/api/hentasis.ts
//
// Источник «hentasis» — страницы тайтла вида
// https://hentasis1.top/985-mecha-gishi-resta-no-daibouken.html
//
// API у сайта нет: скачиваем HTML и вынимаем список файлов плеера (PlayerJS).
// «Файл 1/2/3/4» на сайте перемешаны — порядок возвращаем ровно как на странице,
// без сортировки: это могут быть серии 1-2-3-4 или 1-2 и снова 1-2 с субтитрами.

/** Чем играем файл: mp4/hls — своим <video>, iframe — плеером сайта как есть. */
export type HentasisFileKind = 'mp4' | 'hls' | 'iframe';

export interface HentasisFile {
  /** Подпись кнопки: «Файл 1» или title из конфига плеера. */
  label: string;
  url: string;
  kind: HentasisFileKind;
}

export interface HentasisInfo {
  title?: string;
  poster?: string;
  files: HentasisFile[];
}

/** Загрузчик HTML. В приложении — fetch из @tauri-apps/plugin-http
 * (идёт через Rust, CORS не мешает); в тестах — любая заглушка. */
export type PageFetcher = (url: string) => Promise<string>;

/** Мусорные iframe: реклама и счётчики, не плееры. */
const IFRAME_JUNK =
  /(recaptcha|doubleclick|googletag|adservice|mc\.yandex|metrika|vk\.com\/js|oauth|telegram|banner|counter|googlesyndication)/i;

interface RawFile {
  url: string;
  label?: string;
}

/** Чистит строку: JS-эскейпы из конфигов плееров и HTML-сущности. */
function clean(raw: string): string {
  return raw
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

function absolutize(raw: string, base: string): string {
  const u = clean(raw);
  if (u === '') return '';
  if (u.startsWith('//')) return `https:${u}`;
  try {
    return new URL(u, base).toString();
  } catch {
    return '';
  }
}

function classify(url: string): HentasisFileKind {
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? '';
  if (path.endsWith('.m3u8')) return 'hls';
  if (/\.(mp4|webm|mkv|m4v)$/.test(path)) return 'mp4';
  return 'iframe';
}

/** Плейлист PlayerJS одной строкой: "u1,u2,u3"; префиксы качества вида [720p] отрезаем. */
function splitPlayerList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.replace(/\[[^\]]*\]/g, '').trim())
    .filter((part) => part !== '');
}

/** Значение строкового поля из объекта конфига: file: "..." или file: '...'. */
function quotedValue(chunk: string, key: string): string | undefined {
  const re = new RegExp(
    `["']?${key}["']?\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`,
    'i',
  );
  const found = re.exec(chunk);
  if (found === null) return undefined;
  return found[1] ?? found[2];
}

function pushUrl(
  raw: string,
  label: string | undefined,
  base: string,
  out: RawFile[],
  seen: Set<string>,
): void {
  const url = absolutize(raw, base);
  if (url === '' || !/^https?:\/\//i.test(url) || seen.has(url)) return;
  seen.add(url);
  out.push(label === undefined ? { url } : { url, label: clean(label) });
}

/** Файлы из конфига плеера: строка-плейлист или массив [{title:"Файл 1", file:"..."}]. */
function takeFromConfig(body: string, base: string, out: RawFile[], seen: Set<string>): void {
  const fileRe = /file\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\[[\s\S]*?\]))/gi;

  let match: RegExpExecArray | null;
  while ((match = fileRe.exec(body)) !== null) {
    if (match[1] !== undefined || match[2] !== undefined) {
      for (const url of splitPlayerList(match[1] ?? match[2] ?? '')) {
        pushUrl(url, undefined, base, out, seen);
      }
      continue;
    }

    // Массив объектов: у каждого свой title/file.
    const arrayBody = match[3] ?? '';
    const objectRe = /\{[^{}]*\}/g;
    let object: RegExpExecArray | null;
    while ((object = objectRe.exec(arrayBody)) !== null) {
      const chunk = object[0];
      const url = quotedValue(chunk, 'file');
      if (url === undefined) continue;
      pushUrl(url, quotedValue(chunk, 'title'), base, out, seen);
    }
  }
}

function extractFiles(html: string, pageUrl: string): RawFile[] {
  const out: RawFile[] = [];
  const seen = new Set<string>();

  // 1) Конфиги PlayerJS: new Playerjs({ ... file: ... })
  const playerRe = /Playerjs\s*\(([\s\S]{0,8000}?)\)\s*[;,)]?/gi;
  let player: RegExpExecArray | null;
  while ((player = playerRe.exec(html)) !== null) {
    takeFromConfig(player[1] ?? '', pageUrl, out, seen);
  }

  // 2) Любые inline-скрипты с file: — jwplayer.setup и самописные плееры
  if (out.length === 0) {
    const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let script: RegExpExecArray | null;
    while ((script = scriptRe.exec(html)) !== null) {
      takeFromConfig(script[1] ?? '', pageUrl, out, seen);
    }
  }

  // 3) Прямые mp4/m3u8 по всей странице
  if (out.length === 0) {
    const mediaRe = /(?:https?:)?\/\/[^\s"'`<>\\]+?\.(?:mp4|m3u8|m4v|webm)(?:\?[^\s"'`<>\\]*)?/gi;
    let media: RegExpExecArray | null;
    while ((media = mediaRe.exec(html)) !== null) {
      pushUrl(media[0] ?? '', undefined, pageUrl, out, seen);
    }
  }

  // 4) iframe-плееры внешних хостингов
  if (out.length === 0) {
    const frameRe = /<iframe[^>]+?src\s*=\s*["']([^"']+)["']/gi;
    let frame: RegExpExecArray | null;
    while ((frame = frameRe.exec(html)) !== null) {
      const url = absolutize(frame[1] ?? '', pageUrl);
      if (url !== '' && !IFRAME_JUNK.test(url)) pushUrl(url, undefined, pageUrl, out, seen);
    }
  }

  return out;
}

export async function getHentasisInfo(
  pageUrl: string,
  fetchPage: PageFetcher,
): Promise<HentasisInfo> {
  if (!/^https?:\/\//i.test(pageUrl)) {
    throw new Error('Нужна ссылка на страницу тайтла, например https://hentasis1.top/985-….html');
  }

  const html = await fetchPage(pageUrl);

  const rawTitle =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<title>([^<]*)<\/title>/i.exec(html)?.[1];
  const rawPoster =
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];

  const raw = extractFiles(html, pageUrl);
  if (raw.length === 0) {
    throw new Error(
      'Видео на странице не нашлось: проверь ссылку (нужна страница тайтла, а не каталог) ' +
        'или попробуй ещё раз — сайт иногда отдаёт заглушку.',
    );
  }

  const files: HentasisFile[] = raw.map((file, index) => ({
    label: file.label !== undefined && file.label !== '' ? file.label : `Файл ${index + 1}`,
    url: file.url,
    kind: classify(file.url),
  }));

  return {
    title: rawTitle === undefined ? undefined : clean(rawTitle),
    poster: rawPoster === undefined ? undefined : absolutize(rawPoster, pageUrl) || undefined,
    files,
  };
}
