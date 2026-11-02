<script lang="ts">
  import FamilyPersonPicker, { type FamilyPick } from '$lib/components/family/FamilyPersonPicker.svelte';
  import {
    familyApi,
    type FamilyGender,
    type FamilyGraph,
    type FamilyRelation,
    type FamilyTreeResponse,
  } from '$lib/utils/family';
  import { handleError } from '$lib/utils/handle-error';
  import { Field, FormModal, Select, Stack } from '@immich/ui';
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
    { value: 'partner', relation: 'partner', key: 'family_rel_partner' },
    { value: 'parent', relation: 'parent', key: 'family_rel_parent' },
    { value: 'sibling', relation: 'sibling', key: 'family_rel_sibling' },
    { value: 'child', relation: 'child', key: 'family_rel_child' },
  ];

  const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  const options = $derived(
    choices.map(({ value, key, gender }) => ({
      value,
      label: capitalize($t(key, { values: { gender: gender ?? 'other' } })),
    })),
  );

  let choice = $state('mother');
  let pick = $state<FamilyPick>();
  let saving = $state(false);

  const onSubmit = async () => {
    const selected = choices.find(({ value }) => value === choice);
    if (!selected || !pick || saving) {
      return;
    }
    saving = true;
    try {
      const { memberId: pickedMemberId, personId, name } = pick;
      const tree = await familyApi.addRelation({
        member: { memberId: pickedMemberId, personId, name },
        relation: selected.relation,
        other: { memberId },
        gender: selected.gender,
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
    <FamilyPersonPicker {graph} {nameOf} bind:value={pick} exclude={[memberId]} />
  </Stack>
</FormModal>
