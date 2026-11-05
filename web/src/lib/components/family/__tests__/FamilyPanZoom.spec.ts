import { fireEvent } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { renderWithTooltips } from '$tests/helpers';
import FamilyPanZoomTest from './FamilyPanZoomTest.svelte';

const transformOf = (card: HTMLElement) => card.parentElement!.style.transform;
const scaleOf = (card: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(transformOf(card))![1]);

describe('FamilyPanZoom', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  const setup = () => {
    const onCardClick = vi.fn();
    const { getByTestId, getByLabelText } = renderWithTooltips(FamilyPanZoomTest, { onCardClick });
    const card = getByTestId('card');
    const viewport = card.parentElement!.parentElement!;
    return { onCardClick, card, viewport, getByLabelText };
  };

  it('lets a plain click reach the card', async () => {
    const { onCardClick, card } = setup();
    await fireEvent.pointerDown(card, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 });
    await fireEvent.pointerUp(card, { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10 });
    await fireEvent.click(card);
    expect(onCardClick).toHaveBeenCalledTimes(1);
  });

  it('moves the content when dragged, and the drag is not a click', async () => {
    const { onCardClick, card } = setup();
    const before = transformOf(card);
    await fireEvent.pointerDown(card, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 });
    await fireEvent.pointerMove(card, { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 30 });
    await fireEvent.pointerMove(card, { pointerId: 1, pointerType: 'mouse', clientX: 60, clientY: 50 });
    await fireEvent.pointerUp(card, { pointerId: 1, pointerType: 'mouse', clientX: 60, clientY: 50 });
    await fireEvent.click(card);

    expect(transformOf(card)).not.toBe(before);
    expect(transformOf(card)).toContain('translate(50px, 40px)');
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('zooms with the mouse wheel and the buttons', async () => {
    const { card, viewport, getByLabelText } = setup();
    expect(scaleOf(card)).toBe(1);

    await fireEvent.wheel(viewport, { deltaY: -200, clientX: 0, clientY: 0 });
    const zoomedIn = scaleOf(card);
    expect(zoomedIn).toBeGreaterThan(1);

    await fireEvent.click(getByLabelText('Zoom out'));
    expect(scaleOf(card)).toBeCloseTo(zoomedIn * 0.8);

    for (let index = 0; index < 30; index++) {
      await fireEvent.click(getByLabelText('Zoom in'));
    }
    expect(scaleOf(card)).toBe(2.5);
  });
});
