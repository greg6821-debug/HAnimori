// packages/core/src/api/hentasis.ts
//
// Источник «Hentasis» (18+): DLE-сайт без API.
// Два дела: поиск страницы тайтла через поиск сайта (POST-форма DLE, AJAX-поиск,
// GET-фолбэки) по названиям с AniList и разбор страницы — список файлов плеера.
// «Файл 1/2/3/4» на сайте перемешаны — порядок возвращаем ровно как на странице.

export type HentasisFileKind = 'mp4' | 'hls' | 'iframe'

export interface HentasisFile {
  label: string
  url: string
  kind: HentasisFileKind
}

export interface HentasisInfo {
  title?: string
  poster?: string
  files: HentasisFile[]
}

export interface HentasisHit {
  url: string
  title: string
  score: number
}

/** pages — сколько страниц поиска реально обошли: по ней видно, ходил ли поиск вообще. */
export interface HentasisFindResult {
  best: HentasisHit | null
  candidates: HentasisHit[]
  pages: number
}

/** Параметры загрузки: поиск DLE ходит POST-ом с формой в теле. */
export interface PageRequestInit {
  method?: 'GET' | 'POST'
  body?: string
}

export type PageFetcher = (url: string, init?: PageRequestInit) => Promise<string>

export interface HentasisFindOptions {
  minScore?: number;
  strongScore?: number;
  maxRequests?: number;
  /** Год выпуска с AniList: кандидаты с совпавшим годом получают буст при ранжировании. */
  year?: number;
}

const DEFAULT_FIND: Required<HentasisFindOptions> = {
  minScore: 65,
  strongScore: 85,
  maxRequests: 24,
}

/** Адрес страницы тайтла на DLE: /1094-onaji-zemi-no-someya-san.html */
const TITLE_PAGE_RE = /\/\d+-[a-z0-9-]+\.html(?:[?#].*)?$/i

export function isTitlePageUrl(url: string): boolean {
  return TITLE_PAGE_RE.test(url)
}

/** Мусорные iframe: реклама и счётчики, не плееры. */
const IFRAME_JUNK =
  /(recaptcha|doubleclick|googletag|adservice|mc\.yandex|metrika|vk\.com\/js|oauth|telegram|banner|counter|googlesyndication)/i

interface RawFile {
  url: string
  label?: string
}

function clean(raw: string): string {
  return raw
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim()
}

function absolutize(raw: string, base: string): string {
  const u = clean(raw)
  if (u === '') return ''
  if (u.startsWith('//')) return `https:${u}`
  try {
    return new URL(u, base).toString()
  } catch {
    return ''
  }
}

function classify(url: string): HentasisFileKind {
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? ''
  if (path.endsWith('.m3u8')) return 'hls'
  if (/\.(mp4|webm|mkv|m4v)$/.test(path)) return 'mp4'
  return 'iframe'
}

function splitPlayerList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.replace(/\[[^\]]*\]/g, '').trim())
    .filter((part) => part !== '')
}

function quotedValue(chunk: string, key: string): string | undefined {
  const re = new RegExp(
    `["']?${key}["']?\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`,
    'i',
  )
  const found = re.exec(chunk)
  if (found === null) return undefined
  return found[1] ?? found[2]
}

function pushUrl(
  raw: string,
  label: string | undefined,
  base: string,
  out: RawFile[],
  seen: Set<string>,
): void {
  const url = absolutize(raw, base)
  if (url === '' || !/^https?:\/\//i.test(url) || seen.has(url)) return
  seen.add(url)
  out.push(label === undefined ? { url } : { url, label: clean(label) })
}

function takeFromConfig(body: string, base: string, out: RawFile[], seen: Set<string>): void {
  const fileRe = /file\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\[[\s\S]*?\]))/gi

  let match: RegExpExecArray | null
  while ((match = fileRe.exec(body)) !== null) {
    if (match[1] !== undefined || match[2] !== undefined) {
      for (const url of splitPlayerList(match[1] ?? match[2] ?? '')) {
        pushUrl(url, undefined, base, out, seen)
      }
      continue
    }

    const arrayBody = match[3] ?? ''
    const objectRe = /\{[^{}]*\}/g
    let object: RegExpExecArray | null
    while ((object = objectRe.exec(arrayBody)) !== null) {
      const chunk = object[0]
      const url = quotedValue(chunk, 'file')
      if (url === undefined) continue
      pushUrl(url, quotedValue(chunk, 'title'), base, out, seen)
    }
  }
}

function extractFiles(html: string, pageUrl: string): RawFile[] {
  const out: RawFile[] = []
  const seen = new Set<string>()

  const playerRe = /Playerjs\s*\(([\s\S]{0,8000}?)\)\s*[;,)]?/gi
  let player: RegExpExecArray | null
  while ((player = playerRe.exec(html)) !== null) {
    takeFromConfig(player[1] ?? '', pageUrl, out, seen)
  }

  if (out.length === 0) {
    const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi
    let script: RegExpExecArray | null
    while ((script = scriptRe.exec(html)) !== null) {
      takeFromConfig(script[1] ?? '', pageUrl, out, seen)
    }
  }

  if (out.length === 0) {
    const mediaRe = /(?:https?:)?\/\/[^\s"'`<>\\]+?\.(?:mp4|m3u8|m4v|webm)(?:\?[^\s"'`<>\\]*)?/gi
    let media: RegExpExecArray | null
    while ((media = mediaRe.exec(html)) !== null) {
      pushUrl(media[0], undefined, pageUrl, out, seen)
    }
  }

  if (out.length === 0) {
    const frameRe = /<iframe[^>]+?src\s*=\s*["']([^"']+)["']/gi
    let frame: RegExpExecArray | null
    while ((frame = frameRe.exec(html)) !== null) {
      const url = absolutize(frame[1] ?? '', pageUrl)
      if (url !== '' && !IFRAME_JUNK.test(url)) pushUrl(url, undefined, pageUrl, out, seen)
    }
  }

  return out
}

export async function getHentasisInfo(
  pageUrl: string,
  fetchPage: PageFetcher,
): Promise<HentasisInfo> {
  if (!/^https?:\/\//i.test(pageUrl)) {
    throw new Error('Нужна ссылка на страницу тайтла, например https://hentasis1.top/985-….html')
  }

  const html = await fetchPage(pageUrl)

  const rawTitle =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<title>([^<]*)<\/title>/i.exec(html)?.[1]
  const rawPoster = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(
    html,
  )?.[1]

  const raw = extractFiles(html, pageUrl)
  if (raw.length === 0) {
    throw new Error(
      'Видео на странице не нашлось: это не страница тайтла (или сайт отдал заглушку). ' +
        'Ссылка должна выглядеть так: https://hentasis1.top/1094-….html',
    )
  }

  const files: HentasisFile[] = raw.map((file, index) => ({
    label: file.label !== undefined && file.label !== '' ? file.label : `Файл ${index + 1}`,
    url: file.url,
    kind: classify(file.url),
  }))

  return {
    title: rawTitle === undefined ? undefined : clean(rawTitle),
    poster: rawPoster === undefined ? undefined : absolutize(rawPoster, pageUrl) || undefined,
    files,
  }
}

/* ---------- Поиск тайтла по названиям ---------- */

export function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function tokensOf(normalized: string): string[] {
  return normalized.split(' ').filter((word) => word.length >= 2)
}

export function scoreTitleMatch(query: string, title: string): number {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (q === '' || t === '') return 0;
  if (q === t) return 100;
  if (t.includes(q)) return 95;
  if (q.includes(t) && t.length >= 4) return 85;

  const qw = tokensOf(q);
  const tw = tokensOf(t);
  if (qw.length === 0 || tw.length === 0) return 0;

  // Склейки соседних слов: ромадзи на двух сайтах различается пробелами
  // («Tsurete kita» на сайте и «Tsuretekita» у нас — одно и то же слово).
  const tTokens = new Set(tw);
  const tGlued = new Set<string>();
  for (let i = 0; i < tw.length - 1; i += 1) {
    const glued = `${tw[i]}${tw[i + 1]}`;
    if (glued.length > 2) tGlued.add(glued);
  }

  let covered = 0;
  for (let i = 0; i < qw.length; i += 1) {
    const word = qw[i];
    if (tTokens.has(word) || tGlued.has(word)) {
      covered += 1;
      continue;
    }

    // Слово запроса не нашлось само — вдруг оно склейка двух соседних слов титула.
    const next = qw[i + 1];
    if (next !== undefined && tTokens.has(word + next)) {
      covered += 2;
      i += 1;
    }
  }

  if (covered === 0) return 0;

  // Все слова запроса нашлись (пусть и через склейки) — почти наверняка тот же тайтл:
  // останавливаем поиск, как при фразовом совпадении.
  if (covered >= qw.length && qw.length >= 3) return 85;

  return Math.min(84, Math.round((covered / qw.length) * 100));
}

export function buildSearchQueries(titles: string[], limit = 24): string[] {
  const seen = new Set<string>();
  const full: string[] = [];
  const partial: string[] = [];

  const add = (pool: string[], raw: string): void => {
    const q = raw
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (q.length < 3) return;
    const key = normalizeTitle(q);
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    pool.push(q);
  };

  // 1) каждое название целиком — английское, ромадзи, японское и русское.
  for (const title of titles) add(full, title);

  // 2) совпадающие части: названия длиннее нескольких слов DLE в режиме «все слова»
  //    не находит — достаточно одного несовпавшего слова, и выдача пустая.
  for (const title of titles) {
    const words = normalizeTitle(title).split(' ').filter(Boolean);
    if (words.length > 3) add(partial, words.slice(0, 3).join(' '));
    if (words.length > 2) add(partial, words.slice(0, 2).join(' '));

    const longest = words.filter((w) => w.length >= 5).sort((a, b) => b.length - a.length)[0];
    if (longest !== undefined && words.length > 1) {
      add(partial, longest);

      // Префиксы самого длинного слова: слитное ромадзи на сайте бывает раздельным
      // («Otomedori» → «otome dori»), а поиск DLE идёт по словам — префикс «otome»
      // находит и слитное, и раздельное написание.
      if (longest.length > 5) add(partial, longest.slice(0, 5));
      if (longest.length > 4) add(partial, longest.slice(0, 4));
    }
  }

  return [...full, ...partial].slice(0, limit);
}

function titleFromUrl(url: string): string {
  const tail = /\/\d+-([a-z0-9-]+)\.html/i.exec(url)?.[1] ?? ''
  return tail.replace(/-+/g, ' ').trim()
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

function bestScore(titles: string[], candidates: string[]): number {
  let best = 0
  for (const title of titles) {
    for (const candidate of candidates) {
      if (candidate === '') continue
      const score = scoreTitleMatch(title, candidate)
      if (score > best) best = score
    }
  }
  return best
}

function extractHits(html: string, base: string, titles: string[]): HentasisHit[] {
  const anchorRe = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  const out: HentasisHit[] = []
  const seen = new Set<string>()

  let anchor: RegExpExecArray | null
  while ((anchor = anchorRe.exec(html)) !== null) {
    const url = absolutize(anchor[1] ?? '', base)
    if (url === '' || seen.has(url)) continue
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '')
    if (!TITLE_PAGE_RE.test(path)) continue

    const anchorTitle = clean(stripTags(anchor[2] ?? ''))
    const slugTitle = titleFromUrl(url)
    if (anchorTitle === '' && slugTitle === '') continue

    seen.add(url)
    out.push({
      url,
      title: anchorTitle !== '' ? anchorTitle : slugTitle,
      score: bestScore(titles, [anchorTitle, slugTitle]),
    })
    if (out.length >= 20) break
  }

  return out
}

/** Удачный формат поиска запоминаем на домен: повторные запросы не перебирают варианты. */
const searchPathCache = new Map<string, string>()

interface SearchVariant {
  kind: string
  url: string
  init?: PageRequestInit
}

/** Порядок: POST-форма DLE (штатный путь поиска), GET-вариант, AJAX-поиск из шапки
 * (обычно открыт даже когда полный поиск закрыт гостям), фолбэк «?s=». */
function searchVariants(base: string, query: string): SearchVariant[] {
  const b = base.replace(/\/+$/, '')
  const q = encodeURIComponent(query)
  const form = `do=search&subaction=search&story=${q}`
  const all: SearchVariant[] = [
    { kind: 'dle-post', url: `${b}/index.php`, init: { method: 'POST', body: form } },
    { kind: 'dle-get', url: `${b}/index.php?do=search&subaction=search&story=${q}` },
    { kind: 'ajax', url: `${b}/engine/ajax/search.php`, init: { method: 'POST', body: `q=${q}` } },
    { kind: 's', url: `${b}/?s=${q}` },
  ]
  const known = searchPathCache.get(b)
  return known === undefined ? all : all.filter((v) => v.kind === known)
}

export async function searchHentasis(
  base: string,
  query: string,
  titles: string[],
  fetchPage: PageFetcher,
): Promise<{ hits: HentasisHit[]; fetched: number }> {
  let fetched = 0

  for (const variant of searchVariants(base, query)) {
    if (fetched >= 3) break // на один запрос — не больше трёх страниц поиска
    fetched += 1
    try {
      const html = await fetchPage(variant.url, variant.init)
      const hits = extractHits(html, base, titles)
      if (hits.length > 0) {
        searchPathCache.set(base.replace(/\/+$/, ''), variant.kind)
        return { hits, fetched }
      }
    } catch {
      // вариант не ответил — пробуем следующий
    }
  }
  return { hits: [], fetched }
}

function sortPool(pool: Map<string, HentasisHit>): HentasisHit[] {
  return [...pool.values()].sort((a, b) => b.score - a.score)
}

export async function autoFindHentasis(
  bases: string[],
  queries: string[],
  titles: string[],
  fetchPage: PageFetcher,
  options: HentasisFindOptions = {},
): Promise<HentasisFindResult> {
  const opts = { ...DEFAULT_FIND, ...options }
  const pool = new Map<string, HentasisHit>()
  let requests = 0
  let pages = 0

  for (const query of queries) {
    for (const base of bases) {
      if (requests >= opts.maxRequests) break
      requests += 1

      try {
        const { hits, fetched } = await searchHentasis(base, query, titles, fetchPage);
        pages += fetched;

        for (const hit of hits) {
          let score = hit.score;

          // Год с AniList: совпал с годом на странице — кандидат надёжнее (+5).
          if (opts.year !== undefined) {
            const withYear = normalizeTitle(hit.title)
              .split(' ')
              .some((token) => token.startsWith(String(opts.year)));
            if (withYear) score = Math.min(99, score + 5);
          }

          const known = pool.get(hit.url);
          if (known === undefined || score > known.score) {
            pool.set(hit.url, { ...hit, score });
          }
        }
      } catch {
        // поиск не ответил — считаем запрос израсходованным и идём дальше
      }

      const best = sortPool(pool)[0]
      if (best !== undefined && best.score >= opts.strongScore) {
        return { best, candidates: sortPool(pool), pages }
      }
    }
    if (requests >= opts.maxRequests) break
  }

  const sorted = sortPool(pool)
  const best = sorted[0]
  return {
    best: best !== undefined && best.score >= opts.minScore ? best : null,
    candidates: sorted,
    pages,
  }
}
