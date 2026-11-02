<script lang="ts">
  import FamilyPersonPicker, { type FamilyPick } from '$lib/components/family/FamilyPersonPicker.svelte';
  import type { FamilyGraph } from '$lib/utils/family';
  import { FormModal } from '@immich/ui';
  import { mdiAccountPlusOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    title: string;
    graph: FamilyGraph;
    nameOf: (id: string) => string;
    peopleOnly?: boolean;
    onClose: (pick?: FamilyPick) => void;
  };

  const { title, graph, nameOf, peopleOnly = false, onClose }: Props = $props();

  let pick = $state<FamilyPick>();
</script>

<FormModal
  {title}
  size="medium"
  icon={mdiAccountPlusOutline}
  onClose={() => onClose()}
  onSubmit={() => onClose(pick)}
  submitText={$t('add')}
  disabled={!pick}
>
  <FamilyPersonPicker {graph} {nameOf} {peopleOnly} bind:value={pick} />
</FormModal>
