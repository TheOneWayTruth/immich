<script lang="ts">
  import FamilyPanZoom from '#lib/components/family/FamilyPanZoom.svelte';

  type Props = { onCardClick: () => void };

  const { onCardClick }: Props = $props();
</script>

<FamilyPanZoom width={400} height={300}>
  <button type="button" data-testid="card" onclick={onCardClick}>card</button>
</FamilyPanZoom>
