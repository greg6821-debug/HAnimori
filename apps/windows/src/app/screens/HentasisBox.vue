<script setup lang="ts">
// Бокс источника Hentasis (18+) в списке сбоку: домены, автопоиск по названиям,
// ручная ссылка и выбор файла. Кадр играет в общем теге основного плеера.
import { computed, ref, watch } from 'vue'

import type { HentasisFile } from '@/api/hentasis'
import { Bridge } from '@/bridge'

import { hentasis } from './hentasis-store'

const props = defineProps<{ animeId: number }>()

const state = hentasis.state

/** Файлы в боксе спрятаны за переключателем: основной путь — списки плеера
 * («Озвучка»/«Серии»), здесь они остаются запасным доступом. */
const showFiles = ref(false)

/** Наружу через оболочку — тем же путём, что ссылки описания на карточке:
 * в WebView2 новый таргет молча отбрасывается, а переход в том же окне унёс бы приложение. */
async function openSite(): Promise<void> {
  const url = state.matchedUrl
  if (url === '') return

  try {
    await Bridge.shell.openExternal(url)
  } catch (e: unknown) {
    state.trouble = `Браузер не открылся: ${e instanceof Error ? e.message : String(e)}`
  }
}

watch(
  () => props.animeId,
  (id) => {
    showFiles.value = false
    hentasis.bindAnime(id)
  },
  { immediate: true },
)

/** Есть ли пометки хоть у одного файла: без них рисуем простую оборку, как раньше. */
const hasNotes = computed<boolean>(() => state.files.some((file) => file.note !== undefined))

/** Группа = ВСЕ файлы с одинаковой пометкой (вид + команда), где бы они ни стояли
 * в списке: две озвучки от разных команд — две строки, два субтитра от разных
 * переводчиков — ещё две. Порядок групп — по первому появлению пометки (порядок
 * сайта), внутри группы — порядок сайта. Файлы без пометок не склеиваются:
 * у каждого своя строка, как у файлов без примечания в целом. */
interface FileGroup {
  note: string
  items: { file: HentasisFile; index: number }[]
}

const groups = computed<FileGroup[]>(() => {
  const byNote = new Map<string, FileGroup>()

  for (let i = 0; i < state.files.length; i += 1) {
    const file = state.files[i]
    if (file === undefined) continue

    const note = file.note ?? ''
    // Файл без пометки — группа из одного: пустая строка не должна склеивать их в ряд.
    const key = note === '' ? `\u0000${i}` : note

    const found = byNote.get(key)
    if (found !== undefined) found.items.push({ file, index: i })
    else byNote.set(key, { note, items: [{ file, index: i }] })
  }

  return [...byNote.values()]
})
</script>

<template>
  <div class="am-hx">
    <label class="am-hx__field">
      <span class="am-hx__cap">Домены для поиска (через запятую)</span>
      <input
        v-model="state.basesText"
        class="am-hx__url"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder="https://hentasis1.top"
        aria-label="Домены Hentasis"
        @keydown.stop
        @change="hentasis.setBases(state.basesText)"
      />
    </label>

    <div class="am-hx__row">
      <button class="am-hx__save" type="button" :disabled="state.busy" @click="hentasis.runSearch()">
        Искать по названию
      </button>
      <button
        v-if="state.manualUrl !== ''"
        class="am-hx__file"
        type="button"
        :disabled="state.busy"
        @click="hentasis.forget()"
      >
        Забыть
      </button>
    </div>

    <p v-if="state.busy && state.phase === 'search'" class="am-hx__note" role="status">
      Ищу тайтл по названиям с AniList…
    </p>
    <p v-else-if="state.busy" class="am-hx__note" role="status">Читаю страницу…</p>
    <p v-else-if="state.trouble !== ''" class="am-hx__note am-hx__note--err" role="alert">
      {{ state.trouble }}
    </p>
    <p v-else-if="state.notice !== ''" class="am-hx__note" role="status">{{ state.notice }}</p>
    <p v-else-if="state.matchedTitle !== ''" class="am-hx__note" role="status">
      Нашёл: {{ state.matchedTitle }}
      <template v-if="state.matchedScore > 0"> (совпадение {{ state.matchedScore }}%)</template>
    </p>
    <p v-else class="am-hx__note">
      Найду страницу сам по названиям с AniList — или вставь ниже домен/ссылку.
    </p>

    <label class="am-hx__field">
      <span class="am-hx__cap">Домен или ссылка на тайтл</span>
      <span class="am-hx__row">
        <input
          v-model="state.manualUrl"
          class="am-hx__url"
          type="text"
          inputmode="url"
          spellcheck="false"
          autocomplete="off"
          placeholder="https://hentasis1.top или https://…/1094-….html"
          aria-label="Домен или ссылка на страницу Hentasis"
          @keydown.stop
        />
        <button
          class="am-hx__save"
          type="button"
          :disabled="state.busy || state.manualUrl.trim() === ''"
          @click="hentasis.useManual()"
        >
          Открыть
        </button>
      </span>
    </label>

    <!-- Файлы спрятаны: они дублируют список «Серии» плеера. Показываются по желанию. -->
    <template v-if="state.files.length > 0">
      <button class="am-hx__file" type="button" @click="showFiles = !showFiles">
        {{ showFiles ? 'Спрятать файлы' : `Показать файлы · ${state.files.length}` }}
      </button>

      <template v-if="showFiles">
        <div v-if="!hasNotes" class="am-hx__files">
          <button
            v-for="(file, index) in state.files"
            :key="file.url"
            class="am-hx__file"
            :class="{ 'am-hx__file--on': index === state.picked }"
            type="button"
            @click="hentasis.play(index)"
          >
            {{ file.label }}
          </button>
        </div>

        <div v-else class="am-hx__groups">
          <div v-for="(group, gi) in groups" :key="gi" class="am-hx__group">
            <button
              v-for="item in group.items"
              :key="item.file.url"
              class="am-hx__filecard"
              :class="{ 'am-hx__filecard--on': item.index === state.picked }"
              type="button"
              @click="hentasis.play(item.index)"
            >
              <span>{{ item.file.label }}</span>
              <span v-if="item.file.note" class="am-hx__file-note">{{ item.file.note }}</span>
            </button>
          </div>
        </div>
      </template>
    </template>

    <button
      v-if="state.matchedUrl !== ''"
      class="am-hx__link"
      type="button"
      @click="openSite()"
    >
      Открыть страницу на сайте ↗
    </button>
  </div>
</template>

<style scoped>
.am-hx {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: #e8e8ee;
}

.am-hx__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.am-hx__cap {
  font-size: 11px;
  opacity: 0.7;
}

.am-hx__row {
  display: flex;
  gap: 6px;
}

.am-hx__url {
  flex: 1;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid #2b2b3d;
  border-radius: 8px;
  background: #0f0f16;
  color: inherit;
  font: inherit;
}

.am-hx__url:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 1px;
}

.am-hx__save {
  border: 0;
  border-radius: 8px;
  padding: 7px 12px;
  background: #3b82f6;
  color: #fff;
  cursor: pointer;
  font: inherit;
}

.am-hx__save:disabled {
  opacity: 0.5;
  cursor: default;
}

.am-hx__note {
  margin: 0;
  line-height: 1.4;
  opacity: 0.85;
}

.am-hx__note--err {
  opacity: 1;
  color: #ff8080;
}

/* Обычная однострочная кнопка: ею пользуются и «Забыть», и файлы без пометок. */
.am-hx__file {
  border: 1px solid #2b2b3d;
  border-radius: 8px;
  padding: 5px 10px;
  background: #16161f;
  color: inherit;
  cursor: pointer;
  font: inherit;
}

.am-hx__file:disabled {
  opacity: 0.5;
}

.am-hx__file--on {
  border-color: #e5484d;
  background: #2a1215;
}

/* Карточка файла с пометкой: две строки, текст сверху вниз. */
.am-hx__filecard {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: 1px solid #2b2b3d;
  border-radius: 8px;
  padding: 5px 10px;
  background: #16161f;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.am-hx__filecard--on {
  border-color: #e5484d;
  background: #2a1215;
}

.am-hx__file-note {
  font-size: 11px;
  opacity: 0.7;
}

/* Группы: столбик строк с зазором ~1/3 высоты кнопки (кнопка ~30px → 10px);
   внутри группы свои кнопки переносятся, но чужие в строку не попадают. */
.am-hx__groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.am-hx__group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.am-hx__link {
  padding: 0;
  background: none;
  border: 0;
  color: #8ab4ff;
  font-size: 12px;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.am-hx__link:hover {
  text-decoration: underline;
}
</style>
