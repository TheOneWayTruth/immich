import {
  FAMILY_CARD,
  FamilyGraph,
  layoutFamily,
  type FamilyGender,
  type FamilyLink,
  type FamilyMember,
} from '$lib/utils/family';

const member = (id: string, gender: FamilyGender | null = null, name = id): FamilyMember => ({
  id,
  personId: null,
  name,
  gender,
  birthDate: null,
  isPlaceholder: false,
  isMe: false,
});
const parent = (fromId: string, toId: string): FamilyLink => ({ type: 'parent', fromId, toId });
const partner = (fromId: string, toId: string): FamilyLink => ({ type: 'partner', fromId, toId });

/**
 *            grandma ── grandpa
 *         ┌─────────┴──────────┐
 *   maria(f) ── tom(m)     anna(f) ── max(m)          maria's sister is anna
 *       │                  ┌───┴───┐
 *     ben(m)            lisa(f)  paul(m)
 *                          │
 *                        emma(f)
 */
const graph = new FamilyGraph(
  [
    member('grandma', 'female'),
    member('grandpa', 'male'),
    member('maria', 'female'),
    member('tom', 'male'),
    member('anna', 'female'),
    member('max', 'male'),
    member('ben', 'male'),
    member('lisa', 'female'),
    member('paul', 'male'),
    member('emma', 'female'),
    member('stranger'),
  ],
  [
    partner('grandma', 'grandpa'),
    parent('grandma', 'maria'),
    parent('grandpa', 'maria'),
    parent('grandma', 'anna'),
    parent('grandpa', 'anna'),
    partner('maria', 'tom'),
    parent('maria', 'ben'),
    parent('tom', 'ben'),
    partner('anna', 'max'),
    parent('anna', 'lisa'),
    parent('max', 'lisa'),
    parent('anna', 'paul'),
    parent('max', 'paul'),
    parent('lisa', 'emma'),
  ],
);

describe('FamilyGraph.relation', () => {
  const tests: Array<[string, string, string, Record<string, unknown>]> = [
    ['anna', 'lisa', 'family_rel_parent', { gender: 'female' }],
    ['lisa', 'anna', 'family_rel_child', { gender: 'female' }],
    ['paul', 'lisa', 'family_rel_sibling', { gender: 'male' }],
    ['maria', 'anna', 'family_rel_sibling', { gender: 'female' }],
    ['maria', 'lisa', 'family_rel_aunt', { gender: 'female', greats: 0 }],
    ['maria', 'emma', 'family_rel_aunt', { gender: 'female', greats: 1 }],
    ['lisa', 'maria', 'family_rel_niece', { gender: 'female', greats: 0 }],
    ['ben', 'lisa', 'family_rel_cousin', { gender: 'male', degree: 1, removed: 0 }],
    ['ben', 'emma', 'family_rel_cousin', { gender: 'male', degree: 1, removed: 1 }],
    ['grandma', 'lisa', 'family_rel_grandparent', { gender: 'female', greats: 0 }],
    ['grandpa', 'emma', 'family_rel_grandparent', { gender: 'male', greats: 1 }],
    ['emma', 'anna', 'family_rel_grandchild', { gender: 'female', greats: 0 }],
    ['tom', 'maria', 'family_rel_partner', { gender: 'male' }],
    ['grandma', 'tom', 'family_rel_parent_in_law', { gender: 'female' }],
    ['anna', 'tom', 'family_rel_sibling_in_law', { gender: 'female' }],
    ['tom', 'anna', 'family_rel_sibling_in_law', { gender: 'male' }],
    ['max', 'grandpa', 'family_rel_child_in_law', { gender: 'male' }],
    ['tom', 'lisa', 'family_rel_aunt', { gender: 'male', greats: 0 }],
    ['tom', 'max', 'family_rel_co_sibling_in_law', { gender: 'male' }],
  ];

  for (const [a, b, key, values] of tests) {
    it(`${a} is ${key} of ${b}`, () => {
      expect(graph.relation(a, b)).toEqual({ key, values });
    });
  }

  it('is undefined for people that are not connected', () => {
    expect(graph.relation('stranger', 'lisa')).toBeUndefined();
    expect(graph.relation('lisa', 'lisa')).toBeUndefined();
  });

  it('knows step siblings', () => {
    const step = new FamilyGraph(
      [member('mom', 'female'), member('dad', 'male'), member('a'), member('b', 'male')],
      [partner('mom', 'dad'), parent('mom', 'a'), parent('dad', 'b')],
    );
    expect(step.relation('b', 'a')).toEqual({ key: 'family_rel_step_sibling', values: { gender: 'male' } });
  });

  it('has no label for relatives without a word of their own', () => {
    const withPartner = new FamilyGraph(
      [...graph.members.values(), member('x', 'male')],
      [...graph.links, partner('lisa', 'x')],
    );
    // the partner of a cousin
    expect(withPartner.relation('x', 'ben')).toBeUndefined();
  });

  it('knows half siblings', () => {
    const half = new FamilyGraph(
      [member('mom', 'female'), member('dad1', 'male'), member('dad2', 'male'), member('a'), member('b', 'female')],
      [parent('mom', 'a'), parent('dad1', 'a'), parent('mom', 'b'), parent('dad2', 'b')],
    );
    expect(half.relation('b', 'a')).toEqual({ key: 'family_rel_half_sibling', values: { gender: 'female' } });
  });

  it('treats siblings joined by an unknown parent as siblings, and their children as cousins', () => {
    const unknown = { ...member('unknown', null, ''), isPlaceholder: true };
    const siblings = new FamilyGraph(
      [unknown, member('maria', 'female'), member('anna', 'female'), member('lisa', 'female')],
      [parent('unknown', 'maria'), parent('unknown', 'anna'), parent('anna', 'lisa')],
    );
    expect(siblings.relation('maria', 'anna')?.key).toBe('family_rel_sibling');
    expect(siblings.relation('maria', 'lisa')?.key).toBe('family_rel_aunt');
  });

  it('uses "other" when the gender is not known', () => {
    expect(new FamilyGraph([member('a'), member('b')], [parent('a', 'b')]).relation('a', 'b')).toEqual({
      key: 'family_rel_parent',
      values: { gender: 'other' },
    });
  });
});

describe('FamilyGraph.describe', () => {
  it('describes a nameless member by a named relative', () => {
    const nameless = new FamilyGraph([member('x', 'male', ''), member('lisa', 'female')], [parent('x', 'lisa')]);
    expect(nameless.describe('x')).toEqual({
      relation: { key: 'family_rel_parent', values: { gender: 'male' } },
      of: [nameless.members.get('lisa')],
    });
  });
});

describe('layoutFamily', () => {
  it('puts children below their parents and partners next to each other', () => {
    const layout = layoutFamily(graph);
    const node = (id: string) => layout.nodes.find((item) => item.id === id)!;

    expect(node('grandma').y).toBeLessThan(node('anna').y);
    expect(node('anna').y).toBeLessThan(node('lisa').y);
    expect(node('lisa').y).toBeLessThan(node('emma').y);
    expect(node('anna').y).toBe(node('max').y);
    expect(Math.abs(node('anna').x - node('max').x)).toBeLessThan(200);
    expect(layout.nodes).toHaveLength(11);

    // no two cards overlap
    for (const a of layout.nodes) {
      for (const b of layout.nodes) {
        if (a !== b && a.y === b.y) {
          expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(132);
        }
      }
    }
  });
});

describe('layoutFamily lines', () => {
  it('connects both parents to their children when they are not partners', () => {
    const family = new FamilyGraph(
      [member('galina', 'female'), member('irina', 'female'), member('sergej', 'male'), member('a'), member('b')],
      [
        parent('galina', 'irina'),
        parent('irina', 'a'),
        parent('sergej', 'a'),
        parent('irina', 'b'),
        parent('sergej', 'b'),
      ],
    );
    const layout = layoutFamily(family);
    const node = (id: string) => layout.nodes.find((item) => item.id === id)!;
    const startsAt = (id: string) =>
      layout.lines.some(({ points: [[x, y]] }) => x === node(id).x && y === node(id).y + FAMILY_CARD.height / 2);

    expect(Math.abs(node('irina').x - node('sergej').x)).toBe(FAMILY_CARD.width + FAMILY_CARD.gapX);
    expect(startsAt('irina')).toBe(true);
    expect(startsAt('sergej')).toBe(true);
  });

  it('draws one line from between partners', () => {
    const family = new FamilyGraph(
      [member('mom', 'female'), member('dad', 'male'), member('kid')],
      [partner('mom', 'dad'), parent('mom', 'kid'), parent('dad', 'kid')],
    );
    const layout = layoutFamily(family);
    const mom = layout.nodes.find(({ id }) => id === 'mom')!;
    const dad = layout.nodes.find(({ id }) => id === 'dad')!;
    expect(
      layout.lines.some(({ kind, points: [[x, y]] }) => kind === 'child' && x === (mom.x + dad.x) / 2 && y === mom.y),
    ).toBe(true);
  });
});

describe('layoutFamily spacing', () => {
  // two couples, each with two children, side by side in the same rows
  const members = ['a1', 'a2', 'ak1', 'ak2', 'b1', 'b2', 'bk1', 'bk2'].map((id) => member(id));
  const links = [
    partner('a1', 'a2'),
    parent('a1', 'ak1'),
    parent('a2', 'ak1'),
    parent('a1', 'ak2'),
    parent('a2', 'ak2'),
    partner('b1', 'b2'),
    parent('b1', 'bk1'),
    parent('b2', 'bk1'),
    parent('b1', 'bk2'),
    parent('b2', 'bk2'),
  ];

  it('keeps siblings close and leaves room between families', () => {
    const layout = layoutFamily(new FamilyGraph(members, links));
    const x = (id: string) => layout.nodes.find((node) => node.id === id)!.x;
    const { width, gapX, familyGap } = FAMILY_CARD;

    expect(Math.abs(x('ak1') - x('ak2'))).toBe(width + gapX);
    const [left, right] = x('ak1') < x('bk1') ? ['ak', 'bk'] : ['bk', 'ak'];
    const between = Math.min(x(`${right}1`), x(`${right}2`)) - Math.max(x(`${left}1`), x(`${left}2`));
    expect(between).toBeGreaterThanOrEqual(width + familyGap);
  });

  it('draws overlapping lines of different families at different heights', () => {
    // dad has children with two partners, so both families' lines run below him
    const layout = layoutFamily(
      new FamilyGraph(
        ['first', 'dad', 'second', 'k1', 'k2'].map((id) => member(id)),
        [
          partner('first', 'dad'),
          partner('dad', 'second'),
          parent('first', 'k1'),
          parent('dad', 'k1'),
          parent('dad', 'k2'),
          parent('second', 'k2'),
        ],
      ),
    );
    const busHeights = new Set(
      layout.lines
        .filter(({ kind, points }) => kind === 'child' && points.length === 2 && points[0][1] === points[1][1])
        .map(({ points }) => points[0][1]),
    );
    expect(busHeights.size).toBe(2);
  });

  it('keeps the order of a row when someone is added elsewhere', () => {
    const order = (layout: ReturnType<typeof layoutFamily>, ids: string[]) =>
      layout.nodes
        .filter((node) => ids.includes(node.id))
        .toSorted((a, b) => a.x - b.x)
        .map(({ id }) => id);
    const before = layoutFamily(new FamilyGraph(members, links));
    const after = layoutFamily(
      new FamilyGraph([...members, member('bk3')], [...links, parent('b1', 'bk3'), parent('b2', 'bk3')]),
    );
    const children = ['ak1', 'ak2', 'bk1', 'bk2'];
    expect(order(after, children)).toEqual(order(before, children));
  });
});
