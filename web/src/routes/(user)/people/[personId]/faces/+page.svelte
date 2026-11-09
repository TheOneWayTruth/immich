<script lang="ts">
  import { goto } from '$app/navigation';
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl, getPeopleThumbnailUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    createPerson,
    deleteFace,
    getAllPeople,
    getPerson,
    reassignFacesById,
    updatePerson,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { Button, IconButton, LoadingSpinner, Text, modalManager, toastManager } from '@immich/ui';
  import { mdiAccountBoxOutline, mdiClose, mdiAccountRemoveOutline, mdiMerge, mdiOpenInNew, mdiPlus } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';
  import PeopleList from '../[[photos=photos]]/[[assetId=id]]/PeopleList.svelte';
  import type { PageData } from './$types';

  type PersonFace = {
    id: string;
    assetId: string;
    imageWidth: number;
    imageHeight: number;
    boundingBoxX1: number;
    boundingBoxY1: number;
    boundingBoxX2: number;
    boundingBoxY2: number;
    takenAt: string;
    similarity: number | null;
  };
  type SortOrder = 'oldest' | 'least-similar';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const VIEW_KEY = 'sort-faces-view';
  // faces below this similarity get their percentage highlighted
  const LOW_SIMILARITY = 0.5;

  let person: PersonResponseDto = $state(data.person);
  let faces: PersonFace[] = $state([]);
  let loading = $state(true);
  let busy = $state(false);
  let sort = $state<SortOrder>('oldest');
  let tileSize = $state(150);
  const selected = new SvelteSet<string>();
  let lastClicked: string | null = null;

  let picking = $state(false);
  let people: PersonResponseDto[] = $state([]);
  let screenHeight = $state(0);

  const shown = $derived(
    sort === 'least-similar' ? [...faces].sort((a, b) => (a.similarity ?? 2) - (b.similarity ?? 2)) : faces,
  );

  // by date, faces from the same day share a heading; least similar first is one flat list
  const groups = $derived.by(() => {
    if (sort === 'least-similar') {
      return [{ day: null, faces: shown }];
    }
    const days: Array<{ day: string | null; faces: PersonFace[] }> = [];
    for (const face of shown) {
      const day = face.takenAt.slice(0, 10);
      if (days.at(-1)?.day === day) {
        days.at(-1)!.faces.push(face);
      } else {
        days.push({ day, faces: [face] });
      }
    }
    return days;
  });

  const toggleDay = (dayFaces: PersonFace[]) => {
    const select = dayFaces.some(({ id }) => !selected.has(id));
    for (const { id } of dayFaces) {
      if (select) {
        selected.add(id);
      } else {
        selected.delete(id);
      }
    }
  };

  onMount(async () => {
    try {
      const view = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null');
      if (view) {
        sort = view.sort === 'least-similar' ? 'least-similar' : 'oldest';
        tileSize = Number(view.tileSize) || tileSize;
      }
    } catch {
      // defaults
    }
    await load();
  });

  const saveView = () => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ sort, tileSize }));
    } catch {
      // only a convenience
    }
  };

  const load = async () => {
    loading = true;
    try {
      const response = await fetch(`/api/people/${person.id}/faces`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message ?? response.statusText);
      }
      faces = (await response.json()).faces;
      selected.clear();
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      loading = false;
    }
  };

  const handleClick = (event: MouseEvent, face: PersonFace) => {
    if (busy) {
      return;
    }
    const index = shown.findIndex(({ id }) => id === face.id);
    const from = lastClicked ? shown.findIndex(({ id }) => id === lastClicked) : -1;
    if (event.shiftKey && from !== -1) {
      const select = !selected.has(face.id);
      for (const { id } of shown.slice(Math.min(from, index), Math.max(from, index) + 1)) {
        if (select) {
          selected.add(id);
        } else {
          selected.delete(id);
        }
      }
      document.getSelection()?.removeAllRanges();
    } else if (selected.has(face.id)) {
      selected.delete(face.id);
    } else {
      selected.add(face.id);
    }
    lastClicked = face.id;
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !picking && selected.size > 0) {
      selected.clear();
      event.preventDefault();
    }
  };

  // the faces leave this page; the person's thumbnail may have been one of them
  const dropFaces = async (ids: string[]) => {
    const gone = new Set(ids);
    faces = faces.filter(({ id }) => !gone.has(id));
    for (const id of ids) {
      selected.delete(id);
    }
    person = await getPerson({ id: person.id });
  };

  // one request per face, a few at a time
  const eachFace = async (ids: string[], run: (id: string) => Promise<unknown>) => {
    const done: string[] = [];
    let failed = 0;
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          await run(id);
          done.push(id);
        } catch {
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (failed > 0) {
      toastManager.warning($t('errors.something_went_wrong'));
    }
    return done;
  };

  const moveTo = async (target: PersonResponseDto) => {
    picking = false;
    busy = true;
    try {
      const moved = await eachFace([...selected], (id) => reassignFacesById({ id: target.id, faceDto: { id } }));
      await dropFaces(moved);
      if (moved.length > 0) {
        toastManager.primary(
          $t('sort_faces_moved', {
            values: { count: moved.length, name: target.name || $t('similar_people_unnamed') },
          }),
        );
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      busy = false;
    }
  };

  const moveToNewPerson = async () => {
    try {
      const target = await createPerson({ personCreateDto: {} });
      await moveTo(target);
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };

  const openPicker = async () => {
    picking = true;
    if (people.length === 0) {
      try {
        people = (await getAllPeople({ withHidden: false })).people;
      } catch (error) {
        handleError(error, $t('errors.failed_to_load_people'));
      }
    }
  };

  const setFeatured = async () => {
    const face = faces.find(({ id }) => selected.has(id));
    if (!face) {
      return;
    }
    busy = true;
    try {
      person = await updatePerson({ id: person.id, personUpdateDto: { featureFaceAssetId: face.assetId } });
      selected.clear();
      toastManager.primary($t('feature_photo_updated'));
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      busy = false;
    }
  };

  const removeFaces = async () => {
    const ids = [...selected];
    const confirmed = await modalManager.showDialog({
      title: $t('sort_faces_not_a_face'),
      prompt: $t('sort_faces_not_a_face_confirmation', { values: { count: ids.length } }),
      confirmText: $t('remove'),
    });
    if (!confirmed) {
      return;
    }
    busy = true;
    try {
      const removed = await eachFace(ids, (id) => deleteFace({ id, assetFaceDeleteDto: { force: false } }));
      await dropFaces(removed);
      if (removed.length > 0) {
        toastManager.primary($t('sort_faces_removed', { values: { count: removed.length } }));
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      busy = false;
    }
  };

  // crop the face out of the preview with some margin; percentages so the crop follows the tile size
  const cropStyle = (face: PersonFace) => {
    const side = Math.max(face.boundingBoxX2 - face.boundingBoxX1, face.boundingBoxY2 - face.boundingBoxY1) * 1.5;
    const left = (face.boundingBoxX1 + face.boundingBoxX2) / 2 - side / 2;
    const top = (face.boundingBoxY1 + face.boundingBoxY2) / 2 - side / 2;
    return [
      `width: ${(face.imageWidth / side) * 100}%`,
      `height: ${(face.imageHeight / side) * 100}%`,
      `left: ${(-left / side) * 100}%`,
      `top: ${(-top / side) * 100}%`,
    ].join('; ');
  };

  const formatDate = (iso: string, dateStyle: 'medium' | 'full' = 'medium') =>
    new Date(iso).toLocaleDateString($locale, { dateStyle, timeZone: 'UTC' });
</script>

<svelte:window onkeydown={handleKeydown} bind:innerHeight={screenHeight} />

<UserPageLayout title={$t('sort_faces')} description={$t('sort_faces_hint')}>
  {#snippet buttons()}
    <div class="flex items-center gap-4">
      <select
        bind:value={sort}
        onchange={saveView}
        class="rounded-lg border border-gray-300 bg-transparent px-2 py-1 text-sm dark:border-gray-700"
        aria-label={$t('sort_faces')}
      >
        <option value="oldest">{$t('sort_faces_oldest')}</option>
        <option value="least-similar">{$t('sort_faces_least_similar')}</option>
      </select>
      <label class="hidden items-center gap-2 text-sm sm:flex">
        {$t('size')}
        <input
          type="range"
          min="80"
          max="280"
          step="10"
          bind:value={tileSize}
          onchange={saveView}
          class="w-28 accent-immich-primary dark:accent-immich-dark-primary"
        />
      </label>
      <IconButton
        shape="round"
        color="secondary"
        variant="ghost"
        aria-label={$t('close')}
        icon={mdiClose}
        onclick={() => goto(Route.viewPerson(person))}
      />
    </div>
  {/snippet}

  <div class="flex flex-col gap-4 p-2 pb-28 md:px-8">
    <div class="flex items-center gap-3">
      <a href={Route.viewPerson(person)} class="shrink-0">
        <ImageThumbnail
          circle
          shadow
          url={getPeopleThumbnailUrl(person)}
          altText={person.name}
          widthStyle="56px"
          heightStyle="56px"
        />
      </a>
      <div>
        <a
          href={Route.viewPerson(person)}
          class="font-medium hover:underline {person.name ? '' : 'text-gray-500 italic dark:text-gray-400'}"
        >
          {person.name || $t('similar_people_unnamed')}
        </a>
        <Text size="tiny" color="muted">{$t('similar_people_faces', { values: { count: faces.length } })}</Text>
      </div>
    </div>

    {#if loading}
      <div class="flex justify-center py-20"><LoadingSpinner size="giant" /></div>
    {:else if faces.length === 0}
      <Text class="py-20 text-center" color="muted">{$t('sort_faces_none')}</Text>
    {:else}
      {#each groups as group (group.day)}
        <section class="flex flex-col gap-2">
          {#if group.day}
            {@const allSelected = group.faces.every(({ id }) => selected.has(id))}
            <div class="mt-2 flex items-center gap-3">
              <Text class="font-medium">{formatDate(group.day, 'full')}</Text>
              <Text size="tiny" color="muted">
                {$t('similar_people_faces', { values: { count: group.faces.length } })}
              </Text>
              <Button
                size="small"
                variant="ghost"
                color="secondary"
                disabled={busy}
                onclick={() => toggleDay(group.faces)}
              >
                {allSelected ? $t('sort_faces_deselect_day') : $t('sort_faces_select_day')}
              </Button>
            </div>
          {/if}
          <div class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax({tileSize}px, 1fr))">
            {#each group.faces as face (face.id)}
              {@render tile(face, !group.day)}
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  </div>
</UserPageLayout>

{#snippet tile(face: PersonFace, withDate: boolean)}
  {@const isSelected = selected.has(face.id)}
  <div
    class="group relative overflow-hidden rounded-xl border-2 bg-gray-100 dark:bg-immich-dark-gray {isSelected
      ? 'border-immich-primary dark:border-immich-dark-primary'
      : 'border-transparent'}"
  >
    <button
      type="button"
      class="block w-full cursor-pointer select-none"
      aria-pressed={isSelected}
      onclick={(event) => handleClick(event, face)}
    >
      <div class="relative aspect-square w-full overflow-hidden bg-gray-200 dark:bg-gray-700">
        <img
          src={getAssetMediaUrl({ id: face.assetId, size: AssetMediaSize.Preview, edited: false })}
          alt=""
          loading="lazy"
          draggable="false"
          class="pointer-events-none absolute max-w-none"
          style={cropStyle(face)}
        />
      </div>
      <div class="flex justify-between px-2 py-0.5 text-xs text-gray-500 tabular-nums dark:text-gray-400">
        <span>{withDate ? formatDate(face.takenAt) : ''}</span>
        {#if face.similarity !== null}
          <span
            title={$t('sort_faces_similarity')}
            class={face.similarity < LOW_SIMILARITY ? 'font-semibold text-warning' : ''}
          >
            {Math.round(face.similarity * 100)}%
          </span>
        {/if}
      </div>
    </button>
    {#if isSelected}
      <div
        class="pointer-events-none absolute start-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-immich-primary text-sm font-bold text-white dark:bg-immich-dark-primary dark:text-black"
      >
        ✓
      </div>
    {/if}
    <a
      href={Route.viewAsset({ id: face.assetId })}
      target="_blank"
      class="absolute end-1.5 top-1.5 hidden rounded-full bg-black/60 p-1 text-white group-hover:block"
      title={$t('view_in_timeline')}
    >
      <svg viewBox="0 0 24 24" class="size-4 fill-current"><path d={mdiOpenInNew} /></svg>
    </a>
  </div>
{/snippet}

{#if selected.size > 0 && !picking}
  <div
    class="fixed inset-x-0 bottom-0 z-40 flex flex-wrap items-center justify-center gap-2 border-t border-gray-200 bg-light p-3 shadow-lg dark:border-gray-800"
  >
    <Text class="me-2 font-medium">{$t('selected_count', { values: { count: selected.size } })}</Text>
    <Button size="small" variant="ghost" color="secondary" disabled={busy} onclick={() => selected.clear()}>
      {$t('clear')}
    </Button>
    <Button size="small" leadingIcon={mdiMerge} loading={busy} disabled={busy} onclick={openPicker}>
      {$t('sort_faces_move_to')}
    </Button>
    <Button size="small" variant="outline" leadingIcon={mdiPlus} disabled={busy} onclick={moveToNewPerson}>
      {$t('create_new_person')}
    </Button>
    <Button
      size="small"
      variant="outline"
      leadingIcon={mdiAccountBoxOutline}
      disabled={busy || selected.size !== 1}
      onclick={setFeatured}
    >
      {$t('set_as_featured_photo')}
    </Button>
    <Button
      size="small"
      variant="outline"
      color="danger"
      leadingIcon={mdiAccountRemoveOutline}
      disabled={busy}
      onclick={removeFaces}
    >
      {$t('sort_faces_not_a_face')}
    </Button>
  </div>
{/if}

{#if picking}
  <section class="fixed inset-0 z-50 bg-light">
    <ControlAppBar onClose={() => (picking = false)}>
      {#snippet leading()}
        {$t('sort_faces_move_title', { values: { count: selected.size } })}
      {/snippet}
      {#snippet trailing()}
        <Button shape="round" size="small" leadingIcon={mdiPlus} onclick={moveToNewPerson}>
          {$t('create_new_person')}
        </Button>
      {/snippet}
    </ControlAppBar>
    <section class="px-4 pt-25 md:px-17.5">
      <PeopleList {people} peopleToNotShow={[person]} {screenHeight} onSelect={moveTo} />
    </section>
  </section>
{/if}
