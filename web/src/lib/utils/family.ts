import type { Translations } from 'svelte-i18n';

export type FamilyGender = 'female' | 'male';
/** what `member` is to `other` */
export type FamilyRelation = 'parent' | 'child' | 'sibling' | 'partner';
/** a sibling link only joins siblings that share no known parent */
export type FamilyLinkType = 'parent' | 'partner' | 'sibling';

/** every member is a person; the id is the person id */
export type FamilyMember = {
  id: string;
  name: string;
  gender: FamilyGender | null;
  birthDate: string | null;
};

/**
 * parent links point from the parent to the child. isStep marks a stepparent; inferred links are not stored:
 * the only partner of a child's only parent by blood is taken as the second parent
 */
export type FamilyLink = { type: FamilyLinkType; fromId: string; toId: string; isStep?: boolean; inferred?: boolean };

export type FamilyTreeResponse = { members: FamilyMember[]; links: FamilyLink[]; memberId?: string };

const api = async (path: string, init?: { method: string; body?: unknown }): Promise<FamilyTreeResponse> => {
  const response = await fetch(`/api/family${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message ?? response.statusText);
  }
  return response.json();
};

export const familyApi = {
  get: () => api(''),
  addMember: (body: { personId: string; gender?: FamilyGender | null }) => api('/members', { method: 'POST', body }),
  setGender: (id: string, gender: FamilyGender | null) => api(`/members/${id}`, { method: 'PATCH', body: { gender } }),
  deleteMember: (id: string) => api(`/members/${id}`, { method: 'DELETE' }),
  /** personId is the relative (added to the tree if needed), otherId someone in the tree */
  addRelation: (body: {
    personId: string;
    relation: FamilyRelation;
    otherId: string;
    gender?: FamilyGender;
    isStep?: boolean;
  }) => api('/relations', { method: 'POST', body }),
  setStep: (body: { parentId: string; childId: string; isStep: boolean }) =>
    api('/relations/step', { method: 'POST', body }),
  removeLink: ({ type, fromId, toId }: FamilyLink) =>
    api('/relations/remove', { method: 'POST', body: { type, fromId, toId } }),
};

/**
 * What one member is to another, as an i18n key and its values, e.g. `family_rel_aunt` with
 * `{ gender: 'female' }` for "aunt". Gender is always the gender of the member being described.
 */
export type FamilyRelationLabel = {
  key: Translations;
  values: { gender: string; greats?: number; degree?: number; removed?: number };
};

type Blood = { up: number; down: number; half: boolean };

export class FamilyGraph {
  readonly members = new Map<string, FamilyMember>();
  private readonly parents = new Map<string, string[]>();
  private readonly children = new Map<string, string[]>();
  private readonly stepParents = new Map<string, string[]>();
  private readonly stepChildren = new Map<string, string[]>();
  private readonly partners = new Map<string, string[]>();
  private readonly linkedSiblings = new Map<string, string[]>();
  /**
   * parents for working out blood relations: siblings joined by a sibling link share an unknown parent,
   * which only exists here (a key that is no member id), so their children are cousins and so on
   */
  private readonly bloodParents = new Map<string, string[]>();
  private readonly ancestorCache = new Map<string, Map<string, number>>();

  constructor(
    members: FamilyMember[],
    readonly links: FamilyLink[],
  ) {
    for (const member of members) {
      this.members.set(member.id, member);
      this.parents.set(member.id, []);
      this.children.set(member.id, []);
      this.partners.set(member.id, []);
      this.linkedSiblings.set(member.id, []);
      this.stepParents.set(member.id, []);
      this.stepChildren.set(member.id, []);
    }
    for (const { type, fromId, toId, isStep } of links) {
      if (!this.members.has(fromId) || !this.members.has(toId)) {
        continue;
      }
      if (type === 'parent' && isStep) {
        this.stepParents.get(toId)!.push(fromId);
        this.stepChildren.get(fromId)!.push(toId);
      } else if (type === 'parent') {
        this.parents.get(toId)!.push(fromId);
        this.children.get(fromId)!.push(toId);
      } else {
        const map = type === 'partner' ? this.partners : this.linkedSiblings;
        map.get(fromId)!.push(toId);
        map.get(toId)!.push(fromId);
      }
    }
    for (const id of this.members.keys()) {
      const group = this.siblingGroup(id);
      const unknownParent = group.length > 1 ? [`siblings:${group.sort()[0]}`] : [];
      this.bloodParents.set(id, [...this.parentsOf(id), ...unknownParent]);
    }
  }

  /** parents by blood */
  parentsOf(id: string) {
    return this.parents.get(id) ?? [];
  }

  /** children by blood */
  childrenOf(id: string) {
    return this.children.get(id) ?? [];
  }

  stepParentsOf(id: string) {
    return this.stepParents.get(id) ?? [];
  }

  stepChildrenOf(id: string) {
    return this.stepChildren.get(id) ?? [];
  }

  /** the stored or inferred parent link between the two, if any */
  parentLink(parentId: string, childId: string) {
    return this.links.find((link) => link.type === 'parent' && link.fromId === parentId && link.toId === childId);
  }

  partnersOf(id: string) {
    return this.partners.get(id) ?? [];
  }

  /** the other parents of this member's children, partners or not */
  coParentsOf(id: string) {
    const coParents = new Set<string>();
    for (const childId of this.childrenOf(id)) {
      for (const parentId of this.parentsOf(childId)) {
        if (parentId !== id) {
          coParents.add(parentId);
        }
      }
    }
    return [...coParents];
  }

  /** siblings joined directly by a sibling link */
  linkedSiblingsOf(id: string) {
    return this.linkedSiblings.get(id) ?? [];
  }

  /** the member and everyone joined to them by sibling links, directly or through others */
  siblingGroup(id: string) {
    const group = new Set([id]);
    const queue = [id];
    while (queue.length > 0) {
      for (const other of this.linkedSiblingsOf(queue.shift()!)) {
        if (!group.has(other)) {
          group.add(other);
          queue.push(other);
        }
      }
    }
    return [...group];
  }

  /** everyone with a shared parent or joined by sibling links */
  siblingsOf(id: string) {
    const siblings = new Set<string>(this.siblingGroup(id));
    for (const parentId of this.parentsOf(id)) {
      for (const childId of this.childrenOf(parentId)) {
        siblings.add(childId);
      }
    }
    siblings.delete(id);
    return [...siblings];
  }

  /** every ancestor with the number of generations up to them, the member itself at 0 */
  private ancestors(id: string) {
    let result = this.ancestorCache.get(id);
    if (result) {
      return result;
    }
    result = new Map([[id, 0]]);
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const depth = result.get(current)! + 1;
      for (const parentId of this.bloodParents.get(current) ?? []) {
        if (result.has(parentId)) {
          continue;
        }

        result.set(parentId, depth);
        queue.push(parentId);
      }
    }
    this.ancestorCache.set(id, result);
    return result;
  }

  /** how a and b are related by blood: generations from a and from b up to their closest common ancestor */
  private blood(a: string, b: string): Blood | undefined {
    const ancestorsA = this.ancestors(a);
    const ancestorsB = this.ancestors(b);
    let best: Blood | undefined;
    for (const [id, up] of ancestorsA) {
      const down = ancestorsB.get(id);
      if (down !== undefined && (!best || up + down < best.up + best.down)) {
        best = { up, down, half: false };
      }
    }
    if (best?.up === 1 && best.down === 1) {
      const parentsA = this.parentsOf(a);
      const parentsB = this.parentsOf(b);
      const shared = parentsA.filter((id) => parentsB.includes(id)).length;
      // the other parent differs: both are known, or one's parent is only the other's stepparent
      const stepOfOther =
        parentsA.some((id) => this.stepParentsOf(b).includes(id)) ||
        parentsB.some((id) => this.stepParentsOf(a).includes(id));
      best.half = shared === 1 && ((parentsA.length === 2 && parentsB.length === 2) || stepOfOther);
    }
    return best;
  }

  private bloodLabel({ up, down, half }: Blood, gender: string): FamilyRelationLabel | undefined {
    if (up === 0 && down === 0) {
      return;
    }
    if (up === 0) {
      return down === 1
        ? { key: 'family_rel_parent', values: { gender } }
        : { key: 'family_rel_grandparent', values: { gender, greats: down - 2 } };
    }
    if (down === 0) {
      return up === 1
        ? { key: 'family_rel_child', values: { gender } }
        : { key: 'family_rel_grandchild', values: { gender, greats: up - 2 } };
    }
    if (up === 1 && down === 1) {
      return { key: half ? 'family_rel_half_sibling' : 'family_rel_sibling', values: { gender } };
    }
    if (up === 1) {
      return { key: 'family_rel_aunt', values: { gender, greats: down - 2 } };
    }
    if (down === 1) {
      return { key: 'family_rel_niece', values: { gender, greats: up - 2 } };
    }
    return {
      key: 'family_rel_cousin',
      values: { gender, degree: Math.min(up, down) - 1, removed: Math.abs(up - down) },
    };
  }

  /** what a is to b, e.g. "aunt"; undefined when they are not connected */
  relation(a: string, b: string): FamilyRelationLabel | undefined {
    if (a === b || !this.members.has(a) || !this.members.has(b)) {
      return;
    }
    const gender = this.members.get(a)!.gender ?? 'other';

    const blood = this.blood(a, b);
    if (blood) {
      return this.bloodLabel(blood, gender);
    }

    if (this.stepParentsOf(b).includes(a)) {
      return { key: 'family_rel_step_parent', values: { gender } };
    }
    if (this.stepParentsOf(a).includes(b)) {
      return { key: 'family_rel_step_child', values: { gender } };
    }

    if (this.partnersOf(a).includes(b)) {
      return { key: 'family_rel_partner', values: { gender } };
    }

    // a is related by blood to b's partner
    for (const partnerId of this.partnersOf(b)) {
      const viaPartner = this.blood(a, partnerId);
      if (!viaPartner) {
        continue;
      }
      const { up, down } = viaPartner;
      if (up === 0 && down === 1) {
        return { key: 'family_rel_parent_in_law', values: { gender } };
      }
      if (up === 1 && down === 1) {
        return { key: 'family_rel_sibling_in_law', values: { gender } };
      }
      if (up === 1 && down === 0) {
        return { key: 'family_rel_step_child', values: { gender } };
      }
    }

    // a is the partner of someone related by blood to b
    for (const partnerId of this.partnersOf(a)) {
      const viaPartner = this.blood(partnerId, b);
      if (!viaPartner) {
        continue;
      }
      const { up, down } = viaPartner;
      if (up === 0 && down === 1) {
        return { key: 'family_rel_step_parent', values: { gender } };
      }
      if (up === 1 && down === 1) {
        return { key: 'family_rel_sibling_in_law', values: { gender } };
      }
      if (up === 1 && down === 0) {
        return { key: 'family_rel_child_in_law', values: { gender } };
      }
      if (down >= 2 && up <= 1) {
        // the partner of a grandparent or an aunt is called the same
        return this.bloodLabel(viaPartner, gender);
      }
    }

    // children of two partners that do not share a parent, or of a parent and a stepparent
    const parentsA = [...this.parentsOf(a), ...this.stepParentsOf(a)];
    const parentsB = [...this.parentsOf(b), ...this.stepParentsOf(b)];
    for (const parentA of parentsA) {
      for (const parentB of parentsB) {
        if (parentA === parentB || this.partnersOf(parentA).includes(parentB)) {
          return { key: 'family_rel_step_sibling', values: { gender } };
        }
      }
    }

    // partners of two siblings
    for (const partnerA of this.partnersOf(a)) {
      for (const partnerB of this.partnersOf(b)) {
        const viaPartners = this.blood(partnerA, partnerB);
        if (viaPartners?.up === 1 && viaPartners.down === 1) {
          return { key: 'family_rel_co_sibling_in_law', values: { gender } };
        }
      }
    }

    // further relationships have no word of their own, so they get no label
    return undefined;
  }

  /** the closest named relative of a nameless member and how they are related, e.g. "father of" Lisa */
  describe(id: string): { relation: FamilyRelationLabel; of: FamilyMember[] } | undefined {
    const member = this.members.get(id);
    if (!member) {
      return;
    }
    const gender = member.gender ?? 'other';
    const named = (ids: string[]) => ids.map((other) => this.members.get(other)!).filter((other) => other.name);
    const options: Array<[Translations, FamilyMember[]]> = [
      ['family_rel_parent', named(this.childrenOf(id))],
      ['family_rel_child', named(this.parentsOf(id))],
      ['family_rel_partner', named(this.partnersOf(id))],
      ['family_rel_sibling', named(this.siblingsOf(id))],
    ];
    const option = options.find(([, of]) => of.length > 0);
    return option ? { relation: { key: option[0], values: { gender } }, of: option[1] } : undefined;
  }
}

export type FamilyLayoutNode = { id: string; x: number; y: number };
export type FamilyLayoutLine = { points: Array<[number, number]>; kind: 'child' | 'partner' | 'sibling' | 'step' };
export type FamilyLayout = { nodes: FamilyLayoutNode[]; lines: FamilyLayoutLine[]; width: number; height: number };

/** gapX is between members of one family, familyGap between different families */
export const FAMILY_CARD = { width: 132, height: 156, gapX: 28, gapY: 84, familyGap: 112 };

/**
 * Places members in rows by generation (parents above children, partners side by side) and draws
 * one line from every set of parents down to their children. Coordinates are card centers.
 */
export const layoutFamily = (graph: FamilyGraph): FamilyLayout => {
  const { width, height, gapX, gapY, familyGap } = FAMILY_CARD;
  const generation = new Map<string, number>();

  // generations per connected group, starting from its oldest-known member
  for (const start of graph.members.keys()) {
    if (generation.has(start)) {
      continue;
    }
    generation.set(start, 0);
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const gen = generation.get(id)!;
      const next: Array<[string, number]> = [
        ...[...graph.parentsOf(id), ...graph.stepParentsOf(id)].map((other): [string, number] => [other, gen - 1]),
        ...[...graph.childrenOf(id), ...graph.stepChildrenOf(id)].map((other): [string, number] => [other, gen + 1]),
        ...graph.partnersOf(id).map((other): [string, number] => [other, gen]),
        ...graph.linkedSiblingsOf(id).map((other): [string, number] => [other, gen]),
      ];
      for (const [other, otherGen] of next) {
        if (generation.has(other)) {
          continue;
        }

        generation.set(other, otherGen);
        queue.push(other);
      }
    }
  }

  // a child must sit below all of its parents
  for (let pass = 0; pass < graph.members.size; pass++) {
    let changed = false;
    for (const link of graph.links) {
      if (link.type !== 'parent' || !generation.has(link.fromId) || !generation.has(link.toId)) {
        continue;
      }
      if (!(generation.get(link.toId)! <= generation.get(link.fromId)!)) {
        continue;
      }

      generation.set(link.toId, generation.get(link.fromId)! + 1);
      changed = true;
    }
    if (!changed) {
      break;
    }
  }

  const minGen = Math.min(...generation.values());
  // rows start in the order members were added, so adding someone moves as little as possible
  const rows: string[][] = [];
  for (const id of graph.members.keys()) {
    (rows[generation.get(id)! - minGen] ??= []).push(id);
  }
  for (let index = 0; index < rows.length; index++) {
    rows[index] ??= [];
  }

  /** members with the same parents (or the same partner's parents, or joined as siblings) belong to one family */
  const familyOf = (unit: string[]) => {
    const withParents = unit.find((id) => graph.parentsOf(id).length > 0);
    if (withParents) {
      return [...graph.parentsOf(withParents)].sort().join(',');
    }
    const withSiblings = unit.find((id) => graph.linkedSiblingsOf(id).length > 0);
    return withSiblings ? `siblings:${graph.siblingGroup(withSiblings).sort()[0]}` : `own:${unit[0]}`;
  };

  const x = new Map<string, number>();
  const placeRow = (row: string[], target: (id: string) => number | undefined) => {
    // partners and parents of the same children stay next to each other: order whole couples, then lay them out left to right
    const units: string[][] = [];
    const seen = new Set<string>();
    for (const id of row) {
      if (seen.has(id)) {
        continue;
      }
      const unit = [id];
      seen.add(id);
      for (let index = 0; index < unit.length; index++) {
        for (const partner of [...graph.partnersOf(unit[index]), ...graph.coParentsOf(unit[index])]) {
          if (seen.has(partner) || !row.includes(partner)) {
            continue;
          }

          seen.add(partner);
          unit.push(partner);
        }
      }
      units.push(unit);
    }

    const unitWidth = (unit: string[]) => unit.length * (width + gapX) - gapX;
    const wanted = units.map((unit, index) => {
      const targets = unit.map((id) => target(id)).filter((value) => value !== undefined);
      const center = targets.length > 0 ? targets.reduce((sum, value) => sum + value, 0) / targets.length : undefined;
      return { unit, center, index };
    });
    wanted.sort((a, b) => (a.center ?? Infinity) - (b.center ?? Infinity) || a.index - b.index);

    row.length = 0;
    let cursor = -Infinity;
    let previousFamily: string | undefined;
    for (const { unit, center } of wanted) {
      const unitSize = unitWidth(unit);
      const family = familyOf(unit);
      // siblings stay close together, different families get room between them
      const minimumLeft = Number.isFinite(cursor) ? cursor + (family === previousFamily ? gapX : familyGap) : -Infinity;
      let left = center === undefined ? minimumLeft : center - unitSize / 2;
      if (left < minimumLeft || !Number.isFinite(left)) {
        left = Number.isFinite(minimumLeft) ? minimumLeft : 0;
      }
      for (const [index, id] of unit.entries()) {
        x.set(id, left + width / 2 + index * (width + gapX));
      }
      cursor = left + unitSize;
      previousFamily = family;
      row.push(...unit);
    }
  };

  const average = (ids: string[]) => {
    const values = ids.map((id) => x.get(id)).filter((value) => value !== undefined);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
  };

  for (const row of rows) {
    placeRow(row, () => undefined);
  }
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const row of rows.slice(1)) {
      placeRow(row, (id) => average(graph.parentsOf(id)) ?? x.get(id));
    }
    for (const row of rows) {
      placeRow(row, (id) => (graph.parentsOf(id).length > 0 ? x.get(id) : (average(graph.siblingGroup(id)) ?? x.get(id))));
    }
    for (const row of rows.slice(0, -1).reverse()) {
      placeRow(row, (id) => average(graph.childrenOf(id)) ?? x.get(id));
    }
  }
  for (const row of rows.slice(1)) {
    placeRow(row, (id) => average(graph.parentsOf(id)) ?? x.get(id));
  }

  const minX = Math.min(...x.values()) - width / 2;
  const nodes = rows.flatMap((row, rowIndex) =>
    row.map((id) => ({ id, x: x.get(id)! - minX, y: rowIndex * (height + gapY) + height / 2 })),
  );
  const position = new Map(nodes.map((node) => [node.id, node]));

  const lines: FamilyLayoutLine[] = [];
  for (const link of graph.links) {
    const from = position.get(link.fromId);
    const to = position.get(link.toId);
    if (link.type !== 'partner' || !from || !to || from.y !== to.y) {
      continue;
    }
    const [left, right] = from.x < to.x ? [from, to] : [to, from];
    lines.push({
      kind: 'partner',
      points: [
        [left.x + width / 2, left.y],
        [right.x - width / 2, right.y],
      ],
    });
  }

  const families = new Map<string, { parents: string[]; children: string[] }>();
  for (const id of graph.members.keys()) {
    const parents = [...graph.parentsOf(id)].sort();
    if (parents.length === 0) {
      continue;
    }
    const key = parents.join(',');
    const family = families.get(key) ?? { parents, children: [] };
    family.children.push(id);
    families.set(key, family);
  }
  // a stepparent gets a dashed line of their own down to the stepchild
  for (const link of graph.links) {
    const from = position.get(link.fromId);
    const to = position.get(link.toId);
    if (link.type !== 'parent' || !link.isStep || !from || !to) {
      continue;
    }
    const bottom = from.y + height / 2;
    const midY = bottom + gapY / 2 + 8;
    lines.push({
      kind: 'step',
      points: [
        [from.x, bottom],
        [from.x, midY],
        [to.x, midY],
        [to.x, to.y - height / 2],
      ],
    });
  }

  // siblings without a known parent get a line above them that joins them
  const siblingBrackets = new Map<string, string[]>();
  for (const id of graph.members.keys()) {
    const group = graph.siblingGroup(id);
    if (group.length > 1) {
      siblingBrackets.set(group.sort()[0], group);
    }
  }
  for (const group of siblingBrackets.values()) {
    const groupNodes = group.map((id) => position.get(id)!);
    const top = Math.min(...groupNodes.map((node) => node.y)) - height / 2;
    const busY = top - gapY / 3;
    const xs = groupNodes.map((node) => node.x);
    lines.push({
      kind: 'sibling',
      points: [
        [Math.min(...xs), busY],
        [Math.max(...xs), busY],
      ],
    });
    for (const node of groupNodes) {
      lines.push({
        kind: 'sibling',
        points: [
          [node.x, busY],
          [node.x, node.y - height / 2],
        ],
      });
    }
  }

  // families whose lines would overlap get their horizontal line at different heights
  const LEVELS = [0, -16, 16, -32, 32];
  const levelEnds = new Map<number, number[]>();
  const familyLines = [...families.values()]
    .map(({ parents, children }) => {
      const parentNodes = parents.map((id) => position.get(id)!);
      const childNodes = children.map((id) => position.get(id)!);
      const xs = [...parentNodes, ...childNodes].map((node) => node.x);
      return { parents, parentNodes, childNodes, minX: Math.min(...xs), maxX: Math.max(...xs) };
    })
    .sort((a, b) => a.minX - b.minX);
  for (const { parents, parentNodes, childNodes, minX, maxX } of familyLines) {
    const bottom = Math.max(...parentNodes.map((node) => node.y)) + height / 2;
    const ends = levelEnds.get(bottom) ?? LEVELS.map(() => -Infinity);
    levelEnds.set(bottom, ends);
    let level = ends.findIndex((end) => end + gapX / 2 < minX);
    if (level === -1) {
      level = ends.indexOf(Math.min(...ends));
    }
    ends[level] = maxX;
    const busY = bottom + gapY / 2 + LEVELS[level];

    // a couple side by side gets one line from between them; otherwise every parent gets their own
    const [a, b] = parentNodes;
    const couple =
      parentNodes.length === 2 &&
      graph.partnersOf(parents[0]).includes(parents[1]) &&
      a.y === b.y &&
      Math.abs(a.x - b.x) <= width + gapX;
    const drops: Array<[number, number]> = couple
      ? [[(a.x + b.x) / 2, a.y]]
      : parentNodes.map((node): [number, number] => [node.x, node.y + height / 2]);
    for (const [x, y] of drops) {
      lines.push({
        kind: 'child',
        points: [
          [x, y],
          [x, busY],
        ],
      });
    }

    const busXs = [...drops.map(([x]) => x), ...childNodes.map((node) => node.x)];
    lines.push({
      kind: 'child',
      points: [
        [Math.min(...busXs), busY],
        [Math.max(...busXs), busY],
      ],
    });
    for (const child of childNodes) {
      lines.push({
        kind: 'child',
        points: [
          [child.x, busY],
          [child.x, child.y - height / 2],
        ],
      });
    }
  }

  return {
    nodes,
    lines,
    width: Math.max(...nodes.map((node) => node.x), 0) + width / 2,
    height: rows.length * (height + gapY) - gapY,
  };
};
