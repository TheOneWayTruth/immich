<script lang="ts">
  import { goto } from '$app/navigation';
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl, getPeopleThumbnailUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
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

  const PAGE_SIZE = 20;
  const DISMISSED_KEY = 'similar-people-dismissed';
  const FACE_SIZE = 56;

  let threshold = $state(0.7);
  let withHidden = $state(false);
  let loading = $state(true);
  let suggestions: Suggestion[] = $state([]);
  let shown = $state(PAGE_SIZE);
  let merging = $state<string | null>(null);
  let computedAt = $state<string>();
  // pairs the user ticked or unticked, overriding the default; per pair so a tick never follows a person elsewhere
  const ticked = new SvelteMap<string, boolean>();

  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const readDismissed = (): Set<string> => {
    try {
      return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  };

  const load = async ({ refresh = false } = {}) => {
    loading = true;
    try {
      const params = new URLSearchParams({
        threshold: String(threshold),
        withHidden: String(withHidden),
        refresh: String(refresh),
      });
      const response = await fetch(`/api/people/merge-suggestions?${params}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message ?? response.statusText);
      }
      const dismissed = readDismissed();
      const result = (await response.json()) as { computedAt: string; suggestions: Suggestion[] };
      computedAt = result.computedAt;
      suggestions = result.suggestions
        .map((suggestion) => ({
          ...suggestion,
          candidates: suggestion.candidates.filter(
            ({ person }) => !dismissed.has(pairKey(suggestion.person.id, person.id)),
          ),
        }))
        .filter(({ candidates }) => candidates.length > 0);
      shown = PAGE_SIZE;
      ticked.clear();
    } catch (error) {
      handleError(error, $t('errors.failed_to_load_people'));
    } finally {
      loading = false;
    }
  };

  onMount(() => load());

  const isTicked = (suggestion: Suggestion, candidate: Candidate) =>
    ticked.get(pairKey(suggestion.person.id, candidate.person.id)) ?? candidate.similarity >= threshold + 0.1;

  const removePeople = (ids: Set<string>) => {
    for (const key of ticked.keys()) {
      if (key.split('|').some((id) => ids.has(id))) {
        ticked.delete(key);
      }
    }
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

    merging = suggestion.person.id;
    try {
      const results = await mergePeople({
        mergePersonDto: { ids: [suggestion.person.id, ...picked.map(({ person }) => person.id)] },
      });
      const merged = new Set(
        results.filter(({ id, success }) => success && id !== suggestion.person.id).map(({ id }) => id),
      );
      const target = await getPerson({ id: suggestion.person.id });
      suggestion.person = target;
      suggestion.faceCount += picked
        .filter(({ person }) => merged.has(person.id))
        .reduce((sum, { faceCount }) => sum + faceCount, 0);
      removePeople(merged);
      toastManager.primary(
        $t('similar_people_merged', {
          values: { count: merged.size, name: target.name || $t('similar_people_this_person') },
        }),
      );
      if (merged.size < picked.length) {
        toastManager.warning($t('errors.something_went_wrong'));
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      merging = null;
    }
  };

  const handleNotSame = (suggestion: Suggestion, candidate: Candidate) => {
    const dismissed = readDismissed();
    dismissed.add(pairKey(suggestion.person.id, candidate.person.id));
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
    } catch {
      // still hidden for this visit
    }
    suggestion.candidates = suggestion.candidates.filter(({ person }) => person.id !== candidate.person.id);
    suggestions = suggestions.filter(({ candidates }) => candidates.length > 0);
  };

  const handleHide = async (candidate: Candidate) => {
    try {
      await updatePerson({ id: candidate.person.id, personUpdateDto: { isHidden: true } });
      toastManager.primary($t('changed_visibility_successfully'));
      if (withHidden) {
        candidate.person.isHidden = true;
      } else {
        removePeople(new Set([candidate.person.id]));
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

  const total = $derived(suggestions.reduce((sum, { candidates }) => sum + candidates.length, 0));
</script>

{#snippet faces(entry: SuggestionPerson)}
  <div class="flex min-w-0 flex-1 gap-1 overflow-hidden">
    {#each entry.faces as face (face.assetId)}
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
    : `${$t('similar_people_summary', { values: { count: total } })} · ${$t('similar_people_compared_at', {
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
      {#each suggestions.slice(0, shown) as suggestion (suggestion.person.id)}
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

      {#if shown < suggestions.length}
        <div class="flex justify-center">
          <Button variant="ghost" onclick={() => (shown += PAGE_SIZE)}>
            {(suggestions.length - shown).toLocaleString($locale)} …
          </Button>
        </div>
      {/if}
    {/if}
  </div>
</UserPageLayout>
