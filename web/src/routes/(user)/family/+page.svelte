<script lang="ts">
  import { goto } from '$app/navigation';
  import FamilyAvatar from '#lib/components/family/FamilyAvatar.svelte';
  import FamilyPanZoom from '#lib/components/family/FamilyPanZoom.svelte';
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import FamilyPickModal from '#lib/modals/FamilyPickModal.svelte';
  import FamilyRelativeModal from '#lib/modals/FamilyRelativeModal.svelte';
  import { Route } from '#lib/route';
  import {
    FAMILY_CARD,
    FamilyGraph,
    familyApi,
    layoutFamily,
    type FamilyGender,
    type FamilyLink,
    type FamilyRelationLabel,
    type FamilyTreeResponse,
  } from '#lib/utils/family';
  import { handleError } from '#lib/utils/handle-error';
  import { getPerson } from '@immich/sdk';
  import { Button, Field, IconButton, LoadingSpinner, Text, modalManager } from '@immich/ui';
  import {
    mdiAccountMultiplePlusOutline,
    mdiAccountPlusOutline,
    mdiClose,
    mdiImageMultipleOutline,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  let tree = $state<FamilyTreeResponse>();
  let selectedId = $state<string>();
  let missingPerson = $state<{ id: string; name: string }>();
  let busy = $state(false);
  let panZoom = $state<FamilyPanZoom>();

  const graph = $derived(new FamilyGraph(tree?.members ?? [], tree?.links ?? []));
  const layout = $derived(layoutFamily(graph));
  const selected = $derived(selectedId ? graph.members.get(selectedId) : undefined);
  // relationships are named from the selected person's point of view
  const focusId = $derived(selected?.id);

  const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  const label = (relation: FamilyRelationLabel) => $t(relation.key, { values: relation.values });

  const nameOf = (id: string): string => {
    const member = graph.members.get(id);
    if (!member) {
      return '';
    }
    if (member.name) {
      return member.name;
    }
    const description = graph.describe(id);
    if (!description) {
      return $t('family_unknown_person');
    }
    return capitalize(
      $t('family_relation_of', {
        values: { relation: label(description.relation), name: description.of.map(({ name }) => name).join(' & ') },
      }),
    );
  };

  const relationTo = (id: string, otherId: string | undefined) => {
    const relation = otherId ? graph.relation(id, otherId) : undefined;
    return relation ? capitalize(label(relation)) : '';
  };

  const genderOptions = $derived([
    { value: 'female' as const, label: $t('family_gender_female') },
    { value: 'male' as const, label: $t('family_gender_male') },
  ]);

  /** center moves the selected member into view, e.g. when picked from the list instead of the map */
  const select = async (id: string | undefined, { center = true } = {}) => {
    selectedId = id;
    await tick();
    const node = id ? layout.nodes.find((item) => item.id === id) : undefined;
    if (center && node) {
      panZoom?.centerOn(node.x, node.y, 0.7);
    }
  };

  const run = async (action: () => Promise<FamilyTreeResponse | undefined>) => {
    if (busy) {
      return;
    }
    busy = true;
    // the member being worked on stays where it is on screen, however the rest of the tree moves
    const anchorId = selectedId;
    const before = anchorId ? layout.nodes.find((node) => node.id === anchorId) : undefined;
    const screen = before && panZoom?.toScreen(before.x, before.y);
    try {
      const result = await action();
      if (result) {
        tree = result;
        await tick();
        const after = anchorId ? layout.nodes.find((node) => node.id === anchorId) : undefined;
        if (after && screen) {
          panZoom?.keepAt(after.x, after.y, screen);
        }
        if (result.memberId) {
          await select(result.memberId, { center: false });
          const added = layout.nodes.find((node) => node.id === result.memberId);
          if (added) {
            panZoom?.ensureVisible(added.x, added.y, FAMILY_CARD.width, FAMILY_CARD.height);
          }
        } else if (selectedId && !graph.members.has(selectedId)) {
          await select(undefined);
        }
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      busy = false;
    }
  };

  onMount(async () => {
    try {
      tree = await familyApi.get();
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
      return;
    }
    // show the whole tree first, then move to the selected member
    await tick();
    panZoom?.fit();
    if (data.personId) {
      if (graph.members.has(data.personId)) {
        await select(data.personId);
      } else {
        const person = await getPerson({ id: data.personId }).catch(() => undefined);
        if (person) {
          missingPerson = { id: person.id, name: person.name || $t('family_unknown_person') };
        }
      }
    }
  });

  const addFirstPerson = async () => {
    const pick = await modalManager.show(FamilyPickModal, {
      title: $t('family_add_person'),
      graph,
      nameOf,
    });
    if (pick) {
      await run(() => familyApi.addMember({ personId: pick.personId, gender: pick.gender }));
    }
  };

  const addMissingPerson = async (gender: FamilyGender) => {
    if (missingPerson) {
      const { id } = missingPerson;
      missingPerson = undefined;
      await run(() => familyApi.addMember({ personId: id, gender }));
    }
  };

  const addRelative = async () => {
    if (selectedId) {
      const result = await modalManager.show(FamilyRelativeModal, { graph, memberId: selectedId, nameOf });
      if (result) {
        await run(() => Promise.resolve(result));
      }
    }
  };

  const removeMember = async () => {
    if (!selected) {
      return;
    }
    const id = selected.id;
    const confirmed = await modalManager.showDialog({
      title: $t('family_remove_member'),
      prompt: $t('family_remove_member_prompt', { values: { name: nameOf(id) } }),
      confirmText: $t('remove'),
    });
    if (confirmed) {
      await run(() => familyApi.deleteMember(id));
    }
  };

  const relatives = $derived.by(() => {
    if (!selected) {
      return [];
    }
    const id = selected.id;
    const linkedSiblings = graph.linkedSiblingsOf(id);
    /** step: the parent and child of a parent link, which can be switched between by blood and step */
    type Row = { id: string; link?: FamilyLink; step?: { parentId: string; childId: string; isStep: boolean } };
    const parentRow = (parentId: string, childId: string, other: string): Row => {
      const link = graph.parentLink(parentId, childId);
      return {
        id: other,
        // an inferred parent is not stored, so there is nothing to remove; it can only become a stepparent
        link: link && !link.inferred ? link : undefined,
        step: { parentId, childId, isStep: !!link?.isStep },
      };
    };
    const rows: Row[] = [
      ...[...graph.parentsOf(id), ...graph.stepParentsOf(id)].map((other) => parentRow(other, id, other)),
      ...graph
        .partnersOf(id)
        .map((other) => ({ id: other, link: { type: 'partner', fromId: id, toId: other } as const })),
      ...graph.siblingsOf(id).map((other) => ({
        id: other,
        link: linkedSiblings.includes(other) ? ({ type: 'sibling', fromId: id, toId: other } as const) : undefined,
      })),
      ...[...graph.childrenOf(id), ...graph.stepChildrenOf(id)].map((other) => parentRow(id, other, other)),
    ];
    return rows;
  });
</script>

<UserPageLayout title={$t('family_tree')} scrollbar={false}>
  {#snippet buttons()}
    {#if tree && tree.members.length > 0}
      <Button
        leadingIcon={mdiAccountPlusOutline}
        size="small"
        variant="ghost"
        color="secondary"
        onclick={addFirstPerson}
      >
        {$t('family_add_person')}
      </Button>
    {/if}
  {/snippet}

  <div class="flex h-full flex-col lg:flex-row">
    <div class="relative min-h-[60vh] min-w-0 grow lg:min-h-0">
      {#if !tree}
        <div class="flex justify-center p-12"><LoadingSpinner size="giant" /></div>
      {:else if tree.members.length === 0}
        <div class="mx-auto flex max-w-md flex-col items-center gap-4 p-12 text-center">
          <Text color="muted">{$t('family_empty_description')}</Text>
          <Button leadingIcon={mdiAccountPlusOutline} onclick={addFirstPerson}>{$t('family_add_first_person')}</Button>
        </div>
      {:else}
        <FamilyPanZoom bind:this={panZoom} width={layout.width} height={layout.height}>
          <div class="relative" style:width="{layout.width}px" style:height="{layout.height}px">
            <svg
              class="absolute inset-0 overflow-visible"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              {#each layout.lines as line, index (index)}
                <polyline
                  points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                  fill="none"
                  class={line.kind === 'partner' ? 'stroke-primary/60' : 'stroke-gray-400 dark:stroke-gray-500'}
                  stroke-dasharray={line.kind === 'sibling' || line.kind === 'step' ? '5 4' : undefined}
                  stroke-width={line.kind === 'partner' ? 3 : 1.5}
                />
              {/each}
            </svg>

            {#each layout.nodes as node (node.id)}
              {@const member = graph.members.get(node.id)!}
              {@const relation = node.id === focusId ? '' : relationTo(node.id, focusId)}
              <button
                type="button"
                data-member-id={node.id}
                class="absolute flex flex-col items-center gap-1 rounded-2xl border bg-light p-2 text-center shadow-sm transition-colors hover:border-primary {node.id ===
                selectedId
                  ? 'border-primary ring-2 ring-primary'
                  : 'border-gray-200 dark:border-gray-700'}"
                style:left="{node.x - FAMILY_CARD.width / 2}px"
                style:top="{node.y - FAMILY_CARD.height / 2}px"
                style:width="{FAMILY_CARD.width}px"
                style:height="{FAMILY_CARD.height}px"
                onclick={() => select(node.id, { center: false })}
              >
                <FamilyAvatar personId={member.id} name={member.name} size="4.5rem" />
                <span class="line-clamp-2 text-sm/tight font-medium {member.name ? '' : 'text-gray-500 italic'}">
                  {nameOf(node.id)}
                </span>
                {#if relation}
                  <span class="line-clamp-2 text-xs/tight text-primary">{relation}</span>
                {/if}
              </button>
            {/each}
          </div>

          {#snippet overlay()}
            {#if focusId}
              <Text size="small" color="muted" class="pointer-events-none absolute inset-s-4 top-3">
                {$t('family_focus_hint')}
              </Text>
            {/if}
          {/snippet}
        </FamilyPanZoom>
      {/if}

      {#if missingPerson}
        <div
          class="absolute inset-x-0 top-0 z-10 m-4 flex flex-wrap items-center gap-3 rounded-2xl bg-gray-100 p-4 dark:bg-gray-800"
        >
          <FamilyAvatar personId={missingPerson.id} name={missingPerson.name} size="2.5rem" />
          <Text class="grow">{$t('family_not_in_tree', { values: { name: missingPerson.name } })}</Text>
          <Button size="small" leadingIcon={mdiAccountPlusOutline} onclick={() => addMissingPerson('female')}>
            {$t('family_add_as', { values: { gender: 'female' } })}
          </Button>
          <Button size="small" leadingIcon={mdiAccountPlusOutline} onclick={() => addMissingPerson('male')}>
            {$t('family_add_as', { values: { gender: 'male' } })}
          </Button>
        </div>
      {/if}
    </div>

    {#if selected}
      {@const id = selected.id}
      <aside
        class="flex shrink-0 flex-col gap-4 overflow-y-auto border-t p-4 lg:w-96 lg:border-s lg:border-t-0 dark:border-gray-700"
      >
        <div class="flex items-start gap-3">
          <FamilyAvatar personId={id} name={selected.name} size="4rem" />
          <div class="min-w-0 grow">
            <h2 class="text-lg font-semibold wrap-break-word">{nameOf(id)}</h2>
          </div>
          <IconButton
            icon={mdiClose}
            shape="round"
            size="small"
            variant="ghost"
            color="secondary"
            aria-label={$t('close')}
            onclick={() => select(undefined)}
          />
        </div>

        <Field label={$t('family_gender')}>
          <div class="flex gap-2">
            {#each genderOptions as option (option.value)}
              <Button
                size="small"
                variant={selected.gender === option.value ? 'filled' : 'outline'}
                color={selected.gender === option.value ? 'primary' : 'secondary'}
                onclick={() => run(() => familyApi.setGender(id, option.value))}
              >
                {option.label}
              </Button>
            {/each}
          </div>
        </Field>

        <div class="flex flex-wrap gap-2">
          <Button size="small" leadingIcon={mdiAccountMultiplePlusOutline} onclick={addRelative} disabled={busy}>
            {$t('family_add_relative')}
          </Button>
          <Button
            size="small"
            variant="ghost"
            color="secondary"
            leadingIcon={mdiImageMultipleOutline}
            onclick={() =>
              goto(
                selected.hasPerson === false
                  ? Route.search({ personIds: [id] })
                  : Route.viewPerson({ id }, { previousRoute: Route.family() }),
              )}
          >
            {$t('family_open_photos')}
          </Button>
        </div>
        {#if selected.hasPerson === false}
          <Text size="small" color="muted">{$t('family_added_by_other')}</Text>
        {/if}

        {#if relatives.length > 0}
          <div class="flex flex-col gap-1">
            <Text size="small" color="muted" class="font-medium">{$t('family_relatives')}</Text>
            {#each relatives as relative (relative.id + (relative.step ? 'parent' : (relative.link?.type ?? 'sibling')))}
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="flex min-w-0 grow items-center gap-3 rounded-xl px-2 py-1.5 text-start hover:bg-gray-100 dark:hover:bg-gray-800"
                  onclick={() => select(relative.id)}
                >
                  <FamilyAvatar personId={relative.id} name={graph.members.get(relative.id)?.name ?? ''} size="2.25rem" />
                  <div class="min-w-0">
                    <Text class="truncate">{nameOf(relative.id)}</Text>
                    <Text size="tiny" class="truncate text-primary">{relationTo(relative.id, id)}</Text>
                  </div>
                </button>
                {#if relative.step}
                  {@const step = relative.step}
                  <Button
                    size="tiny"
                    shape="round"
                    variant={step.isStep ? 'filled' : 'outline'}
                    color={step.isStep ? 'primary' : 'secondary'}
                    title={$t('family_step_description')}
                    disabled={busy}
                    onclick={() => run(() => familyApi.setStep({ ...step, isStep: !step.isStep }))}
                  >
                    {$t('family_step')}
                  </Button>
                {/if}
                {#if relative.link}
                  {@const link = relative.link}
                  <IconButton
                    icon={mdiClose}
                    shape="round"
                    size="small"
                    variant="ghost"
                    color="secondary"
                    aria-label={$t('family_remove_link')}
                    title={$t('family_remove_link')}
                    onclick={() => run(() => familyApi.removeLink(link))}
                  />
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <div class="mt-auto pt-4">
          <Button
            size="small"
            variant="ghost"
            color="danger"
            leadingIcon={mdiTrashCanOutline}
            onclick={removeMember}
            disabled={busy}
          >
            {$t('family_remove_member')}
          </Button>
        </div>
      </aside>
    {/if}
  </div>
</UserPageLayout>
