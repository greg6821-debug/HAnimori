// packages/core/src/api/hentasis.ts
//
// Источник «Hentasis» (18+): DLE-сайт без API.
// Два дела: поиск страницы тайтла через встроенный поиск сайта (по названиям с AniList:
// английское, японское, русское, затем по совпадающим частям) и разбор страницы —
// список файлов плеера. «Файл 1/2/3/4» на сайте перемешаны — порядок возвращаем
// ровно как на странице, без сортировки.

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

/** Найденная страница и насколько она похожа на запрос: 100 — совпала, 0 — мимо. */
export interface HentasisHit {
  url: string
  title: string
  score: number
}

export interface HentasisFindResult {
  best: HentasisHit | null
  candidates: HentasisHit[]
}

export type PageFetcher = (url: string) => Promise<string>

export interface HentasisFindOptions {
  /** Ниже этого счёта кандидат не считается найденным. */
  minScore?: number
  /** С таким счётом поиск прекращаем сразу — совпадение очевидно. */
  strongScore?: number
  /** Сколько страниц поиска максимум открываем за прогон. */
  maxRequests?: number
}

const DEFAULT_FIND: Required<HentasisFindOptions> = {
  // Порог принятия: 65% — любая фразовая близость или совпадение большинства слов.
  minScore: 65,
  // С такого счёта поиск прекращаем сразу: запрос найден во названии страницы фразой.
  strongScore: 85,
  maxRequests: 18,
}

/** Мусорные iframe: реклама и счётчики, не плееры. */
const IFRAME_JUNK =
  /(recaptcha|doubleclick|googletag|adservice|mc\.yandex|metrika|vk\.com\/js|oauth|telegram|banner|counter|googlesyndication)/i

interface RawFile {
  url: string
  label?: string
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

/** Плейлист PlayerJS одной строкой: "u1,u2,u3"; префиксы качества вида [720p] отрезаем. */
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

    // Массив объектов: у каждого свой title/file.
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
      'Видео на странице не нашлось: проверь ссылку или попробуй ещё раз — сайт иногда отдаёт заглушку.',
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

/** Нормализация для сравнения: нижний регистр, снятие диакритики — NFD убирает и макроны
 * (daibōken → daibouken), и кириллические надстрочные (ё, й). Знаки → пробелы: комбинированное
 * название страницы «Русское / English (2012г.)» становится одной строкой слов. */
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

/** Схожесть запроса и названия в процентах:
 *  100 — точное совпадение после нормализации;
 *  95  — название страницы содержит запрос целиком («Тропический Поцелуй / Tropical Kiss (2012г.)»
 *        содержит «Tropical Kiss»);
 *  85  — запрос содержит название страницы целиком;
 *  ниже — доля слов запроса, найденных в названии, с потолком 84: совпадение по словам
 *  никогда не останавливает поиск раньше фразового. */
export function scoreTitleMatch(query: string, title: string): number {
  const q = normalizeTitle(query)
  const t = normalizeTitle(title)
  if (q === '' || t === '') return 0
  if (q === t) return 100
  if (t.includes(q)) return 95
  if (q.includes(t) && t.length >= 4) return 85

  const qw = tokensOf(q)
  if (qw.length === 0) return 0
  const tw = new Set(tokensOf(t))
  let hits = 0
  for (const word of qw) {
    if (tw.has(word)) hits += 1
  }
  if (hits === 0) return 0
  return Math.min(84, Math.round((hits / qw.length) * 100))
}

/** Запросы в два прохода: сначала каждое название ЦЕЛИКОМ — английское, ромадзи, японское
 * и русское (оно обычно среди синонимов AniList), потом совпадающие части — первые слова
 * и самое длинное слово, когда целиком сайт не находит. */
export function buildSearchQueries(titles: string[], limit = 20): string[] {
  const seen = new Set<string>()
  const full: string[] = []
  const partial: string[] = []

  const add = (pool: string[], raw: string): void => {
    // Знаки в поисковой строке сайту не нужны: «Tropical Kiss!» ищем как «Tropical Kiss».
    const q = raw
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (q.length < 3) return
    const key = normalizeTitle(q)
    if (key === '' || seen.has(key)) return
    seen.add(key)
    pool.push(q)
  }

  for (const title of titles) add(full, title)

  for (const title of titles) {
    const words = normalizeTitle(title).split(' ').filter(Boolean)
    if (words.length > 3) add(partial, words.slice(0, 3).join(' '))
    if (words.length > 2) add(partial, words.slice(0, 2).join(' '))
    const longest = words.filter((w) => w.length >= 5).sort((a, b) => b.length - a.length)[0]
    if (longest !== undefined && words.length > 1) add(partial, longest)
  }

  return [...full, ...partial].slice(0, limit)
}

/** Название из адреса страницы: /159-tropical-kiss.html → «tropical kiss».
 * У DLE в slug живёт латиница тайтла — часто это надёжнее текста ссылки, который сайт обрезает. */
function titleFromUrl(url: string): string {
  const tail = /\/\d+-([a-z0-9-]+)\.html/i.exec(url)?.[1] ?? ''
  return tail.replace(/-+/g, ' ').trim()
}

/** Страницы тайтлов на DLE имеют адрес вида /159-….html — по нему узнаём результаты поиска. */
const PAGE_URL_RE = /\/\d+-[a-z0-9-]+\.html(?:[?#].*)?$/i

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

/** Лучший балл представлений страницы (текст ссылки, slug) против ВСЕХ названий тайтла:
 * страница совпадает, если хоть одно её представление совпало хоть с одним названием. */
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
    if (!PAGE_URL_RE.test(path)) continue

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

/** Удачный формат поиска запоминаем на домен: DLE отзывается не на все варианты,
 * а перебирать три адреса на каждый запрос — лишний трафик. */
const searchPathCache = new Map<string, string>()

function searchVariants(base: string, query: string): { kind: string; url: string }[] {
  const b = base.replace(/\/+$/, '')
  const q = encodeURIComponent(query)
  const all = [
    { kind: 'dle', url: `${b}/index.php?do=search&subaction=search&story=${q}` },
    { kind: 'dle-short', url: `${b}/index.php?do=search&story=${q}` },
    { kind: 's', url: `${b}/?s=${q}` },
  ]
  const known = searchPathCache.get(b)
  return known === undefined ? all : all.filter((v) => v.kind === known)
}

/** Поиск по встроенному поиску сайта: query уходит в форму, названия — на сверку результатов. */
export async function searchHentasis(
  base: string,
  query: string,
  titles: string[],
  fetchPage: PageFetcher,
): Promise<HentasisHit[]> {
  for (const variant of searchVariants(base, query)) {
    try {
      const hits = extractHits(await fetchPage(variant.url), base, titles)
      if (hits.length > 0) {
        searchPathCache.set(base.replace(/\/+$/, ''), variant.kind)
        return hits
      }
    } catch {
      // адрес не ответил — пробуем следующий вариант
    }
  }
  return []
}

function sortPool(pool: Map<string, HentasisHit>): HentasisHit[] {
  return [...pool.values()].sort((a, b) => b.score - a.score)
}

/** Автопоиск: идём по запросам (полные названия, потом совпадающие части) и доменам,
 * собираем кандидатов; заканчиваем на первом фразовом совпадении (≥ strongScore).
 * Совпадения по словам (65–84) в пул попадают, но поиск не останавливают —
 * вдруг дальнейшие запросы дадут точнее. */
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

  for (const query of queries) {
    for (const base of bases) {
      if (requests >= opts.maxRequests) break
      requests += 1

      const hits: HentasisHit[] = await searchHentasis(base, query, titles, fetchPage).catch(
        () => [],
      )

      for (const hit of hits) {
        const known = pool.get(hit.url)
        if (known === undefined || hit.score > known.score) pool.set(hit.url, hit)
      }

      const best = sortPool(pool)[0]
      if (best !== undefined && best.score >= opts.strongScore) {
        return { best, candidates: sortPool(pool) }
      }
    }
    if (requests >= opts.maxRequests) break
  }

  const sorted = sortPool(pool)
  const best = sorted[0]
  return {
    best: best !== undefined && best.score >= opts.minScore ? best : null,
    candidates: sorted,
  }
}
