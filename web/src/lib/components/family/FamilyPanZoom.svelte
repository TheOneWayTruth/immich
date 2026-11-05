<script lang="ts">
  import { IconButton } from '@immich/ui';
  import { mdiFitToScreenOutline, mdiMinus, mdiPlus } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';

  type Props = {
    /** size of the content, in content pixels */
    width: number;
    height: number;
    children: Snippet;
    /** shown on top, not moved or zoomed */
    overlay?: Snippet;
  };

  const { width, height, children, overlay }: Props = $props();

  const MIN_SCALE = 0.15;
  const MAX_SCALE = 2.5;
  const PADDING = 32;
  /** how far the pointer moves before a press becomes a drag instead of a click */
  const DRAG_THRESHOLD = 4;

  let viewport = $state<HTMLElement>();
  let x = $state(0);
  let y = $state(0);
  let scale = $state(1);
  let animate = $state(false);
  let dragging = $state(false);

  type Point = { x: number; y: number };
  const pointers = new SvelteMap<number, Point>();
  let pressedAt: Point | undefined;
  let dragged = false;

  const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  const size = () => ({ width: viewport?.clientWidth ?? 0, height: viewport?.clientHeight ?? 0 });
  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = viewport!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

  /** zooms by factor while the given viewport point stays where it is */
  const zoomAt = (factor: number, at: Point) => {
    const next = clamp(scale * factor);
    const ratio = next / scale;
    x = at.x - (at.x - x) * ratio;
    y = at.y - (at.y - y) * ratio;
    scale = next;
  };

  export const zoom = (factor: number) => {
    animate = true;
    const { width: viewWidth, height: viewHeight } = size();
    zoomAt(factor, { x: viewWidth / 2, y: viewHeight / 2 });
  };

  /** shows all of the content */
  export const fit = () => {
    const { width: viewWidth, height: viewHeight } = size();
    if (!viewWidth || !viewHeight) {
      return;
    }
    animate = true;
    scale = clamp(Math.min(viewWidth / (width + 2 * PADDING), viewHeight / (height + 2 * PADDING), 1));
    x = (viewWidth - (width + 2 * PADDING) * scale) / 2;
    y = (viewHeight - (height + 2 * PADDING) * scale) / 2;
  };

  /** moves a content point to the middle, zooming in to at least minScale */
  export const centerOn = (contentX: number, contentY: number, minScale = 0) => {
    const { width: viewWidth, height: viewHeight } = size();
    animate = true;
    scale = clamp(Math.max(scale, minScale));
    x = viewWidth / 2 - (contentX + PADDING) * scale;
    y = viewHeight / 2 - (contentY + PADDING) * scale;
  };

  const onpointerdown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    animate = false;
    pointers.set(event.pointerId, local(event));
    if (pointers.size === 1) {
      pressedAt = local(event);
      dragged = false;
    }
  };

  const onpointermove = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      return;
    }
    const current = local(event);

    if (pointers.size >= 2) {
      // pinch: zoom by the change in finger distance around their middle, and follow the middle
      const [first, second] = [...pointers];
      const other = first[0] === event.pointerId ? second[1] : first[1];
      const before = distance(previous, other);
      const after = distance(current, other);
      pointers.set(event.pointerId, current);
      if (before > 0) {
        zoomAt(after / before, { x: (current.x + other.x) / 2, y: (current.y + other.y) / 2 });
      }
      x += (current.x - previous.x) / 2;
      y += (current.y - previous.y) / 2;
      dragged = true;
      return;
    }

    pointers.set(event.pointerId, current);
    if (!dragged && pressedAt && distance(current, pressedAt) > DRAG_THRESHOLD) {
      // only capture once it is a drag, so a plain click still reaches the card under the pointer
      dragged = true;
      dragging = true;
      viewport?.setPointerCapture(event.pointerId);
    }
    if (dragged) {
      x += current.x - previous.x;
      y += current.y - previous.y;
    }
  };

  const onpointerup = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) {
      dragging = false;
      pressedAt = undefined;
    }
  };

  // the end of a drag is not a click on whatever card is under the pointer
  const onclickcapture = (event: MouseEvent) => {
    if (dragged) {
      event.stopPropagation();
      event.preventDefault();
      dragged = false;
    }
  };

  $effect(() => {
    if (!viewport) {
      return;
    }
    // wheel listeners added by Svelte are passive, and this one has to stop the page from scrolling
    const onwheel = (event: WheelEvent) => {
      event.preventDefault();
      animate = false;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(Math.exp(-delta * 0.0015), local(event));
    };
    viewport.addEventListener('wheel', onwheel, { passive: false });
    return () => viewport?.removeEventListener('wheel', onwheel);
  });
</script>

<div
  bind:this={viewport}
  class="relative size-full touch-none overflow-hidden select-none {dragging ? 'cursor-grabbing' : 'cursor-grab'}"
  role="presentation"
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={onpointerup}
  {onclickcapture}
>
  <div
    class="absolute inset-s-0 top-0 origin-top-left"
    style:transform="translate({x}px, {y}px) scale({scale})"
    style:transition={animate ? 'transform 250ms ease-out' : 'none'}
    style:padding="{PADDING}px"
  >
    {@render children()}
  </div>

  {#if overlay}
    {@render overlay()}
  {/if}

  <div class="absolute inset-e-4 bottom-4 flex flex-col gap-1 rounded-2xl bg-light/90 p-1 shadow-md">
    <IconButton
      icon={mdiPlus}
      shape="round"
      size="small"
      variant="ghost"
      color="secondary"
      aria-label={$t('family_zoom_in')}
      onclick={() => zoom(1.25)}
    />
    <IconButton
      icon={mdiMinus}
      shape="round"
      size="small"
      variant="ghost"
      color="secondary"
      aria-label={$t('family_zoom_out')}
      onclick={() => zoom(0.8)}
    />
    <IconButton
      icon={mdiFitToScreenOutline}
      shape="round"
      size="small"
      variant="ghost"
      color="secondary"
      aria-label={$t('family_fit_to_screen')}
      onclick={fit}
    />
  </div>
</div>
