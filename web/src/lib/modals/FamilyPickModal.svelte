<script lang="ts">
  import FamilyPersonPicker, { type FamilyPick } from '#lib/components/family/FamilyPersonPicker.svelte';
  import type { FamilyGender, FamilyGraph } from '#lib/utils/family';
  import { Button, Field, FormModal, HStack, Stack } from '@immich/ui';
  import { mdiAccountPlusOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    title: string;
    graph: FamilyGraph;
    nameOf: (id: string) => string;
    onClose: (pick?: FamilyPick & { gender?: FamilyGender }) => void;
  };

  const { title, graph, nameOf, onClose }: Props = $props();

  let pick = $state<FamilyPick>();
  let gender = $state<FamilyGender>();

  // someone already in the tree keeps their gender; everyone new is a woman or a man
  const needsGender = $derived(!!pick && !pick.inTree);
  const genders = $derived([
    { value: 'female' as const, label: $t('family_gender_female') },
    { value: 'male' as const, label: $t('family_gender_male') },
  ]);
</script>

<FormModal
  {title}
  size="medium"
  icon={mdiAccountPlusOutline}
  onClose={() => onClose()}
  onSubmit={() => onClose(pick && { ...pick, gender: needsGender ? gender : undefined })}
  submitText={$t('add')}
  disabled={!pick || (needsGender && !gender)}
>
  <Stack gap={4}>
    <FamilyPersonPicker {graph} {nameOf} withMembers={false} bind:value={pick} />
    {#if needsGender}
      <Field label={$t('family_gender')}>
        <HStack gap={2}>
          {#each genders as option (option.value)}
            <Button
              size="small"
              variant={gender === option.value ? 'filled' : 'outline'}
              color={gender === option.value ? 'primary' : 'secondary'}
              onclick={() => (gender = option.value)}
            >
              {option.label}
            </Button>
          {/each}
        </HStack>
      </Field>
    {/if}
  </Stack>
</FormModal>
