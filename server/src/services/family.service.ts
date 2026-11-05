import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  FamilyLinkDto,
  FamilyLinkType,
  FamilyMemberCreateDto,
  FamilyMemberRef,
  FamilyMemberUpdateDto,
  FamilyRelation,
  FamilyRelationCreateDto,
  FamilyTreeResponseDto,
} from 'src/dtos/family.dto.js';
import { FamilyLink, FamilyMember, FamilyRepository } from 'src/repositories/family.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';

class Tree {
  readonly members: Map<string, FamilyMember>;

  constructor(
    members: FamilyMember[],
    readonly links: FamilyLink[],
  ) {
    this.members = new Map(members.map((member) => [member.id, member]));
  }

  parentsOf(id: string) {
    return this.links
      .filter((link) => link.type === FamilyLinkType.Parent && link.toId === id)
      .map((link) => link.fromId);
  }

  childrenOf(id: string) {
    return this.links
      .filter((link) => link.type === FamilyLinkType.Parent && link.fromId === id)
      .map((link) => link.toId);
  }

  isAncestor(ancestorId: string, id: string): boolean {
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      for (const parentId of this.parentsOf(queue.shift()!)) {
        if (parentId === ancestorId) {
          return true;
        }
        if (seen.has(parentId)) {
          continue;
        }
        seen.add(parentId);
        queue.push(parentId);
      }
    }
    return false;
  }

  isPlaceholder(id: string) {
    return this.members.get(id)?.isPlaceholder ?? false;
  }
}

@Injectable()
export class FamilyService {
  constructor(
    private familyRepository: FamilyRepository,
    private personRepository: PersonRepository,
  ) {}

  async getTree(auth: AuthDto, memberId?: string): Promise<FamilyTreeResponseDto> {
    const tree = await this.load(auth.user.id);
    const partners = new Set<string>();
    const links = tree.links.filter((link) => {
      if (link.type !== FamilyLinkType.Partner) {
        return true;
      }
      // merging members can leave a partnership stored in both directions
      const key = [link.fromId, link.toId].sort().join(',');
      if (partners.has(key)) {
        return false;
      }
      partners.add(key);
      return true;
    });

    return {
      members: tree.members
        .values()
        .map(({ personGroupId, ...member }) => ({
          ...member,
          personId: personGroupId,
        }))
        .toArray(),
      links,
      memberId,
    };
  }

  async createMember(auth: AuthDto, { personId, name, gender }: FamilyMemberCreateDto) {
    const memberId = await this.resolve(auth, await this.load(auth.user.id), { personId, name });
    if (gender !== undefined) {
      await this.familyRepository.updateMember(auth.user.id, memberId, { gender });
    }
    return this.getTree(auth, memberId);
  }

  async updateMember(auth: AuthDto, id: string, { name, gender, personId, isMe }: FamilyMemberUpdateDto) {
    const ownerId = auth.user.id;
    const tree = await this.load(ownerId);
    const member = this.requireMember(tree, id);

    if (personId) {
      await this.requirePerson(auth, personId);
      const other = tree.members.values().find((item) => item.personGroupId === personId);
      if (other && other.id !== id) {
        // the person was already in the tree under another member: they are the same, so join them
        await this.familyRepository.updateMember(ownerId, other.id, { personGroupId: null });
        await this.familyRepository.mergeMember(ownerId, other.id, id);
      }
    }

    const named = (name !== undefined && name !== '') || !!personId;
    await this.familyRepository.updateMember(ownerId, id, {
      name,
      gender,
      personGroupId: personId,
      isPlaceholder: member.isPlaceholder && named ? false : undefined,
    });

    if (isMe) {
      await this.familyRepository.setMe(ownerId, id);
    } else if (isMe === false && member.isMe) {
      await this.familyRepository.setMe(ownerId, null);
    }

    return this.getTree(auth, id);
  }

  async deleteMember(auth: AuthDto, id: string) {
    const ownerId = auth.user.id;
    const tree = await this.load(ownerId);
    this.requireMember(tree, id);

    // unknown parents only exist to join siblings, so they go once they join fewer than two people
    const placeholders = tree
      .parentsOf(id)
      .filter((parentId) => tree.isPlaceholder(parentId) && tree.childrenOf(parentId).length <= 2);
    await this.familyRepository.deleteMembers(ownerId, [id, ...placeholders]);
    return this.getTree(auth);
  }

  async addRelation(auth: AuthDto, { member, relation, other, gender }: FamilyRelationCreateDto) {
    const ownerId = auth.user.id;
    let tree = await this.load(ownerId);
    const memberId = await this.resolve(auth, tree, member);
    tree = await this.load(ownerId);
    const otherId = await this.resolve(auth, tree, other);
    if (memberId === otherId) {
      throw new BadRequestException('A person cannot be related to themselves');
    }
    if (gender) {
      await this.familyRepository.updateMember(ownerId, memberId, { gender });
    }

    tree = await this.load(ownerId);
    switch (relation) {
      case FamilyRelation.Parent: {
        await this.addParent(ownerId, tree, memberId, otherId);
        break;
      }
      case FamilyRelation.Child: {
        await this.addParent(ownerId, tree, otherId, memberId);
        break;
      }
      case FamilyRelation.Sibling: {
        await this.addSibling(ownerId, tree, memberId, otherId);
        break;
      }
      case FamilyRelation.Partner: {
        const [fromId, toId] = [memberId, otherId].sort();
        await this.familyRepository.addLink(ownerId, { type: FamilyLinkType.Partner, fromId, toId });
        // children that only had one of the two as parent now have both
        await this.familyRepository.completeParents(ownerId, [
          ...tree.childrenOf(memberId),
          ...tree.childrenOf(otherId),
        ]);
        break;
      }
    }

    return this.getTree(auth, memberId);
  }

  async removeLink(auth: AuthDto, link: FamilyLinkDto) {
    await this.familyRepository.removeLink(auth.user.id, link);
    return this.getTree(auth);
  }

  private async addParent(ownerId: string, tree: Tree, parentId: string, childId: string) {
    const parents = tree.parentsOf(childId);
    if (parents.includes(parentId)) {
      return;
    }
    if (parentId === childId || tree.isAncestor(childId, parentId)) {
      throw new BadRequestException('This would make someone their own ancestor');
    }

    // an unknown parent that joined siblings turns out to be this person
    const placeholder = parents.find((id) => tree.isPlaceholder(id));
    if (placeholder) {
      await this.familyRepository.mergeMember(ownerId, placeholder, parentId);
      await this.familyRepository.linkCoParents(ownerId, tree.childrenOf(placeholder));
      return;
    }
    if (parents.length >= 2) {
      throw new BadRequestException('This person already has two parents');
    }
    await this.familyRepository.addLink(ownerId, { type: FamilyLinkType.Parent, fromId: parentId, toId: childId });
    // the child of one partner is the child of both by default, and two parents are partners by default
    await this.familyRepository.completeParents(ownerId, [childId]);
    await this.familyRepository.linkCoParents(ownerId, [childId]);
  }

  private async addSibling(ownerId: string, tree: Tree, aId: string, bId: string) {
    const parentsA = tree.parentsOf(aId);
    const parentsB = tree.parentsOf(bId);
    if (parentsA.some((id) => parentsB.includes(id))) {
      return;
    }

    if (parentsA.length === 0 && parentsB.length === 0) {
      // siblings share parents, so when nobody knows them yet, an unknown parent joins the two
      const parentId = await this.familyRepository.createMember(ownerId, { isPlaceholder: true });
      await this.familyRepository.addLink(ownerId, { type: FamilyLinkType.Parent, fromId: parentId, toId: aId });
      await this.familyRepository.addLink(ownerId, { type: FamilyLinkType.Parent, fromId: parentId, toId: bId });
      return;
    }

    for (const [childId, ownParents, otherParents] of [
      [aId, parentsA, parentsB],
      [bId, parentsB, parentsA],
    ] as const) {
      if (otherParents.some((id) => id === childId || tree.isAncestor(childId, id))) {
        throw new BadRequestException('This would make someone their own ancestor');
      }
      if (ownParents.length === 0) {
        for (const parentId of otherParents) {
          await this.familyRepository.addLink(ownerId, {
            type: FamilyLinkType.Parent,
            fromId: parentId,
            toId: childId,
          });
        }
        return;
      }
      if (ownParents.length === 1 && tree.isPlaceholder(ownParents[0])) {
        // the unknown parent of childId (and of its siblings) is otherParents[0];
        // the siblings that unknown parent joined get the second known parent too
        const [first, second] = otherParents;
        const siblings = tree.childrenOf(ownParents[0]);
        await this.familyRepository.mergeMember(ownerId, ownParents[0], first);
        if (second) {
          for (const siblingId of siblings) {
            if (!tree.isAncestor(siblingId, second) && tree.parentsOf(siblingId).length < 2) {
              await this.familyRepository.addLink(ownerId, {
                type: FamilyLinkType.Parent,
                fromId: second,
                toId: siblingId,
              });
            }
          }
          await this.familyRepository.linkCoParents(ownerId, siblings);
        }
        return;
      }
    }

    // one parent each: siblings share both
    const parents = [...new Set([...parentsA, ...parentsB])];
    if (parents.length > 2) {
      throw new BadRequestException('They already have different parents. Add the shared parent instead.');
    }
    for (const childId of [aId, bId]) {
      for (const parentId of parents) {
        await this.familyRepository.addLink(ownerId, { type: FamilyLinkType.Parent, fromId: parentId, toId: childId });
      }
    }
    await this.familyRepository.linkCoParents(ownerId, [aId, bId]);
  }

  /** finds or creates the member a reference points to */
  private async resolve(auth: AuthDto, tree: Tree, { memberId, personId, name }: FamilyMemberRef): Promise<string> {
    if (memberId) {
      return this.requireMember(tree, memberId).id;
    }
    if (personId) {
      const existing = tree.members.values().find((member) => member.personGroupId === personId);
      if (existing) {
        return existing.id;
      }
      const person = await this.requirePerson(auth, personId);
      return this.familyRepository.createMember(auth.user.id, { personGroupId: personId, name: person.name });
    }
    return this.familyRepository.createMember(auth.user.id, { name: name ?? '' });
  }

  private requireMember(tree: Tree, id: string) {
    const member = tree.members.get(id);
    if (!member) {
      throw new BadRequestException('Family member not found');
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

  private async load(ownerId: string) {
    const [members, links] = await Promise.all([
      this.familyRepository.getMembers(ownerId),
      this.familyRepository.getLinks(ownerId),
    ]);
    return new Tree(members, links);
  }
}
