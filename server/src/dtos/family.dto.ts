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

/** only these two links are stored, every other relationship is derived from them */
export enum FamilyLinkType {
  Parent = 'parent',
  Partner = 'partner',
}

const FamilyGenderSchema = z.enum(FamilyGender).describe('Gender, used to pick words like aunt or uncle').meta({
  id: 'FamilyGender',
});
const FamilyRelationSchema = z.enum(FamilyRelation).meta({ id: 'FamilyRelation' });
const FamilyLinkTypeSchema = z.enum(FamilyLinkType).meta({ id: 'FamilyLinkType' });

const FamilyMemberRefSchema = z
  .object({
    memberId: z.uuidv4().optional().describe('Existing family member'),
    personId: z.uuidv4().optional().describe('Person to add to the family tree (or find in it)'),
    name: z.string().trim().max(200).optional().describe('Name of a new family member that has no person'),
  })
  .describe('A family member, a person, or a new member. An empty object adds an unknown member.')
  .meta({ id: 'FamilyMemberRefDto' });

const FamilyMemberCreateSchema = z
  .object({
    personId: z.uuidv4().optional().describe('Person to add to the family tree'),
    name: z.string().trim().max(200).optional().describe('Name of a family member that has no person'),
    gender: FamilyGenderSchema.nullable().optional(),
  })
  .meta({ id: 'FamilyMemberCreateDto' });

const FamilyMemberUpdateSchema = z
  .object({
    name: z.string().trim().max(200).optional().describe('Name, used when the member has no person'),
    gender: FamilyGenderSchema.nullable().optional(),
    personId: z.uuidv4().nullable().optional().describe('Link the member to a person, or null to unlink'),
    isMe: z.boolean().optional().describe('Relationships are shown from the point of view of this member'),
  })
  .meta({ id: 'FamilyMemberUpdateDto' });

const FamilyRelationCreateSchema = z
  .object({
    member: FamilyMemberRefSchema,
    relation: FamilyRelationSchema.describe('What member is to other'),
    other: FamilyMemberRefSchema,
    gender: FamilyGenderSchema.optional().describe('Gender of member, e.g. female for "mother"'),
  })
  .meta({ id: 'FamilyRelationCreateDto' });

const FamilyLinkSchema = z
  .object({
    type: FamilyLinkTypeSchema,
    fromId: z.uuidv4().describe('The parent, or one of the partners'),
    toId: z.uuidv4().describe('The child, or the other partner'),
  })
  .meta({ id: 'FamilyLinkDto' });

const FamilyMemberResponseSchema = z
  .object({
    id: z.string(),
    personId: z.string().nullable().describe('Linked person, null when the member has no photos'),
    name: z.string(),
    gender: FamilyGenderSchema.nullable(),
    birthDate: z.string().nullable(),
    isPlaceholder: z.boolean().describe('Added automatically for an unknown shared parent'),
    isMe: z.boolean(),
  })
  .meta({ id: 'FamilyMemberResponseDto' });

const FamilyTreeResponseSchema = z
  .object({
    members: z.array(FamilyMemberResponseSchema),
    links: z.array(FamilyLinkSchema),
    memberId: z.string().optional().describe('The member that was created or changed'),
  })
  .meta({ id: 'FamilyTreeResponseDto' });

export class FamilyMemberCreateDto extends createZodDto(FamilyMemberCreateSchema) {}
export class FamilyMemberUpdateDto extends createZodDto(FamilyMemberUpdateSchema) {}
export class FamilyRelationCreateDto extends createZodDto(FamilyRelationCreateSchema) {}
export class FamilyLinkDto extends createZodDto(FamilyLinkSchema) {}
export class FamilyMemberResponseDto extends createZodDto(FamilyMemberResponseSchema) {}
export class FamilyTreeResponseDto extends createZodDto(FamilyTreeResponseSchema) {}

export type FamilyMemberRef = z.infer<typeof FamilyMemberRefSchema>;
