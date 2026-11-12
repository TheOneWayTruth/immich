<script lang="ts">
  import FamilyPersonPicker, { type FamilyPick } from '#lib/components/family/FamilyPersonPicker.svelte';
  import {
    familyApi,
    type FamilyGender,
    type FamilyGraph,
    type FamilyRelation,
    type FamilyTreeResponse,
  } from '#lib/utils/family';
  import { handleError } from '#lib/utils/handle-error';
  import { Checkbox, Field, FormModal, Label, Select, Stack } from '@immich/ui';
  import { mdiAccountMultiplePlusOutline } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    graph: FamilyGraph;
    memberId: string;
    nameOf: (id: string) => string;
    onClose: (tree?: FamilyTreeResponse) => void;
  };

  const { graph, memberId, nameOf, onClose }: Props = $props();

  const choices: Array<{ value: string; relation: FamilyRelation; key: Translations; gender?: FamilyGender }> = [
    { value: 'mother', relation: 'parent', key: 'family_rel_parent', gender: 'female' },
    { value: 'father', relation: 'parent', key: 'family_rel_parent', gender: 'male' },
    { value: 'sister', relation: 'sibling', key: 'family_rel_sibling', gender: 'female' },
    { value: 'brother', relation: 'sibling', key: 'family_rel_sibling', gender: 'male' },
    { value: 'daughter', relation: 'child', key: 'family_rel_child', gender: 'female' },
    { value: 'son', relation: 'child', key: 'family_rel_child', gender: 'male' },
    { value: 'wife', relation: 'partner', key: 'family_rel_partner', gender: 'female' },
    { value: 'husband', relation: 'partner', key: 'family_rel_partner', gender: 'male' },
  ];

  const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  const options = $derived(
    choices.map(({ value, key, gender }) => ({
      value,
      label: capitalize($t(key, { values: { gender: gender ?? 'other' } })),
    })),
  );

  let choice = $state('mother');
  let isStep = $state(false);
  let pick = $state<FamilyPick>();
  // only parents and children can be step relatives
  const canBeStep = $derived(['parent', 'child'].includes(choices.find(({ value }) => value === choice)?.relation ?? ''));
  let saving = $state(false);

  // someone already related by blood or as a partner cannot become another close relative (a father is no brother);
  // in-laws and step relatives can, e.g. a stepfather turns out to be the father
  const closeRelations = new Set<Translations>([
    'family_rel_parent',
    'family_rel_grandparent',
    'family_rel_child',
    'family_rel_grandchild',
    'family_rel_sibling',
    'family_rel_half_sibling',
    'family_rel_aunt',
    'family_rel_niece',
    'family_rel_cousin',
    'family_rel_partner',
  ]);
  const exclude = $derived.by(() => {
    const gender = choices.find(({ value }) => value === choice)?.gender;
    const excluded = [memberId];
    if (canBeStep && isStep) {
      // a stepparent is often already in the tree as the partner of a parent, or even taken as a parent
      return excluded;
    }
    for (const member of graph.members.values()) {
      const relation = graph.relation(member.id, memberId);
      if ((relation && closeRelations.has(relation.key)) || (gender && member.gender && member.gender !== gender)) {
        excluded.push(member.id);
      }
    }
    return excluded;
  });
  const surname = $derived(nameOf(memberId).trim().split(/\s+/).at(-1) ?? '');

  $effect(() => {
    if (pick && exclude.includes(pick.personId)) {
      pick = undefined;
    }
  });

  const onSubmit = async () => {
    const selected = choices.find(({ value }) => value === choice);
    if (!selected || !pick || saving) {
      return;
    }
    saving = true;
    try {
      const tree = await familyApi.addRelation({
        personId: pick.personId,
        relation: selected.relation,
        otherId: memberId,
        gender: selected.gender,
        isStep: canBeStep && isStep,
      });
      onClose(tree);
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      saving = false;
    }
  };
</script>

<FormModal
  title={$t('family_add_relative_of', { values: { name: nameOf(memberId) } })}
  size="medium"
  icon={mdiAccountMultiplePlusOutline}
  onClose={() => onClose()}
  {onSubmit}
  submitText={$t('add')}
  disabled={!pick || saving}
>
  <Stack gap={4}>
    <Field label={$t('family_relationship')}>
      <Select bind:value={choice} {options} />
    </Field>
    {#if canBeStep}
      <div class="flex items-center gap-2">
        <Checkbox id="family-relative-step" size="small" bind:checked={isStep} />
        <Label for="family-relative-step" label={$t('family_step')} />
      </div>
    {/if}
    <FamilyPersonPicker
      {graph}
      {nameOf}
      bind:value={pick}
      {exclude}
      surname={graph.members.get(memberId)?.name ? surname : ''}
    />
  </Stack>
</FormModal>
