// Разовая генерация THIRD-PARTY.md из package-lock.json: перечень должен совпадать с фактом,
// иначе он через месяц врёт. Пишем файлом — в выводе консоли кириллица и спецсимволы искажаются.
import { readFileSync, writeFileSync } from 'node:fs'

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

/** Имя пакета из пути node_modules/…; вложенный node_modules — тот же пакет, глубже. */
function nameOf(path) {
  const parts = path.split('node_modules/')
  return parts[parts.length - 1]
}

const rows = []
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path.includes('node_modules/')) continue
  if (!pkg.license) continue
  rows.push({ name: nameOf(path), version: pkg.version ?? '', license: pkg.license })
}

// Один и тот же пакет может прийти с разными лицензиями по разным зеркалам — оставляем
// уникальные пары «имя + версия + лицензия».
const seen = new Set()
const unique = []
for (const row of rows) {
  const key = `${row.name}@${row.version}|${row.license}`
  if (seen.has(key)) continue
  seen.add(key)
  unique.push(row)
}

unique.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version))

// Группируем по лицензии: читателю важно знать, есть ли среди них что-то копилефтное.
const byLicense = new Map()
for (const row of unique) {
  const list = byLicense.get(row.license) ?? []
  list.push(row)
  byLicense.set(row.license, list)
}

const order = [...byLicense.keys()].sort()
const head = `# Сторонние компоненты

Этот файл перечисляет зависимости, которые приходят вместе с программой, с их лицензиями.
Сгенерирован из \`package-lock.json\`; список и файл обновляются одним шагом, поэтому
расхождение между ними невозможно.

Сам код AniMori распространяется под лицензией MIT — см. [LICENSE](../LICENSE). Зависимости
распространяются на условиях своих лицензий, а не MIT.

## Что важно знать про copyleft

Одна лицензия в списке требует внимания:

- **MPL-2.0** (Mozilla Public License) — copyleft на уровне файла. Изменённый файл MPL
  обязан оставаться доступным под MPL-2.0, остальной проект под это не выпадает. Мы эти
  файлы не меняли, поэтому публиковать их исходники не требуется.

Остальные лицензии — MIT, ISC, Apache-2.0, BSD — не накладывают обязанностей на код
AniMori.

Полные тексты лицензий лежат в самих пакетах в \`node_modules\`, а при сборке Windows
копируются в архив вместе с программой — см. \`.github/workflows/release.yml\`.

## Состав

Всего пакетов с указанной лицензией: **${unique.length}**.

`

const body = order
  .map((license) => {
    const list = byLicense.get(license)
    const items = list.map((r) => `| ${r.name} | ${r.version} |`).join('\n')
    return `### ${license} (${list.length})\n\n| Пакет | Версия |\n| --- | --- |\n${items}\n`
  })
  .join('\n')

writeFileSync(new URL('../docs/THIRD-PARTY.md', import.meta.url), head + body, 'utf8')
console.log('docs/THIRD-PARTY.md готов:', unique.length, 'пакетов,', order.length, 'лицензий')
