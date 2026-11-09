<script lang="ts" module>
  /** a person, already in the family tree or not */
  export type FamilyPick = { personId: string; label: string; inTree: boolean };
</script>

<script lang="ts">
  import FamilyAvatar from '$lib/components/family/FamilyAvatar.svelte';
  import type { FamilyGraph } from '$lib/utils/family';
  import { getAllPeople, searchPerson, type PersonResponseDto } from '@immich/sdk';
  import { Icon, Input, LoadingSpinner, Text } from '@immich/ui';
  import { mdiCheck } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    graph: FamilyGraph;
    /** how a member is shown, e.g. "father of Lisa" for someone without a name */
    nameOf: (id: string) => string;
    value?: FamilyPick;
    /** members that cannot be picked */
    exclude?: string[];
    /** false when only someone not yet in the tree may be picked */
    withMembers?: boolean;
    /** people with this last name are listed first, and suggested before anything is typed */
    surname?: string;
  };

  let {
    graph,
    nameOf,
    value = $bindable(),
    exclude = [],
    withMembers = true,
    surname = '',
  }: Props = $props();

  let query = $state('');
  let people = $state<PersonResponseDto[]>([]);
  let suggested = $state<PersonResponseDto[]>([]);
  let searching = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const peopleInTree = $derived(new Set(graph.members.keys()));

  const lastName = (name: string) => {
    const words = name.trim().toLowerCase().split(/\s+/);
    return words.length > 1 ? words.at(-1)! : '';
  };
  const treeSurnames = $derived(new Set([...graph.members.values()].map(({ name }) => lastName(name)).filter(Boolean)));
  /** 2 for the wanted last name, 1 for any last name in the family tree */
  const rank = (name: string) => {
    const last = lastName(name);
    if (!last) {
      return 0;
    }
    return last === surname.toLowerCase() ? 2 : treeSurnames.has(last) ? 1 : 0;
  };
  const byRank = <T,>(items: T[], nameOfItem: (item: T) => string) =>
    items
      .map((item, index) => ({ item, index, rank: rank(nameOfItem(item)) }))
      .sort((a, b) => b.rank - a.rank || a.index - b.index)
      .map(({ item }) => item);

  type Entry = { key: string; pick: FamilyPick; name: string; description?: string };

  // family members and people with photos in one list, the wanted last name first, members before people
  const entries = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const members: Entry[] = withMembers
      ? [...graph.members.values()]
          .filter((member) => !exclude.includes(member.id))
          .map((member) => ({
            key: member.id,
            pick: { personId: member.id, label: nameOf(member.id), inTree: true },
            name: member.name,
            description: $t('family_tree'),
          }))
          .filter(({ pick }) => !needle || pick.label.toLowerCase().includes(needle))
      : [];
    const persons: Entry[] = (needle ? people : suggested)
      .filter((person) => !peopleInTree.has(person.id))
      .map((person) => ({
        key: person.id,
        pick: { personId: person.id, label: person.name || $t('family_unknown_person'), inTree: false },
        name: person.name,
      }));
    return byRank([...members, ...persons], ({ name }) => name).slice(0, needle ? 40 : 12);
  });

  // before anything is typed: people with the wanted last name, or else the people with the most photos
  $effect(() => {
    const name = surname.trim();
    const request =
      name.length >= 2
        ? searchPerson({ name, withHidden: false }).then((found) => found.filter((person) => rank(person.name) === 2))
        : getAllPeople({ withHidden: false, size: 60 }).then(({ people }) => people.filter((person) => person.name));
    request.then((found) => (suggested = found)).catch(() => (suggested = []));
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
            people = found;
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

  const isPicked = (selection: FamilyPick) => value?.personId === selection.personId;
</script>

{#snippet option(selection: FamilyPick, description?: string)}
  <button
    type="button"
    class="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-gray-100 dark:hover:bg-gray-800 {isPicked(
      selection,
    )
      ? 'bg-primary/10 dark:bg-primary/20'
      : ''}"
    onclick={() => pick(selection)}
  >
    <FamilyAvatar personId={selection.personId} name={selection.label} size="2.5rem" />
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
    placeholder={$t('search_people')}
  />

  <div class="flex max-h-80 flex-col overflow-y-auto">
    {#each entries as entry (entry.key)}
      {@render option(entry.pick, entry.description)}
    {/each}

    {#if searching}
      <div class="flex justify-center p-2"><LoadingSpinner /></div>
    {/if}

  </div>
</div>
