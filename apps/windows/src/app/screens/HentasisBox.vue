<script setup lang="ts">
// Бокс источника Hentasis (18+) в списке сбоку: домены, автопоиск по названиям,
// ручная ссылка и выбор файла. Кадр играет на весь экран (HentasisStage).
import { watch } from 'vue'

import { hentasis } from './hentasis-store'

const props = defineProps<{ animeId: number }>()

const state = hentasis.state

watch(
  () => props.animeId,
  (id) => hentasis.bindAnime(id),
  { immediate: true },
)
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
      <button
        class="am-hx__save"
        type="button"
        :disabled="state.busy"
        @click="hentasis.runSearch()"
      >
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

    <div v-if="state.files.length > 0" class="am-hx__files">
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

    <div v-if="state.others.length > 1" class="am-hx__others">
      <span class="am-hx__cap">Другие совпадения</span>
      <button
        v-for="other in state.others"
        :key="other.url"
        class="am-hx__other"
        type="button"
        :disabled="state.busy"
        @click="hentasis.useCandidate(other.url)"
      >
        {{ other.title }}
      </button>
    </div>

    <a
      v-if="state.matchedUrl !== ''"
      class="am-hx__link"
      :href="state.matchedUrl"
      target="_blank"
      rel="noreferrer noopener"
    >
      Открыть страницу на сайте ↗
    </a>
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

.am-hx__files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
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

.am-hx__others {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.am-hx__other {
  border: 0;
  padding: 4px 0;
  background: none;
  color: #8ab4ff;
  text-align: left;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.am-hx__link {
  color: #8ab4ff;
  font-size: 12px;
  text-decoration: none;
}
</style>
