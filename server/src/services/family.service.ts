import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  FamilyLinkDto,
  FamilyLinkType,
  FamilyMemberCreateDto,
  FamilyMemberUpdateDto,
  FamilyRelation,
  FamilyRelationCreateDto,
  FamilyStepUpdateDto,
  FamilyTreeResponseDto,
} from 'src/dtos/family.dto.js';
import { FamilyLink, FamilyMember, FamilyRepository } from 'src/repositories/family.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';

type TreeLink = FamilyLink & { inferred: boolean };

/**
 * The family tree as stored, plus what follows from it: a child with exactly one parent by blood whose parent has
 * exactly one partner has that partner as second parent, unless that partner is stored as their stepparent.
 */
class Tree {
  readonly members: Map<string, FamilyMember>;
  /** stored and inferred links */
  readonly links: TreeLink[];

  constructor(
    members: FamilyMember[],
    readonly stored: FamilyLink[],
  ) {
    this.members = new Map(members.map((member) => [member.id, member]));
    this.links = stored.map((link) => ({ ...link, inferred: false }));
    for (const childId of this.members.keys()) {
      const otherParent = this.inferredParentOf(childId);
      if (otherParent) {
        this.links.push({ type: FamilyLinkType.Parent, fromId: otherParent, toId: childId, isStep: false, inferred: true });
      }
    }
  }

  private inferredParentOf(childId: string) {
    const stated = this.statedParentsOf(childId);
    if (stated.length !== 1) {
      return;
    }
    const partners = this.partnersOf(stated[0]);
    if (partners.length !== 1) {
      return;
    }
    const [partnerId] = partners;
    const linked = this.stored.some(
      (link) => link.type === FamilyLinkType.Parent && link.fromId === partnerId && link.toId === childId,
    );
    if (partnerId === childId || linked || this.isAncestor(childId, partnerId, this.stored)) {
      return;
    }
    return partnerId;
  }

  has(id: string) {
    return this.members.has(id);
  }

  partnersOf(id: string) {
    return this.stored
      .filter((link) => link.type === FamilyLinkType.Partner && (link.fromId === id || link.toId === id))
      .map((link) => (link.fromId === id ? link.toId : link.fromId));
  }

  /** stored parents by blood */
  statedParentsOf(id: string) {
    return this.stored
      .filter((link) => link.type === FamilyLinkType.Parent && !link.isStep && link.toId === id)
      .map((link) => link.fromId);
  }

  /** parents by blood, stored or inferred */
  parentsOf(id: string) {
    return this.links
      .filter((link) => link.type === FamilyLinkType.Parent && !link.isStep && link.toId === id)
      .map((link) => link.fromId);
  }

  stepParentsOf(id: string) {
    return this.stored
      .filter((link) => link.type === FamilyLinkType.Parent && link.isStep && link.toId === id)
      .map((link) => link.fromId);
  }

  /** children by blood, stored or inferred */
  childrenOf(id: string) {
    return this.links
      .filter((link) => link.type === FamilyLinkType.Parent && !link.isStep && link.fromId === id)
      .map((link) => link.toId);
  }

  /** members joined by sibling links only, without a known shared parent */
  linkedSiblingsOf(id: string) {
    return this.stored
      .filter((link) => link.type === FamilyLinkType.Sibling && (link.fromId === id || link.toId === id))
      .map((link) => (link.fromId === id ? link.toId : link.fromId));
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

  /** whether ancestorId is above id through any parent link, by blood or step */
  isAncestor(ancestorId: string, id: string, links: FamilyLink[] = this.links): boolean {
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const link of links) {
        if (link.type !== FamilyLinkType.Parent || link.toId !== current) {
          continue;
        }
        if (link.fromId === ancestorId) {
          return true;
        }
        if (!seen.has(link.fromId)) {
          seen.add(link.fromId);
          queue.push(link.fromId);
        }
      }
    }
    return false;
  }
}

/** every pair of ids, each pair once */
const pairs = (ids: string[]) => ids.flatMap((a, index) => ids.slice(index + 1).map((b) => [a, b] as const));

@Injectable()
export class FamilyService {
  constructor(
    private familyRepository: FamilyRepository,
    private personRepository: PersonRepository,
  ) {}

  async getTree(auth: AuthDto, memberId?: string): Promise<FamilyTreeResponseDto> {
    const tree = await this.load(auth);
    return { members: [...tree.members.values()], links: tree.links, memberId };
  }

  async createMember(auth: AuthDto, { personId, gender }: FamilyMemberCreateDto) {
    await this.requirePerson(auth, personId);
    await this.familyRepository.addMember(personId, gender);
    return this.getTree(auth, personId);
  }

  async updateMember(auth: AuthDto, id: string, { gender }: FamilyMemberUpdateDto) {
    this.requireMember(await this.load(auth), id);
    await this.familyRepository.setGender(id, gender);
    return this.getTree(auth, id);
  }

  async deleteMember(auth: AuthDto, id: string) {
    const tree = await this.load(auth);
    this.requireMember(tree, id);

    // the children of this member stay siblings, and so do the siblings that were joined through them
    const children = tree.childrenOf(id);
    for (const [a, b] of pairs(children)) {
      const parentsB = tree.parentsOf(b);
      if (!tree.parentsOf(a).some((parentId) => parentId !== id && parentsB.includes(parentId))) {
        await this.familyRepository.addLink({ type: FamilyLinkType.Sibling, fromId: a, toId: b });
      }
    }
    for (const [a, b] of pairs(tree.linkedSiblingsOf(id))) {
      await this.familyRepository.addLink({ type: FamilyLinkType.Sibling, fromId: a, toId: b });
    }

    await this.familyRepository.deleteMember(id);
    return this.getTree(auth);
  }

  async addRelation(auth: AuthDto, { personId, relation, otherId, gender, isStep = false }: FamilyRelationCreateDto) {
    let tree = await this.load(auth);
    this.requireMember(tree, otherId);
    if (personId === otherId) {
      throw new BadRequestException('A person cannot be related to themselves');
    }
    if (!tree.has(personId)) {
      await this.requirePerson(auth, personId);
      await this.familyRepository.addMember(personId, gender);
    } else if (gender) {
      await this.familyRepository.setGender(personId, gender);
    }

    tree = await this.load(auth);
    switch (relation) {
      case FamilyRelation.Parent: {
        await this.addParent(tree, personId, otherId, isStep);
        break;
      }
      case FamilyRelation.Child: {
        await this.addParent(tree, otherId, personId, isStep);
        break;
      }
      case FamilyRelation.Sibling: {
        await this.addSibling(tree, personId, otherId);
        break;
      }
      case FamilyRelation.Partner: {
        await this.familyRepository.addLink({ type: FamilyLinkType.Partner, fromId: personId, toId: otherId });
        break;
      }
    }

    return this.getTree(auth, personId);
  }

  async setStep(auth: AuthDto, { parentId, childId, isStep }: FamilyStepUpdateDto) {
    const tree = await this.load(auth);
    this.requireMember(tree, parentId);
    this.requireMember(tree, childId);
    const isParent = tree.parentsOf(childId).includes(parentId);
    const isStepParent = tree.stepParentsOf(childId).includes(parentId);
    if (!isParent && !isStepParent) {
      throw new BadRequestException('Not a parent of this person');
    }

    if (isStep && isParent) {
      await this.familyRepository.addLink({ type: FamilyLinkType.Parent, fromId: parentId, toId: childId, isStep });
    } else if (!isStep && isStepParent) {
      // only what cannot be inferred is stored: without the step link, the only partner of the only parent follows
      const stated = tree.statedParentsOf(childId);
      if (stated.length === 1 && tree.partnersOf(stated[0]).length === 1 && tree.partnersOf(stated[0])[0] === parentId) {
        await this.familyRepository.removeLink({ type: FamilyLinkType.Parent, fromId: parentId, toId: childId });
      } else if (stated.length >= 2) {
        throw new BadRequestException('This person already has two parents');
      } else {
        await this.familyRepository.addLink({ type: FamilyLinkType.Parent, fromId: parentId, toId: childId });
      }
    }

    return this.getTree(auth, childId);
  }

  async removeLink(auth: AuthDto, link: FamilyLinkDto) {
    await this.familyRepository.removeLink(link);
    return this.getTree(auth);
  }

  private async addParent(tree: Tree, parentId: string, childId: string, isStep: boolean) {
    if (tree.isAncestor(childId, parentId)) {
      throw new BadRequestException('This would make someone their own ancestor');
    }
    if (isStep) {
      if (!tree.stepParentsOf(childId).includes(parentId)) {
        await this.familyRepository.addLink({ type: FamilyLinkType.Parent, fromId: parentId, toId: childId, isStep });
      }
      return;
    }

    if (tree.parentsOf(childId).includes(parentId)) {
      return;
    }
    if (tree.statedParentsOf(childId).length >= 2) {
      throw new BadRequestException('This person already has two parents');
    }

    // siblings without a known parent get this parent too
    const children = tree
      .siblingGroup(childId)
      .filter(
        (id) =>
          id === childId ||
          (id !== parentId && tree.statedParentsOf(id).length < 2 && !tree.isAncestor(id, parentId)),
      );
    await this.giveParents(tree, children, [parentId]);
  }

  private async addSibling(tree: Tree, aId: string, bId: string) {
    const parentsA = tree.parentsOf(aId);
    const parentsB = tree.parentsOf(bId);
    if (parentsA.some((id) => parentsB.includes(id))) {
      return;
    }

    if (parentsA.length === 0 && parentsB.length === 0) {
      // nobody knows their parents yet, so they are joined directly
      await this.familyRepository.addLink({ type: FamilyLinkType.Sibling, fromId: aId, toId: bId });
      return;
    }

    for (const [childId, ownParents, otherId] of [
      [aId, parentsA, bId],
      [bId, parentsB, aId],
    ] as const) {
      if (ownParents.length === 0) {
        // the stated parents of one are the parents of the other, and of everyone joined to them as siblings;
        // a second parent that is inferred for one follows for the other the same way
        await this.giveParents(tree, tree.siblingGroup(childId), tree.statedParentsOf(otherId));
        return;
      }
    }

    // one parent each: siblings share both
    const parents = [...new Set([...tree.statedParentsOf(aId), ...tree.statedParentsOf(bId)])];
    if (parents.length > 2) {
      throw new BadRequestException('They already have different parents. Add the shared parent instead.');
    }
    await this.giveParents(tree, [aId, bId], parents);
  }

  /**
   * adds the parents by blood to the children, and drops sibling links that a shared parent now makes unnecessary;
   * returns the children that got them
   */
  private async giveParents(tree: Tree, childIds: string[], parentIds: readonly string[]) {
    for (const childId of childIds) {
      for (const parentId of parentIds) {
        if (parentId === childId || tree.isAncestor(childId, parentId)) {
          throw new BadRequestException('This would make someone their own ancestor');
        }
      }
    }
    const given: string[] = [];
    for (const childId of childIds) {
      const current = tree.statedParentsOf(childId);
      const missing = parentIds.filter((parentId) => !current.includes(parentId));
      if (current.length + missing.length > 2) {
        // a sibling with other known parents keeps them
        continue;
      }
      for (const parentId of missing) {
        await this.familyRepository.addLink({ type: FamilyLinkType.Parent, fromId: parentId, toId: childId });
      }
      given.push(childId);
    }
    for (const [a, b] of pairs(given)) {
      if (tree.linkedSiblingsOf(a).includes(b)) {
        await this.familyRepository.removeLink({ type: FamilyLinkType.Sibling, fromId: a, toId: b });
      }
    }
    return given;
  }

  private requireMember(tree: Tree, id: string) {
    const member = tree.members.get(id);
    if (!member) {
      throw new BadRequestException('Not in the family tree');
    }
    return member;
  }

  private async requirePerson(auth: AuthDto, personId: string) {
    const [person] = await this.personRepository.getByGroupIds(auth.user.id, [personId]);
    if (!person) {
      throw new BadRequestException('Person not found');
    }
    return person;
  }

  private async load(auth: AuthDto) {
    const [members, links] = await Promise.all([
      this.familyRepository.getMembers(auth.user.id),
      this.familyRepository.getLinks(),
    ]);
    return new Tree(members, links);
  }
}
