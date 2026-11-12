<script lang="ts">
  import ImageThumbnail from '#lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import { getPeopleThumbnailUrl } from '#lib/utils';
  import type { PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAccountQuestionOutline } from '@mdi/js';

  type Props = {
    personId: string | null | undefined;
    name: string;
    size?: string;
  };

  const { personId, name, size = '3rem' }: Props = $props();
</script>

{#if personId}
  <!-- ImageThumbnail keeps its first image, so a different person needs a new one -->
  {#key personId}
    <ImageThumbnail
      circle
      shadow
      url={getPeopleThumbnailUrl({ id: personId } as PersonResponseDto)}
      altText={name}
      widthStyle={size}
      heightStyle={size}
    />
  {/key}
{:else}
  <div
    class="flex shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-300"
    style:width={size}
    style:height={size}
  >
    {#if name}
      <span class="text-lg font-medium">{name.slice(0, 1).toUpperCase()}</span>
    {:else}
      <Icon icon={mdiAccountQuestionOutline} size="60%" />
    {/if}
  </div>
{/if}
