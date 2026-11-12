<script lang="ts">
  import { goto } from '$app/navigation';
  import ImageThumbnail from '#lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import { Route } from '#lib/route';
  import { locale } from '#lib/stores/preferences.store';
  import { getAssetMediaUrl, getPeopleThumbnailUrl } from '#lib/utils';
  import { handleError } from '#lib/utils/handle-error';
  import { AssetMediaSize, getPerson, mergePeople, updatePerson, type PersonResponseDto } from '@immich/sdk';
  import { Button, Checkbox, IconButton, LoadingSpinner, Switch, Text, modalManager, toastManager } from '@immich/ui';
  import { mdiClose, mdiRefresh } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';

  type SuggestionFace = {
    assetId: string;
    imageWidth: number;
    imageHeight: number;
    boundingBoxX1: number;
    boundingBoxY1: number;
    boundingBoxX2: number;
    boundingBoxY2: number;
  };
  type SuggestionPerson = { person: PersonResponseDto; faceCount: number; faces: SuggestionFace[] };
  type Candidate = SuggestionPerson & { similarity: number };
  type Suggestion = SuggestionPerson & { candidates: Candidate[] };

  type SuggestionPage = { computedAt: string; suggestions: Suggestion[]; total: number; candidateCount: number };

  const PAGE_SIZE = 20;
  // "not the same" answers used to be kept in the browser; they are moved to the server once
  const LEGACY_DISMISSED_KEY = 'similar-people-dismissed';
  const FACE_SIZE = 56;

  let threshold = $state(0.7);
  let withHidden = $state(false);
  let loading = $state(true);
  let loadingMore = $state(false);
  let suggestions: Suggestion[] = $state([]);
  // suggestions on the server that are not loaded yet
  let remaining = $state(0);
  let candidateCount = $state(0);
  let merging = $state<string | null>(null);
  let computedAt = $state<string>();
  // pairs the user ticked; per pair so a tick never follows a person elsewhere
  const ticked = new SvelteMap<string, boolean>();

  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`/api/people/merge-suggestions${path}`, init);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.message ?? response.statusText);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  };

  const dismiss = (pairs: Array<{ personId: string; otherPersonId: string }>) =>
    api<void>('/dismissals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs }),
    });

  const moveLegacyDismissals = async () => {
    try {
      const keys: string[] = JSON.parse(localStorage.getItem(LEGACY_DISMISSED_KEY) ?? '[]');
      if (keys.length > 0) {
        await dismiss(
          keys.map((key) => key.split('|')).map(([personId, otherPersonId]) => ({ personId, otherPersonId })),
        );
      }
      localStorage.removeItem(LEGACY_DISMISSED_KEY);
    } catch {
      // kept in the browser, tried again next visit
    }
  };

  const fetchPage = (skip: number, refresh = false) => {
    const params = new URLSearchParams({
      threshold: String(threshold),
      withHidden: String(withHidden),
      refresh: String(refresh),
      skip: String(skip),
      size: String(PAGE_SIZE),
    });
    return api<SuggestionPage>(`?${params}`);
  };

  const load = async ({ refresh = false } = {}) => {
    loading = true;
    try {
      const page = await fetchPage(0, refresh);
      computedAt = page.computedAt;
      suggestions = page.suggestions;
      remaining = page.total - page.suggestions.length;
      candidateCount = page.candidateCount;
      ticked.clear();
    } catch (error) {
      handleError(error, $t('errors.failed_to_load_people'));
    } finally {
      loading = false;
    }
  };

  const loadMore = async () => {
    loadingMore = true;
    try {
      // suggestions handled on this page are gone on the server too, so the loaded count is the offset
      const page = await fetchPage(suggestions.length);
      const loaded = new Set(
        suggestions.flatMap(({ person, candidates }) => [person.id, ...candidates.map((c) => c.person.id)]),
      );
      const added = page.suggestions.filter(({ person }) => !loaded.has(person.id));
      suggestions = [...suggestions, ...added];
      remaining = Math.max(page.total - suggestions.length, 0);
      candidateCount = page.candidateCount;
    } catch (error) {
      handleError(error, $t('errors.failed_to_load_people'));
    } finally {
      loadingMore = false;
    }
  };

  // keep the page filled while working through it; call once the server has the change
  const topUp = async () => {
    if (suggestions.length < PAGE_SIZE / 2 && remaining > 0 && !loadingMore) {
      await loadMore();
    }
  };

  onMount(async () => {
    await moveLegacyDismissals();
    await load();
  });

  const isTicked = (suggestion: Suggestion, candidate: Candidate) =>
    ticked.get(pairKey(suggestion.person.id, candidate.person.id)) ?? false;

  const removePeople = (ids: Set<string>) => {
    for (const key of ticked.keys()) {
      if (key.split('|').some((id) => ids.has(id))) {
        ticked.delete(key);
      }
    }
    candidateCount -= suggestions.reduce(
      (sum, { person, candidates }) =>
        sum + (ids.has(person.id) ? candidates.length : candidates.filter((c) => ids.has(c.person.id)).length),
      0,
    );
    suggestions = suggestions
      .filter(({ person }) => !ids.has(person.id))
      .map((suggestion) => ({
        ...suggestion,
        candidates: suggestion.candidates.filter(({ person }) => !ids.has(person.id)),
      }))
      .filter(({ candidates }) => candidates.length > 0);
  };

  const displayName = (person: PersonResponseDto) => person.name || $t('similar_people_unnamed');

  const handleMerge = async (suggestion: Suggestion) => {
    const picked = suggestion.candidates.filter((candidate) => isTicked(suggestion, candidate));
    const name = suggestion.person.name || $t('similar_people_this_person');
    const confirmed = await modalManager.showDialog({
      title: $t('merge_people'),
      prompt: $t('similar_people_merge_confirmation', { values: { count: picked.length, name } }),
      confirmText: $t('merge'),
    });
    if (!confirmed) {
      return;
    }

    // the picked people disappear right away; merging many faces can take a while on the server
    const targetId = suggestion.person.id;
    const pickedIds = new Set(picked.map(({ person }) => person.id));
    removePeople(pickedIds);
    const shownTarget = () => suggestions.find(({ person }) => person.id === targetId);
    const kept = shownTarget();
    if (kept) {
      kept.faceCount += picked.reduce((sum, { faceCount }) => sum + faceCount, 0);
    }

    merging = targetId;
    try {
      const results = await mergePeople({ mergePersonDto: { ids: [targetId, ...pickedIds] } });
      const merged = results.filter(({ id, success }) => success && id !== targetId).length;
      const target = await getPerson({ id: targetId });
      const shown = shownTarget();
      if (shown) {
        shown.person = target;
      }
      toastManager.primary(
        $t('similar_people_merged', {
          values: { count: merged, name: target.name || $t('similar_people_this_person') },
        }),
      );
      if (merged < picked.length) {
        toastManager.warning($t('errors.something_went_wrong'));
        await load();
      } else {
        await topUp();
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
      await load();
    } finally {
      merging = null;
    }
  };

  const handleNotSame = async (suggestion: Suggestion, candidate: Candidate) => {
    removePair(suggestion, candidate);
    try {
      await dismiss([{ personId: suggestion.person.id, otherPersonId: candidate.person.id }]);
      await topUp();
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
      await load();
    }
  };

  // only this pair goes away: the candidate may still be suggested under another person
  const removePair = (suggestion: Suggestion, candidate: Candidate) => {
    ticked.delete(pairKey(suggestion.person.id, candidate.person.id));
    candidateCount -= 1;
    suggestions = suggestions
      .map((entry) =>
        entry.person.id === suggestion.person.id
          ? { ...entry, candidates: entry.candidates.filter(({ person }) => person.id !== candidate.person.id) }
          : entry,
      )
      .filter(({ candidates }) => candidates.length > 0);
  };

  const handleHide = async (candidate: Candidate) => {
    try {
      await updatePerson({ id: candidate.person.id, personUpdateDto: { isHidden: true } });
      toastManager.primary($t('changed_visibility_successfully'));
      if (withHidden) {
        candidate.person.isHidden = true;
      } else {
        removePeople(new Set([candidate.person.id]));
        await topUp();
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_hide_person'));
    }
  };

  // crop the face out of the preview, with some margin around it
  const faceStyle = (face: SuggestionFace) => {
    const side = Math.max(face.boundingBoxX2 - face.boundingBoxX1, face.boundingBoxY2 - face.boundingBoxY1) * 1.35;
    const centerX = (face.boundingBoxX1 + face.boundingBoxX2) / 2;
    const centerY = (face.boundingBoxY1 + face.boundingBoxY2) / 2;
    const scale = FACE_SIZE / side;
    return [
      `width: ${face.imageWidth * scale}px`,
      `height: ${face.imageHeight * scale}px`,
      `left: ${-(centerX - side / 2) * scale}px`,
      `top: ${-(centerY - side / 2) * scale}px`,
    ].join('; ');
  };
</script>

{#snippet faces(entry: SuggestionPerson)}
  <div class="flex min-w-0 flex-1 gap-1 overflow-hidden">
    {#each entry.faces as face, index (`${index}:${face.assetId}`)}
      <a
        href="/photos/{face.assetId}"
        target="_blank"
        class="relative block shrink-0 overflow-hidden rounded-lg bg-gray-200 dark:bg-gray-700"
        style="width: {FACE_SIZE}px; height: {FACE_SIZE}px"
      >
        <img
          src={getAssetMediaUrl({ id: face.assetId, size: AssetMediaSize.Preview, edited: false })}
          alt=""
          loading="lazy"
          class="absolute max-w-none"
          style={faceStyle(face)}
        />
      </a>
    {/each}
  </div>
{/snippet}

{#snippet who(entry: SuggestionPerson, size: number)}
  <a href={Route.viewPerson(entry.person)} target="_blank" class="shrink-0" style="width: {size}px">
    <ImageThumbnail
      circle
      shadow
      url={getPeopleThumbnailUrl(entry.person)}
      altText={entry.person.name}
      widthStyle="{size}px"
      heightStyle="{size}px"
      hidden={entry.person.isHidden}
    />
  </a>
  <div class="w-44 shrink-0">
    <a
      href={Route.viewPerson(entry.person)}
      target="_blank"
      class="font-medium hover:underline {entry.person.name ? '' : 'text-gray-500 italic dark:text-gray-400'}"
    >
      {displayName(entry.person)}
    </a>
    <Text size="tiny" color="muted">{$t('similar_people_faces', { values: { count: entry.faceCount } })}</Text>
  </div>
{/snippet}

<UserPageLayout
  title={$t('similar_people')}
  description={loading || !computedAt
    ? undefined
    : `${$t('similar_people_summary', { values: { count: candidateCount } })} · ${$t('similar_people_compared_at', {
        values: { time: new Date(computedAt).toLocaleString($locale, { dateStyle: 'short', timeStyle: 'short' }) },
      })}`}
>
  {#snippet buttons()}
    <div class="flex items-center gap-4">
      <label class="flex items-center gap-2 text-sm">
        {$t('similar_people_similarity')}
        <input
          type="range"
          min="0.4"
          max="0.95"
          step="0.01"
          bind:value={threshold}
          onchange={() => load()}
          class="w-28 accent-immich-primary dark:accent-immich-dark-primary"
        />
        <span class="w-9 tabular-nums">{Math.round(threshold * 100)}%</span>
      </label>
      <label class="hidden items-center gap-2 text-sm sm:flex">
        <Switch
          checked={withHidden}
          onCheckedChange={(checked) => {
            withHidden = checked;
            void load();
          }}
        />
        {$t('show_hidden_people')}
      </label>
      <IconButton
        shape="round"
        color="secondary"
        variant="ghost"
        aria-label={$t('similar_people_compare_again')}
        title={$t('similar_people_compare_again')}
        icon={mdiRefresh}
        disabled={loading}
        onclick={() => load({ refresh: true })}
      />
      <IconButton
        shape="round"
        color="secondary"
        variant="ghost"
        aria-label={$t('close')}
        icon={mdiClose}
        onclick={() => goto(Route.people())}
      />
    </div>
  {/snippet}

  <div class="mx-auto flex max-w-5xl flex-col gap-4 p-2 pb-8 md:px-8">
    {#if loading}
      <div class="flex flex-col items-center gap-3 py-20">
        <LoadingSpinner size="giant" />
        <Text color="muted">{$t('similar_people_comparing')}</Text>
      </div>
    {:else if suggestions.length === 0}
      <Text class="py-20 text-center" color="muted">{$t('similar_people_none')}</Text>
    {:else}
      {#each suggestions as suggestion (suggestion.person.id)}
        {@const count = suggestion.candidates.filter((candidate) => isTicked(suggestion, candidate)).length}
        <section class="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">
          <div class="flex flex-wrap items-center gap-3 bg-gray-100 p-3 dark:bg-immich-dark-gray">
            {@render who(suggestion, 64)}
            {@render faces(suggestion)}
          </div>

          {#each suggestion.candidates as candidate (candidate.person.id)}
            {@const sameName =
              candidate.person.name && candidate.person.name.toLowerCase() === suggestion.person.name.toLowerCase()}
            <div class="flex flex-wrap items-center gap-3 border-t border-gray-200 p-3 dark:border-gray-800">
              <Checkbox
                size="tiny"
                bind:checked={
                  () => isTicked(suggestion, candidate),
                  (checked) => ticked.set(pairKey(suggestion.person.id, candidate.person.id), checked)
                }
              />
              {@render who(candidate, 48)}
              <div class="w-24 shrink-0 text-end">
                <span class="font-semibold tabular-nums">{Math.round(candidate.similarity * 100)}%</span>
                {#if sameName}
                  <Text size="tiny" color="warning">{$t('similar_people_same_name')}</Text>
                {:else if candidate.person.name && suggestion.person.name}
                  <Text size="tiny" color="warning">
                    {$t('similar_people_also_named', { values: { name: suggestion.person.name } })}
                  </Text>
                {/if}
              </div>
              {@render faces(candidate)}
              <div class="flex gap-2">
                <Button
                  size="small"
                  variant="ghost"
                  color="secondary"
                  onclick={() => handleNotSame(suggestion, candidate)}
                >
                  {$t('similar_people_not_same')}
                </Button>
                {#if !candidate.person.isHidden}
                  <Button size="small" variant="ghost" color="secondary" onclick={() => handleHide(candidate)}>
                    {$t('hide_person')}
                  </Button>
                {/if}
              </div>
            </div>
          {/each}

          <div class="flex justify-end border-t border-gray-200 p-3 dark:border-gray-800">
            <Button
              size="small"
              disabled={count === 0}
              loading={merging === suggestion.person.id}
              onclick={() => handleMerge(suggestion)}
            >
              {$t('similar_people_merge_into', {
                values: { count, name: suggestion.person.name || $t('similar_people_this_person') },
              })}
            </Button>
          </div>
        </section>
      {/each}

      {#if remaining > 0}
        <div class="flex justify-center">
          <Button variant="ghost" loading={loadingMore} onclick={loadMore}>
            {remaining.toLocaleString($locale)} …
          </Button>
        </div>
      {/if}
    {/if}
  </div>
</UserPageLayout>
