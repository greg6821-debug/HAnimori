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
  /** Пометка из «Примечания»: «озвучка · AniStar», «субтитры · Crunchyroll», «хента-трек». */
  note?: string
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
  minScore?: number
  strongScore?: number
  /** Бюджет страниц поиска за весь прогон: настоящий потолок сетевой нагрузки. */
  maxPages?: number
  /** Пауза между обращениями к сайту, мс (+до 300 мс разброса). 0 — без пауз (тесты). */
  delayMs?: number
  /** Год выпуска с AniList: кандидаты с совпавшим годом получают буст при ранжировании. */
  year?: number
}

const DEFAULT_FIND: Omit<Required<HentasisFindOptions>, 'year'> = {
  minScore: 65,
  strongScore: 85,
  maxPages: 16,
  delayMs: 700,
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
  /** Пометка из самого конфига плеера (RalodePlayer: имя группы-озвучки). */
  note?: string
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

interface RawConfig {
  files: RawFile[]
}

/** Файлы одного конфига плеера. Нумерация «Файл N» — внутри конфига: у сайта
 * она своя у каждого плеера, и примечание привязано именно к ней. */
function collectFromConfig(body: string, base: string, files: RawFile[], seen: Set<string>): void {
  const fileRe = /file\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\[[\s\S]*?\]))/gi

  let perConfig = 0

  let match: RegExpExecArray | null
  while ((match = fileRe.exec(body)) !== null) {
    if (match[1] !== undefined || match[2] !== undefined) {
      for (const url of splitPlayerList(match[1] ?? match[2] ?? '')) {
        perConfig += 1
        pushUrl(url, `Файл ${perConfig}`, base, files, seen)
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
      perConfig += 1
      const title = quotedValue(chunk, 'title')
      pushUrl(
        url,
        title !== undefined && title !== '' ? title : `Файл ${perConfig}`,
        base,
        files,
        seen,
      )
    }
  }
}

/* ---------- RalodePlayer (зеркала hentasis) ---------- */

interface RalodeEpisode {
  aname?: string
  scode?: string
  lssort?: string | number
}

interface RalodeGroup {
  items?: Record<string, RalodeEpisode> | RalodeEpisode[]
  name?: string
  sort?: string | number
}

/** Первая ссылка iframe из кода эпизода («<iframe src="/video.php?id=…">»). */
function iframeSrcOf(code: string, pageUrl: string): string {
  const m = /<iframe[^>]+?src\s*=\s*["']([^"']+)["']/i.exec(code)
  return m === null ? '' : absolutize(m[1] ?? '', pageUrl)
}

/** Первый JSON-объект после позиции: срез с балансом скобок, кавычки и эскейпы учитываются —
 * регуляркой с ленивой звёздочкой такой конфиг не взять, там вложенные объекты. */
function balancedJsonObject(html: string, from: number): string | null {
  const start = html.indexOf('{', from)
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < html.length && i < start + 300000; i += 1) {
    const ch = html[i] ?? ''
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return html.slice(start, i + 1)
    }
  }
  return null
}

/** Конфиг RalodePlayer: группы-озвучки с их эпизодами. Каждый эпизод — iframe-файл,
 * пометка файла — имя группы с сайта («Субтитры», «FumoDUB», «AniSTAR»). */
function extractRalodeConfigs(html: string, pageUrl: string): RawConfig[] {
  const call = html.indexOf('RalodePlayer.init(')
  if (call < 0) return []

  const json = balancedJsonObject(html, call)
  if (json === null) return []

  let data: Record<string, RalodeGroup>
  try {
    data = JSON.parse(json) as Record<string, RalodeGroup>
  } catch {
    return []
  }

  const groups = Object.values(data).filter(
    (group): group is RalodeGroup =>
      group !== null &&
      typeof group === 'object' &&
      group.items !== null &&
      typeof group.items === 'object',
  )
  if (groups.length === 0) return []

  // Порядок групп — как на сайте (поле sort), внутри группы — lssort эпизода.
  groups.sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))

  const files: RawFile[] = []
  const seen = new Set<string>()

  for (const group of groups) {
    const episodes = Object.values(group.items ?? {})
      .filter((ep): ep is RalodeEpisode => ep !== null && typeof ep === 'object')
      .sort((a, b) => Number(a.lssort ?? 0) - Number(b.lssort ?? 0))

    const name = (group.name ?? '').trim()

    episodes.forEach((ep, index) => {
      const url = iframeSrcOf(ep.scode ?? '', pageUrl)
      if (url === '' || seen.has(url)) return
      seen.add(url)

      const label = (ep.aname ?? '').trim() || `Файл ${index + 1}`
      files.push(name === '' ? { url, label } : { url, label, note: name })
    })
  }

  return files.length > 0 ? [{ files }] : []
}

/** Конфиги плееров страницы: у тайтла их бывает несколько (дубли шаблона,
 * зеркала), показывать надо один — выбор в getHentasisInfo. */
function extractConfigs(html: string, pageUrl: string): RawConfig[] {
  // Зеркала используют RalodePlayer — у него свой формат, проверяем его первым.
  const ralode = extractRalodeConfigs(html, pageUrl)
  if (ralode.length > 0) return ralode
  const configs: RawConfig[] = []
  const seen = new Set<string>()

  const playerRe = /Playerjs\s*\(([\s\S]{0,8000}?)\)\s*[;,)]?/gi
  let player: RegExpExecArray | null
  while ((player = playerRe.exec(html)) !== null) {
    const files: RawFile[] = []
    collectFromConfig(player[1] ?? '', pageUrl, files, seen)
    if (files.length > 0) configs.push({ files })
  }

  if (configs.length > 0) return configs

  // Фолбэк 1: скрипты с file: без слова Playerjs
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi
  let script: RegExpExecArray | null
  while ((script = scriptRe.exec(html)) !== null) {
    const files: RawFile[] = []
    collectFromConfig(script[1] ?? '', pageUrl, files, seen)
    if (files.length > 0) configs.push({ files })
  }
  if (configs.length > 0) return configs

  // Фолбэк 2: теги video/source, затем полные адреса файлов, затем iframe
  const files: RawFile[] = []

  for (const url of extractVideoTagSources(html, pageUrl)) {
    pushUrl(url, undefined, pageUrl, files, seen)
  }

  for (const url of extractMediaUrls(html)) {
    pushUrl(url, undefined, pageUrl, files, seen)
  }

  if (files.length === 0) {
    const frameRe = /<iframe[^>]+?src\s*=\s*["']([^"']+)["']/gi
    let frame: RegExpExecArray | null
    while ((frame = frameRe.exec(html)) !== null) {
      const url = absolutize(frame[1] ?? '', pageUrl)
      if (url !== '' && !IFRAME_JUNK.test(url)) pushUrl(url, undefined, pageUrl, files, seen)
    }
  }

  if (files.length > 0) configs.push({ files })
  return configs
}

/* ---------- Примечание: расшифровка «Файлы 1,2 — озвучка от AniStar, файл 3,4 — субтитры…» ---------- */

const NOTE_STOP_RE =
  /(Скачать|Плеер|Смотреть онлайн|Трейлер|Коммент|Реклама|Похожее|Внимание|Телеграм)/i

/** Строка похожа на продолжение примечания: «Файл N…», «озвучка…», «субтитры…». */
const NOTE_LINE_RE = /[Фф]айл|субтитр|озвучк|хента-?трек|перевод/i

function extractNoteText(html: string): string {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|td|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')

  const at = plain.indexOf('Примечание')
  if (at < 0) return ''

  // Строка с «Примечание» и следующие строки, похожие на расшифровку файлов.
  // Конец примечания: пустая строка, строка без «файл/озвучка/субтитры» (пошло
  // описание) или «!» — примечания этого сайта заканчиваются им.
  const kept: string[] = []
  for (const rawLine of plain.slice(at, at + 4000).split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim()

    if (line === '') {
      if (kept.length > 0) break
      continue
    }
    if (kept.length === 0) {
      kept.push(line)
      if (line.includes('!')) break
      continue
    }
    if (!NOTE_LINE_RE.test(line)) break

    kept.push(line)
    if (line.includes('!')) break
  }

  let text = kept.join(' ')
  const stop = text.search(NOTE_STOP_RE)
  if (stop > 0) text = text.slice(0, stop)
  return text.slice(0, 1200)
}

/** «1,2» → [1,2]; «1-4» → [1,2,3,4]; «9,10» → [9,10]. Диапазон длиннее 50 — мусор, обрываем. */
function expandFileNumbers(raw: string): number[] {
  const out: number[] = []
  for (const part of raw.split(',')) {
    const bounds = part.split(/\s*[-–—]\s*/).map((n) => Number.parseInt(n, 10))
    const first = bounds[0]
    if (first === undefined || !Number.isFinite(first)) continue
    const second = bounds.length > 1 ? bounds[1] : first
    const from = Math.max(1, first)
    const to = Math.min(
      from + 49,
      Math.max(from, second !== undefined && Number.isFinite(second) ? second : from),
    )
    for (let n = from; n <= to; n += 1) out.push(n)
  }
  return out
}

/** Из текста куска — вид дорожки и команда: «озвучка от AniStar» → озвучка/AniStar. */
function classifyNote(body: string): { kind: string; team: string } {
  let text = body.replace(/\([^)]*\)/g, ' ')

  // Пункт пометки кончается «!»; всё после — прилипший хвост.
  const bang = text.indexOf('!')
  if (bang >= 0) text = text.slice(0, bang)
  text = text.replace(/\s+/g, ' ').trim()

  let kind = ''
  if (/хента-?трек/i.test(text)) kind = 'хента-трек'
  else if (/озвучк/i.test(text)) kind = 'озвучка'
  else if (/субтитр/i.test(text)) kind = 'субтитры'
  else if (/без\s+перевода/i.test(text)) kind = 'без перевода'

  // Команда: после «от», а если «от» нет — снимаем слово-вид и предлоги,
  // остальное и есть команда («субтитры EroSonsor!» → «EroSonsor»).
  const tail = /от\s+([^.,;]+)/i.exec(text)
  let team =
    tail !== null
      ? (tail[1] ?? '').trim()
      : text
          .replace(
            /(^|\s)(хента-?трек[а-яё]*|озвучк[а-яё]*|субтитр[а-яё]*|на|для|с)(?=\s|$)/gi,
            '$1',
          )
          .replace(/[.,;:]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
  // Перечисление команд одной дорожки: «AniStar и AniLibria» → «AniStar, AniLibria».
  team = team.replace(/\s+и\s+/gi, ', ')
  if (team.length > 40) team = '' // длинный хвост — не название команды

  return { kind, team }
}

/** Текст примечания → карта «номер файла → пометка». Не разобралось — карта пустая. */
export function parseHentasisNote(text: string): Map<number, string> {
  const map = new Map<number, string>()
  if (text === '') return map

  const headerRe = /[Фф]айл(?:ы|а)?\s+(\d+(?:\s*[-–—,]\s*\d+)*)\s*[-–—:]\s*/g
  const marks: { files: number[]; headerStart: number; bodyStart: number }[] = []

  let m: RegExpExecArray | null
  while ((m = headerRe.exec(text)) !== null) {
    marks.push({
      files: expandFileNumbers(m[1] ?? ''),
      headerStart: m.index,
      bodyStart: m.index + m[0].length,
    })
  }

  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i]
    if (mark === undefined) continue
    const nextMark = marks[i + 1]
    const bodyEnd = nextMark !== undefined ? nextMark.headerStart : text.length
    const { kind, team } = classifyNote(text.slice(mark.bodyStart, bodyEnd))
    const label = [kind, team].filter((p) => p !== '').join(' · ')
    if (label === '') continue
    for (const n of mark.files) {
      if (!map.has(n)) map.set(n, label)
    }
  }

  return map
}

export async function getHentasisInfo(
  pageUrl: string,
  fetchPage: PageFetcher,
): Promise<HentasisInfo> {
  if (!/^https?:\/\//i.test(pageUrl)) {
    throw new Error('Нужна ссылка на страницу тайтла, например https://hentasis1.top/985-….html')
  }

  const fetched = await fetchPage(pageUrl)

  // Шаблон DLE держит старые плееры в HTML-комментариях: без срезки они давали
  // «вторую четвёрку файлов». Чистим один раз и дальше работаем с чистым HTML —
  // это касается и конфигов плеера, и примечания.
  const html = fetched
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')

  const rawTitle =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<title>([^<]*)<\/title>/i.exec(html)?.[1]
  const rawPoster = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(
    html,
  )?.[1]

  const configs = extractConfigs(html, pageUrl)
  const first = configs[0]
  if (first === undefined) {
    throw new Error(
      'Видео на странице не нашлось: это не страница тайтла (или сайт отдал заглушку). ' +
        'Ссылка должна выглядеть так: https://hentasis1.top/1094-….html',
    )
  }

  const noteMap = parseHentasisNote(extractNoteText(html))

  // Из нескольких живых конфигов берём настоящий плеер: чьё число файлов совпадает
  // с наибольшим номером примечания; без примечания — самый большой из конфигов.
  let chosen = first
  if (configs.length > 1) {
    let noteMax = 0
    for (const n of noteMap.keys()) if (n > noteMax) noteMax = n

    const byNote = noteMax > 0 ? configs.find((c) => c.files.length === noteMax) : undefined
    if (byNote !== undefined) chosen = byNote
    else for (const c of configs) if (c.files.length > chosen.files.length) chosen = c
  }

  const files: HentasisFile[] = chosen.files.map((file, index) => {
    const labeled = /^Файл\s*(\d+)$/i.exec(file.label ?? '')
    const number = labeled !== null && labeled[1] !== undefined ? Number(labeled[1]) : index + 1

    const built: HentasisFile = {
      label: file.label !== undefined && file.label !== '' ? file.label : `Файл ${index + 1}`,
      url: file.url,
      kind: classify(file.url),
    }
    const note = file.note ?? noteMap.get(number)
    if (note !== undefined && note !== '') built.note = note
    return built
  })

  return {
    title: rawTitle === undefined ? undefined : clean(rawTitle),
    poster: rawPoster === undefined ? undefined : absolutize(rawPoster, pageUrl) || undefined,
    files,
  }
}

/** Источники из тегов video/source и data-атрибутов: в сыром HTML плеера
 * манифест живёт обычно здесь. */
function extractVideoTagSources(html: string, pageUrl: string): string[] {
  const out: string[] = []
  const sourceRe = /<(?:source|video)[^>]+?(?:src|data-src)\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = sourceRe.exec(html)) !== null) {
    const url = absolutize(m[1] ?? '', pageUrl)
    if (url !== '') out.push(url)
  }
  return out
}

/** Полные адреса со страницы, отфильтрованные по расширению В КОНЦЕ пути.
 * Прежний ленивый регэксп обрезал URL на первом «.mp4» внутри пути:
 * «…/01_raw_720.mp4/index-v1-a1.m3u8?token=…» превращался в «…/01_raw_720.mp4» — 404. */
function extractMediaUrls(html: string): string[] {
  const out: string[] = []
  const re = /(?:https?:)?\/\/[^\s"'`<>\\]+/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const url = clean(m[0] ?? '')
    if (!/^https?:\/\//i.test(url)) continue
    const path = (url.split(/[?#]/)[0] ?? '').toLowerCase()
    if (/\.(mp4|m3u8|m4v|webm)$/.test(path)) out.push(url)
  }
  return out
}

/** Кандидаты манифеста из соседних ассетов: спрайт превью и субтитры лежат рядом
 * с файлом и отличаются только суффиксом (01_raw_sprite.jpg → 01_raw.m3u8). */
function manifestCandidates(html: string): string[] {
  const out: string[] = []
  const assetRe = /https?:\/\/[^\s"'`<>\\]+?_(?:sprite|rus|eng)\.(?:jpg|ass)\b/gi
  let m: RegExpExecArray | null
  while ((m = assetRe.exec(html)) !== null) {
    const base = (m[0] ?? '').replace(/_(?:sprite|rus|eng)\.(?:jpg|ass)$/i, '')
    if (base !== '') out.push(`${base}.m3u8`)
  }
  return out
}

async function looksLikeManifest(url: string, fetchPage: PageFetcher): Promise<boolean> {
  try {
    return (await fetchPage(url)).slice(0, 200).includes('#EXTM3U')
  } catch {
    return false
  }
}

export interface HentasisDirect {
  url: string
  kind: HentasisFileKind
  /** Цепочка страниц, по которой дошли до файла: для диагностики обрывов. */
  hops: string[]
}

/** Разыменование iframe-файла: цепочка страниц-плееров до прямой ссылки.
 * Все проверки «открыт напрямую» и реклама — исполняемый JS, фетчу безразличны. */
export async function resolveHentasisDirect(
  iframeUrl: string,
  fetchPage: PageFetcher,
  maxHops = 3,
): Promise<HentasisDirect> {
  const visited: string[] = []
  let url = iframeUrl

  for (let hop = 0; hop < maxHops; hop += 1) {
    if (visited.includes(url)) {
      throw new Error(`Цикл в цепочке плееров: ${visited.join(' → ')}`)
    }
    visited.push(url)

    let html: string
    try {
      html = await fetchPage(url)
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      throw new Error(`Страница плеера не отдалась (${url}): ${why}`, { cause: e })
    }

    // 1) Теги video/source — самый надёжный след манифеста на странице плеера.
    for (const candidate of extractVideoTagSources(html, url)) {
      const kind = classify(candidate)
      if (kind === 'mp4' || kind === 'hls') {
        return { url: candidate, kind, hops: [...visited] }
      }
    }

    // 2) Конфиги плеера: прямой файл возвращаем, iframe — следующий шаг цепочки.
    let frame: string | undefined
    for (const config of extractConfigs(html, url)) {
      for (const file of config.files) {
        const kind = classify(file.url)
        if (kind === 'mp4' || kind === 'hls') {
          return { url: file.url, kind, hops: [...visited] }
        }
        if (kind === 'iframe' && file.url !== iframeUrl && frame === undefined) {
          frame = file.url
        }
      }
    }

    // 3) Полные адреса файлов: расширение сверяется в конце пути, обрезок не бывает.
    for (const candidate of extractMediaUrls(html)) {
      const kind = classify(candidate)
      if (kind === 'mp4' || kind === 'hls') {
        return { url: candidate, kind, hops: [...visited] }
      }
    }

    for (const candidate of manifestCandidates(html)) {
      if (await looksLikeManifest(candidate, fetchPage)) {
        return { url: candidate, kind: 'hls', hops: [...visited] }
      }
    }

    if (frame === undefined) {
      throw new Error(`Прямой ссылки нет ни на одной странице цепочки: ${visited.join(' → ')}`)
    }
    url = frame
  }

  throw new Error(`Цепочка длиннее ${maxHops} страниц: ${visited.join(' → ')}`)
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
  const q = normalizeTitle(query)
  const t = normalizeTitle(title)
  if (q === '' || t === '') return 0
  if (q === t) return 100
  if (t.includes(q)) return 95
  if (q.includes(t) && t.length >= 4) return 85

  const qw = tokensOf(q)
  const tw = tokensOf(t)
  if (qw.length === 0 || tw.length === 0) return 0

  // Склейки соседних слов: ромадзи на двух сайтах различается пробелами
  // («Tsurete kita» на сайте и «Tsuretekita» у нас — одно и то же слово).
  const tTokens = new Set(tw)
  const tGlued = new Set<string>()
  for (let i = 0; i < tw.length - 1; i += 1) {
    const glued = `${tw[i]}${tw[i + 1]}`
    if (glued.length > 2) tGlued.add(glued)
  }

  let covered = 0
  for (let i = 0; i < qw.length; i += 1) {
    const word = qw[i]
    if (word === undefined) continue

    if (tTokens.has(word) || tGlued.has(word)) {
      covered += 1
      continue
    }

    const next = qw[i + 1]
    if (next !== undefined && tTokens.has(word + next)) {
      covered += 2
      i += 1
    }
  }

  if (covered === 0) return 0

  // Все слова запроса нашлись (пусть и через склейки) — почти наверняка тот же тайтл:
  // останавливаем поиск, как при фразовом совпадении.
  if (covered >= qw.length && qw.length >= 3) return 85

  return Math.min(84, Math.round((covered / qw.length) * 100))
}

export function buildSearchQueries(titles: string[], limit = 24): string[] {
  const seen = new Set<string>()
  const full: string[] = []
  const partial: string[] = []

  const add = (pool: string[], raw: string): void => {
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

  // 1) каждое название целиком — английское, ромадзи, японское и русское.
  for (const title of titles) add(full, title)

  // 2) совпадающие части: названия длиннее нескольких слов DLE в режиме «все слова»
  //    не находит — достаточно одного несовпавшего слова, и выдача пустая.
  for (const title of titles) {
    const words = normalizeTitle(title).split(' ').filter(Boolean)
    if (words.length > 3) add(partial, words.slice(0, 3).join(' '))
    if (words.length > 2) add(partial, words.slice(0, 2).join(' '))

    // Префиксы самого длинного слова — и для ОДНОСЛОВНЫХ названий тоже:
    // «Otomedori» DLE по словам не найдёт «otome dori», а префикс «otome» найдёт.
    const longest = words.filter((w) => w.length >= 5).sort((a, b) => b.length - a.length)[0]
    if (longest !== undefined) {
      if (longest.length > 5) add(partial, longest.slice(0, 5))
      if (longest.length > 4) add(partial, longest.slice(0, 4))
    }
  }

  return [...full, ...partial].slice(0, limit)
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

/** Страница именно с результатами поиска: у DLE их приметы одни и те же. Нужна обязательно:
 * без проверки на «непоисковой» странице (главная, каталог) якорей на тайтлы полно,
 * и они выдавали мусор вместо результатов. */
function isSearchResults(html: string): boolean {
  return /sres-wrap/i.test(html) || /По Вашему запросу найдено/i.test(html)
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

    // Заголовок результата — в h2: остальной текст анкора (даты, описание) в имя не годится.
    const inner = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(anchor[2] ?? '')
    const anchorTitle = clean(stripTags(inner === null ? (anchor[2] ?? '') : (inner[1] ?? '')))
    const slugTitle = titleFromUrl(url)
    if (anchorTitle === '' && slugTitle === '') continue

    seen.add(url)
    out.push({
      url,
      title: anchorTitle !== '' ? anchorTitle : slugTitle,
      score: bestScore(titles, [anchorTitle, slugTitle]),
    })
    if (out.length >= 60) break
  }

  out.sort((a, b) => b.score - a.score)
  return out.slice(0, 20)
}

/** Выдача AJAX-подсказки поиска из шапки: JSON со ссылками и названиями. */
function extractJsonHits(raw: string, base: string, titles: string[]): HentasisHit[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }

  const out: HentasisHit[] = []
  const seen = new Set<string>()

  const visit = (node: unknown): void => {
    if (out.length >= 20) return

    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node === null || typeof node !== 'object') return

    const record = node as Record<string, unknown>
    const rawUrl = record.link ?? record.url
    const title = record.title
    if (typeof rawUrl === 'string' && typeof title === 'string' && title.trim() !== '') {
      const url = absolutize(rawUrl, base)
      const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '')
      if (url !== '' && TITLE_PAGE_RE.test(path) && !seen.has(url)) {
        seen.add(url)
        const name = clean(title)
        out.push({ url, title: name, score: bestScore(titles, [name, titleFromUrl(url)]) })
      }
    }

    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object') visit(value)
    }
  }

  visit(data)
  out.sort((a, b) => b.score - a.score)
  return out
}

/** Удачный формат поиска запоминаем на домен: повторные запросы не перебирают варианты. */
const searchPathCache = new Map<string, string>()

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

interface SearchVariant {
  kind: string
  url: string
  init?: PageRequestInit
}

/** Формы поиска с сайта: GET полного поиска (с search_start/full_search, как в его форме),
 * POST быстрого поиска (do/search/subaction/story на index.php и на корень — quicksearch
 * шлёт на текущий адрес), AJAX-подсказка из шапки. Порядок — до первого удачного. */
function searchVariants(base: string, query: string): SearchVariant[] {
  const b = base.replace(/\/+$/, '')
  const q = encodeURIComponent(query)
  const all: SearchVariant[] = [
    {
      kind: 'dle-get',
      url: `${b}/index.php?do=search&subaction=search&search_start=0&full_search=0&story=${q}`,
    },
    {
      kind: 'dle-post',
      url: `${b}/index.php`,
      init: { method: 'POST', body: `do=search&subaction=search&story=${q}` },
    },
    {
      kind: 'root-post',
      url: `${b}/`,
      init: { method: 'POST', body: `do=search&subaction=search&story=${q}` },
    },
    {
      kind: 'ajax',
      url: `${b}/engine/ajax/search.php`,
      init: { method: 'POST', body: `q=${q}` },
    },
  ]
  const known = searchPathCache.get(b)
  return known === undefined ? all : all.filter((v) => v.kind === known)
}

/** Страница выдачи с чужим search_start: GET — параметром, POST — в теле формы,
 * как это делает полный поиск сайта. */
function searchPageVariant(
  variant: SearchVariant,
  base: string,
  query: string,
  start: number,
): SearchVariant {
  const q = encodeURIComponent(query)
  const paging = `search_start=${start}&full_search=0`

  if (variant.kind === 'dle-get') {
    return {
      kind: variant.kind,
      url: `${base}/index.php?do=search&subaction=search&${paging}&story=${q}`,
    }
  }

  return {
    kind: variant.kind,
    url: variant.url,
    init: { method: 'POST', body: `do=search&subaction=search&${paging}&story=${q}` },
  }
}

export interface SearchPagesOptions {
  /** Пауза между обращениями, мс (+до 300 разброса). */
  delayMs?: number
  /** Сколько страниц выдачи можно взять на этот вызов, включая первую. */
  pagesBudget?: number
  /** С таким баллом пагинацию не трогаем: совпадение уже явное. */
  strongScore?: number
}

/** Поиск: первый отозвавшийся формат выдачи, затем его пагинация — пока не встретится
 * сильное совпадение, не кончится бюджет страниц или сама пагинация. */
export async function searchHentasis(
  base: string,
  query: string,
  titles: string[],
  fetchPage: PageFetcher,
  options: SearchPagesOptions = {},
): Promise<{ hits: HentasisHit[]; fetched: number }> {
  const b = base.replace(/\/+$/, '')
  const opts = { delayMs: 0, pagesBudget: 1, strongScore: 85, ...options }

  const pause = async (): Promise<void> => {
    if (opts.delayMs > 0) await wait(opts.delayMs + Math.round(Math.random() * 300))
  }

  let cumulative: HentasisHit[] = []
  let fetched = 0

  for (const variant of searchVariants(base, query)) {
    if (fetched >= opts.pagesBudget) break
    if (fetched > 0) await pause()
    fetched += 1

    const body = await fetchPage(variant.url, variant.init).catch(() => '')
    if (body === '') continue

    let firstHits: HentasisHit[] = []
    if (variant.kind === 'ajax') firstHits = extractJsonHits(body, b, titles)
    else if (isSearchResults(body)) firstHits = extractHits(body, b, titles)

    if (firstHits.length === 0) continue

    searchPathCache.set(b, variant.kind)
    cumulative = mergeHits(cumulative, firstHits)
    if ((cumulative[0]?.score ?? 0) >= opts.strongScore) {
      return { hits: cumulative, fetched }
    }

    // У подсказки из шапки страниц нет; у полного поиска — есть.
    if (variant.kind === 'ajax') return { hits: cumulative, fetched }

    let currentStart = 0
    const visited = new Set<number>([0])
    const queue = extractSearchStarts(body)

    while (queue.length > 0 && fetched < opts.pagesBudget) {
      const start = queue.shift()
      if (start === undefined || visited.has(start) || start <= currentStart) continue
      visited.add(start)
      currentStart = start

      await pause()
      fetched += 1

      const page = searchPageVariant(variant, b, query, start)
      const pageHtml = await fetchPage(page.url, page.init).catch(() => '')
      if (pageHtml === '' || !isSearchResults(pageHtml)) break

      const pageHits = extractHits(pageHtml, b, titles)
      if (pageHits.length === 0) break

      cumulative = mergeHits(cumulative, pageHits)
      if ((cumulative[0]?.score ?? 0) >= opts.strongScore) {
        return { hits: cumulative, fetched }
      }

      for (const next of extractSearchStarts(pageHtml)) {
        if (!visited.has(next)) queue.push(next)
      }
    }

    return { hits: cumulative, fetched }
  }

  return { hits: cumulative, fetched }
}

function sortPool(pool: Map<string, HentasisHit>): HentasisHit[] {
  return [...pool.values()].sort((a, b) => b.score - a.score || a.title.length - b.title.length)
}

/** Значения search_start из пагинации выдачи: ровно те, что подставляет собственный
 * скрипт сайта (list_submit(2) → search_start=2 для страницы 2). Отрицательные — служебные. */
function extractSearchStarts(html: string): number[] {
  const out = new Set<number>()
  const re = /list_submit\((-?\d+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const n = Number.parseInt(m[1] ?? '', 10)
    if (Number.isFinite(n) && n > 0) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/** Слияние находок со страниц: по одному представлению на адрес, балл берётся больший. */
function mergeHits(into: HentasisHit[], add: HentasisHit[]): HentasisHit[] {
  const map = new Map<string, HentasisHit>()
  for (const hit of [...into, ...add]) {
    const known = map.get(hit.url)
    if (known === undefined || hit.score > known.score) map.set(hit.url, hit)
  }
  return sortPool(map)
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
  let pages = 0

  for (const query of queries) {
    for (const base of bases) {
      if (pages >= opts.maxPages) break

      // Пауза перед каждым обращением, кроме самого первого за прогон.
      if (pages > 0 && opts.delayMs > 0) {
        await wait(opts.delayMs + Math.round(Math.random() * 300))
      }

      try {
        const { hits, fetched } = await searchHentasis(base, query, titles, fetchPage, {
          delayMs: opts.delayMs,
          pagesBudget: Math.max(0, opts.maxPages - pages),
          strongScore: opts.strongScore,
        })
        pages += fetched

        for (const hit of hits) {
          let score = hit.score

          if (opts.year !== undefined) {
            const withYear = normalizeTitle(hit.title)
              .split(' ')
              .some((token) => token.startsWith(String(opts.year)))
            if (withYear) score = Math.min(99, score + 5)
          }

          const known = pool.get(hit.url)
          if (known === undefined || score > known.score) {
            pool.set(hit.url, { ...hit, score })
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
    if (pages >= opts.maxPages) break
  }

  const sorted = sortPool(pool)
  const best = sorted[0]
  return {
    best: best !== undefined && best.score >= opts.minScore ? best : null,
    candidates: sorted,
    pages,
  }
}
