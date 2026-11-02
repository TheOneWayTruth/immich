import type { Translations } from 'svelte-i18n';

export type FamilyGender = 'female' | 'male';
/** what `member` is to `other` */
export type FamilyRelation = 'parent' | 'child' | 'sibling' | 'partner';
export type FamilyLinkType = 'parent' | 'partner';

export type FamilyMember = {
  id: string;
  personId: string | null;
  name: string;
  gender: FamilyGender | null;
  birthDate: string | null;
  isPlaceholder: boolean;
  isMe: boolean;
};

/** parent links point from the parent to the child */
export type FamilyLink = { type: FamilyLinkType; fromId: string; toId: string };

export type FamilyTreeResponse = { members: FamilyMember[]; links: FamilyLink[]; memberId?: string };

export type FamilyMemberRef = { memberId?: string; personId?: string; name?: string };

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
  addMember: (body: { personId?: string; name?: string; gender?: FamilyGender | null }) =>
    api('/members', { method: 'POST', body }),
  updateMember: (
    id: string,
    body: { name?: string; gender?: FamilyGender | null; personId?: string | null; isMe?: boolean },
  ) => api(`/members/${id}`, { method: 'PATCH', body }),
  deleteMember: (id: string) => api(`/members/${id}`, { method: 'DELETE' }),
  addRelation: (body: {
    member: FamilyMemberRef;
    relation: FamilyRelation;
    other: FamilyMemberRef;
    gender?: FamilyGender;
  }) => api('/relations', { method: 'POST', body }),
  removeLink: (link: FamilyLink) => api('/relations/remove', { method: 'POST', body: link }),
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
  private readonly partners = new Map<string, string[]>();
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
    }
    for (const { type, fromId, toId } of links) {
      if (!this.members.has(fromId) || !this.members.has(toId)) {
        continue;
      }
      if (type === 'parent') {
        this.parents.get(toId)!.push(fromId);
        this.children.get(fromId)!.push(toId);
      } else {
        this.partners.get(fromId)!.push(toId);
        this.partners.get(toId)!.push(fromId);
      }
    }
  }

  get me() {
    for (const member of this.members.values()) {
      if (member.isMe) {
        return member;
      }
    }
  }

  parentsOf(id: string) {
    return this.parents.get(id) ?? [];
  }

  childrenOf(id: string) {
    return this.children.get(id) ?? [];
  }

  partnersOf(id: string) {
    return this.partners.get(id) ?? [];
  }

  siblingsOf(id: string) {
    const siblings = new Set<string>();
    for (const parentId of this.parentsOf(id)) {
      for (const childId of this.childrenOf(parentId)) {
        if (childId !== id) {
          siblings.add(childId);
        }
      }
    }
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
      for (const parentId of this.parentsOf(current)) {
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
      best.half = shared === 1 && parentsA.length === 2 && parentsB.length === 2;
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

    return this.isConnected(a, b) ? { key: 'family_rel_related', values: { gender } } : undefined;
  }

  private isConnected(a: string, b: string) {
    const seen = new Set([a]);
    const queue = [a];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of [...this.parentsOf(current), ...this.childrenOf(current), ...this.partnersOf(current)]) {
        if (next === b) {
          return true;
        }
        if (seen.has(next)) {
          continue;
        }

        seen.add(next);
        queue.push(next);
      }
    }
    return false;
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
export type FamilyLayoutLine = { points: Array<[number, number]>; kind: 'child' | 'partner' };
export type FamilyLayout = { nodes: FamilyLayoutNode[]; lines: FamilyLayoutLine[]; width: number; height: number };

export const FAMILY_CARD = { width: 132, height: 156, gapX: 28, gapY: 72 };

/**
 * Places members in rows by generation (parents above children, partners side by side) and draws
 * one line from every set of parents down to their children. Coordinates are card centers.
 */
export const layoutFamily = (graph: FamilyGraph): FamilyLayout => {
  const { width, height, gapX, gapY } = FAMILY_CARD;
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
        ...graph.parentsOf(id).map((other): [string, number] => [other, gen - 1]),
        ...graph.childrenOf(id).map((other): [string, number] => [other, gen + 1]),
        ...graph.partnersOf(id).map((other): [string, number] => [other, gen]),
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
  const rows: string[][] = [];
  for (const [id, gen] of generation) {
    (rows[gen - minGen] ??= []).push(id);
  }

  const x = new Map<string, number>();
  const placeRow = (row: string[], target: (id: string) => number | undefined) => {
    // partners stay next to each other: order whole couples, then lay them out left to right
    const units: string[][] = [];
    const seen = new Set<string>();
    for (const id of row) {
      if (seen.has(id)) {
        continue;
      }
      const unit = [id];
      seen.add(id);
      for (let index = 0; index < unit.length; index++) {
        for (const partner of graph.partnersOf(unit[index])) {
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
    for (const { unit, center } of wanted) {
      const unitSize = unitWidth(unit);
      let left = center === undefined ? cursor : center - unitSize / 2;
      if (left < cursor || !Number.isFinite(left)) {
        left = Number.isFinite(cursor) ? cursor : 0;
      }
      for (const [index, id] of unit.entries()) x.set(id, left + width / 2 + index * (width + gapX));
      cursor = left + unitSize + gapX * 1.5;
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
  let familyIndex = 0;
  for (const { parents, children } of families.values()) {
    const parentNodes = parents.map((id) => position.get(id)!);
    const bottom = Math.max(...parentNodes.map((node) => node.y)) + height / 2;
    const startX = parentNodes.reduce((sum, node) => sum + node.x, 0) / parentNodes.length;
    const startY = parentNodes.length === 2 && parentNodes[0].y === parentNodes[1].y ? parentNodes[0].y : bottom;
    const busY = bottom + gapY / 2 + ((familyIndex++ % 3) - 1) * 8;
    lines.push({
      kind: 'child',
      points: [
        [startX, startY],
        [startX, busY],
      ],
    });
    for (const childId of children) {
      const child = position.get(childId)!;
      lines.push({
        kind: 'child',
        points: [
          [startX, busY],
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
