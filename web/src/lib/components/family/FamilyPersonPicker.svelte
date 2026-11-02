<script lang="ts" module>
  /** a family member, a person with photos, a new person without photos (name) or an unknown person ({}) */
  export type FamilyPick = { memberId?: string; personId?: string; name?: string; label: string };
</script>

<script lang="ts">
  import FamilyAvatar from '$lib/components/family/FamilyAvatar.svelte';
  import type { FamilyGraph } from '$lib/utils/family';
  import { searchPerson, type PersonResponseDto } from '@immich/sdk';
  import { Icon, Input, LoadingSpinner, Text } from '@immich/ui';
  import { mdiAccountPlusOutline, mdiAccountQuestionOutline, mdiCheck } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    graph: FamilyGraph;
    /** how a member is shown, e.g. "father of Lisa" for someone without a name */
    nameOf: (id: string) => string;
    value?: FamilyPick;
    /** members that cannot be picked */
    exclude?: string[];
    /** only people with photos, e.g. to link a member to a person */
    peopleOnly?: boolean;
  };

  let { graph, nameOf, value = $bindable(), exclude = [], peopleOnly = false }: Props = $props();

  let query = $state('');
  let people = $state<PersonResponseDto[]>([]);
  let searching = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const peopleInTree = $derived(new Set([...graph.members.values()].map((member) => member.personId)));

  const members = $derived.by(() => {
    if (peopleOnly) {
      return [];
    }
    const needle = query.trim().toLowerCase();
    return [...graph.members.values()]
      .filter((member) => !exclude.includes(member.id))
      .map((member) => ({ member, label: nameOf(member.id) }))
      .filter(({ label }) => !needle || label.toLowerCase().includes(needle))
      .slice(0, needle ? 20 : 8);
  });

  const search = (name: string) => {
    clearTimeout(timer);
    if (!name.trim()) {
      people = [];
      searching = false;
      return;
    }
    searching = true;
    timer = setTimeout(() => {
      searchPerson({ name: name.trim(), withHidden: false })
        .then((found) => {
          if (query === name) {
            people = found.filter((person) => !peopleInTree.has(person.id)).slice(0, 20);
          }
        })
        .catch(() => (people = []))
        .finally(() => {
          if (query === name) {
            searching = false;
          }
        });
    }, 250);
  };

  const pick = (selection: FamilyPick) => {
    value = selection;
  };

  const isPicked = (selection: Partial<FamilyPick>) =>
    !!value &&
    value.memberId === selection.memberId &&
    value.personId === selection.personId &&
    (value.memberId || value.personId ? true : value.name === selection.name);
</script>

{#snippet option(selection: FamilyPick, personId: string | null | undefined, description?: string)}
  <button
    type="button"
    class="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-gray-100 dark:hover:bg-gray-800 {isPicked(
      selection,
    )
      ? 'bg-primary/10 dark:bg-primary/20'
      : ''}"
    onclick={() => pick(selection)}
  >
    {#if selection.memberId || selection.personId}
      <FamilyAvatar {personId} name={selection.label} size="2.5rem" />
    {:else}
      <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700">
        <Icon icon={selection.name ? mdiAccountPlusOutline : mdiAccountQuestionOutline} size="1.4rem" />
      </div>
    {/if}
    <div class="min-w-0 grow">
      <Text class="truncate">{selection.label}</Text>
      {#if description}
        <Text size="tiny" color="muted" class="truncate">{description}</Text>
      {/if}
    </div>
    {#if isPicked(selection)}
      <Icon icon={mdiCheck} size="1.25rem" class="text-primary" />
    {/if}
  </button>
{/snippet}

<div class="flex flex-col gap-2">
  <Input
    bind:value={() => query, (text) => ((query = text), search(text))}
    placeholder={peopleOnly ? $t('search_people') : $t('family_search_people')}
  />

  <div class="flex max-h-80 flex-col overflow-y-auto">
    {#each members as { member, label } (member.id)}
      {@render option({ memberId: member.id, label }, member.personId, $t('family_tree'))}
    {/each}

    {#each people as person (person.id)}
      {@render option({ personId: person.id, label: person.name || $t('family_unknown_person') }, person.id)}
    {/each}

    {#if searching}
      <div class="flex justify-center p-2"><LoadingSpinner /></div>
    {/if}

    {#if !peopleOnly}
      {#if query.trim()}
        {@render option(
          { name: query.trim(), label: $t('family_new_person_named', { values: { name: query.trim() } }) },
          null,
        )}
      {/if}
      {@render option({ label: $t('family_unknown_person') }, null, $t('family_unknown_person_description'))}
    {/if}
  </div>
</div>
