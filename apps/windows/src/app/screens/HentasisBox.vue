<script setup lang="ts">
// Бокс источника Hentasis (18+): три слота «домен или ссылка на тайтл».
// Автопоиск при открытии тайтла — только по первому домену; кнопка у любого
// слота открывает ссылку или ищет по домену и добавляет файлы к общему списку.
// Кадр играет в общем теге основного плеера.
import { computed, ref, watch } from 'vue'

import type { HentasisFile } from '@/api/hentasis'
import { Bridge } from '@/bridge'

import { hentasis } from './hentasis-store'

const props = defineProps<{ animeId: number }>()

const state = hentasis.state

const showFiles = ref(false)

async function openSite(): Promise<void> {
  const url = state.matchedUrls[0]
  if (url === undefined || url === '') return

  try {
    await Bridge.shell.openExternal(url)
  } catch (e: unknown) {
    state.trouble = `Браузер не открылся: ${e instanceof Error ? e.message : String(e)}`
  }
}

function saveBases(): void {
  localStorage.setItem('animori:hentasis-bases', JSON.stringify([...state.basesText]))
}

watch(
  () => props.animeId,
  (id) => {
    showFiles.value = false
    hentasis.bindAnime(id)
  },
  { immediate: true },
)

const hasNotes = computed<boolean>(() => state.files.some((file) => file.note !== undefined))

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
    <span class="am-hx__cap">Ссылки на тайтл</span>

    <div v-for="n in 3" :key="`u${n}`" class="am-hx__row">
      <input
        v-model="state.manualUrls[n - 1]"
        class="am-hx__url"
        type="text"
        inputmode="url"
        spellcheck="false"
        autocomplete="off"
        :placeholder="
          n === 1 ? 'https://v6.hentasis.me или ссылка на тайтл' : `слот ${n}: домен или ссылка`
        "
        :aria-label="`Ссылка или домен ${n}`"
        @keydown.stop
      />
      <button
        class="am-hx__save"
        type="button"
        :disabled="state.busy || state.slotBusy >= 0 || (state.manualUrls[n - 1] ?? '').trim() === ''"
        @click="hentasis.openSlot(n - 1)"
      >
        Открыть
      </button>
    </div>

    <span class="am-hx__cap">Домены поиска</span>

    <div v-for="n in 3" :key="`d${n}`" class="am-hx__row">
      <input
        v-model="state.basesText[n - 1]"
        class="am-hx__url"
        type="text"
        spellcheck="false"
        autocomplete="off"
        :placeholder="
          n === 1 ? 'https://v6.hentasis.me' : n === 2 ? 'https://hentasis1.top' : 'третий домен'
        "
        :aria-label="`Домен поиска ${n}`"
        @keydown.stop
        @change="saveBases()"
      />
      <button
        class="am-hx__save"
        type="button"
        :disabled="state.busy || state.slotBusy >= 0 || (state.basesText[n - 1] ?? '').trim() === ''"
        @click="hentasis.searchDomain(n - 1)"
      >
        Найти
      </button>
    </div>
    
    <p v-if="state.resolving" class="am-hx__note" role="status">Открываю файл…</p>
    <p v-else-if="state.busy || state.slotBusy >= 0" class="am-hx__note" role="status">Ищу тайтл…</p>
    <p v-else-if="state.trouble !== ''" class="am-hx__note am-hx__note--err" role="alert">
      {{ state.trouble }}
    </p>
    <p v-else-if="state.notice !== ''" class="am-hx__note" role="status">{{ state.notice }}</p>
    <p v-else-if="state.matchedTitles.some((t) => t !== '')" class="am-hx__note" role="status">
      {{
        state.matchedTitles
          .map((t, i) => (t !== '' ? `${i + 1}: ${t}` : null))
          .filter(Boolean)
          .join(' · ')
      }}
    </p>

    <!-- Файлы спрятаны за переключателем: основной путь — списки плеера. -->
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
      v-if="state.matchedUrls[0] !== undefined && state.matchedUrls[0] !== ''"
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
  cursor: pointer;
  font: inherit;
}

.am-hx__link:hover {
  text-decoration: underline;
}
</style>
