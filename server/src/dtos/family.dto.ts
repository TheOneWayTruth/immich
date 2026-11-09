import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export enum FamilyGender {
  Female = 'female',
  Male = 'male',
}

/** what `member` is to `other` */
export enum FamilyRelation {
  Parent = 'parent',
  Child = 'child',
  Sibling = 'sibling',
  Partner = 'partner',
}

/**
 * only these links are stored, every other relationship is derived from them.
 * A sibling link only joins siblings that share no known parent.
 */
export enum FamilyLinkType {
  Parent = 'parent',
  Partner = 'partner',
  Sibling = 'sibling',
}

const FamilyGenderSchema = z.enum(FamilyGender).describe('Gender, used to pick words like aunt or uncle').meta({
  id: 'FamilyGender',
});
const FamilyRelationSchema = z.enum(FamilyRelation).meta({ id: 'FamilyRelation' });
const FamilyLinkTypeSchema = z.enum(FamilyLinkType).meta({ id: 'FamilyLinkType' });

const FamilyMemberCreateSchema = z
  .object({
    personId: z.uuidv4().describe('Person to add to the family tree'),
    gender: FamilyGenderSchema.nullable().optional(),
  })
  .meta({ id: 'FamilyMemberCreateDto' });

const FamilyMemberUpdateSchema = z
  .object({
    gender: FamilyGenderSchema.nullable(),
  })
  .meta({ id: 'FamilyMemberUpdateDto' });

const FamilyRelationCreateSchema = z
  .object({
    personId: z.uuidv4().describe('The person who is the relative, added to the tree if needed'),
    relation: FamilyRelationSchema.describe('What personId is to otherId'),
    otherId: z.uuidv4().describe('A person in the family tree'),
    gender: FamilyGenderSchema.optional().describe('Gender of personId, e.g. female for "mother"'),
    isStep: z.boolean().optional().describe('A stepparent or stepchild (parent and child only)'),
  })
  .meta({ id: 'FamilyRelationCreateDto' });

const FamilyStepUpdateSchema = z
  .object({
    parentId: z.uuidv4(),
    childId: z.uuidv4(),
    isStep: z.boolean().describe('true: parentId is a stepparent of childId; false: a parent by blood'),
  })
  .meta({ id: 'FamilyStepUpdateDto' });

const FamilyLinkSchema = z
  .object({
    type: FamilyLinkTypeSchema,
    fromId: z.uuidv4().describe('The parent, or one of the partners or siblings'),
    toId: z.uuidv4().describe('The child, or the other partner or sibling'),
  })
  .meta({ id: 'FamilyLinkDto' });

const FamilyTreeLinkSchema = FamilyLinkSchema.extend({
  isStep: z.boolean().describe('A stepparent (parent links only)'),
  inferred: z
    .boolean()
    .describe('Not stored: the only partner of the only parent by blood is taken as the second parent'),
}).meta({ id: 'FamilyTreeLinkDto' });

const FamilyMemberResponseSchema = z
  .object({
    id: z.string().describe('Person ID'),
    name: z.string(),
    gender: FamilyGenderSchema.nullable(),
    birthDate: z.string().nullable(),
  })
  .meta({ id: 'FamilyMemberResponseDto' });

const FamilyTreeResponseSchema = z
  .object({
    members: z.array(FamilyMemberResponseSchema),
    links: z.array(FamilyTreeLinkSchema),
    memberId: z.string().optional().describe('The member that was added or changed'),
  })
  .meta({ id: 'FamilyTreeResponseDto' });

export class FamilyMemberCreateDto extends createZodDto(FamilyMemberCreateSchema) {}
export class FamilyMemberUpdateDto extends createZodDto(FamilyMemberUpdateSchema) {}
export class FamilyRelationCreateDto extends createZodDto(FamilyRelationCreateSchema) {}
export class FamilyLinkDto extends createZodDto(FamilyLinkSchema) {}
export class FamilyStepUpdateDto extends createZodDto(FamilyStepUpdateSchema) {}
export class FamilyMemberResponseDto extends createZodDto(FamilyMemberResponseSchema) {}
export class FamilyTreeResponseDto extends createZodDto(FamilyTreeResponseSchema) {}
