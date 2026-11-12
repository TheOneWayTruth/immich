import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { FamilyGender, FamilyLinkType } from 'src/dtos/family.dto.js';
import { DB } from 'src/schema/index.js';

export interface FamilyMember {
  /** the person (group) id, the same for every user of this Immich */
  id: string;
  /** the name the viewing user gave the person, else any other user's name */
  name: string;
  gender: FamilyGender | null;
  birthDate: string | null;
  /** the viewing user has this person among their own people, so its page and photos are theirs to open */
  hasPerson: boolean;
}

export interface FamilyLink {
  type: FamilyLinkType;
  /** parent links point from the parent to the child; partner and sibling links are stored with fromId < toId */
  fromId: string;
  toId: string;
  /** a stepparent: the parent link is not by blood (parent links only) */
  isStep: boolean;
}

// one family tree per Immich, shared by all users. It lives in its own tables, outside Immich's schema and
// migrations, so the official image keeps working on this database (extra tables are ignored by the drift check)
const createTables = [
  sql`
    create table if not exists "family_person" (
      "personGroupId" uuid primary key references "person_group" ("id") on delete cascade,
      "gender" text check ("gender" in ('female', 'male')),
      "createdAt" timestamp with time zone not null default now()
    )
  `,
  sql`
    create table if not exists "family_relation" (
      "type" text not null check ("type" in ('parent', 'partner', 'sibling')),
      "fromId" uuid not null references "family_person" ("personGroupId") on delete cascade,
      "toId" uuid not null references "family_person" ("personGroupId") on delete cascade,
      "createdAt" timestamp with time zone not null default now(),
      primary key ("fromId", "toId", "type"),
      check ("fromId" != "toId"),
      check ("type" = 'parent' or "fromId" < "toId")
    )
  `,
  sql`create index if not exists "family_relation_toId_idx" on "family_relation" ("toId")`,
  sql`alter table "family_relation" add column if not exists "isStep" boolean not null default false`,
  sql`create table if not exists "family_migration" ("name" text primary key)`,
];

/**
 * The first family tree was per user, had members without photos and unknown placeholder parents.
 * Its people move over (the first owner's gender wins), and the children of a placeholder become siblings.
 * The old tables "family_member" and "family_link" stay as they are.
 */
const fromPerUserTree = [
  sql`
    insert into "family_person" ("personGroupId", "gender", "createdAt")
    select distinct on (m."personGroupId") m."personGroupId", m."gender", m."createdAt"
    from "family_member" m
    join "person_group" g on g."id" = m."personGroupId"
    order by m."personGroupId", m."createdAt"
    on conflict do nothing
  `,
  sql`
    insert into "family_relation" ("type", "fromId", "toId", "createdAt")
    select l."type",
      case when l."type" = 'parent' then a."personGroupId" else least(a."personGroupId", b."personGroupId") end,
      case when l."type" = 'parent' then b."personGroupId" else greatest(a."personGroupId", b."personGroupId") end,
      l."createdAt"
    from "family_link" l
    join "family_member" a on a."id" = l."fromId"
    join "family_member" b on b."id" = l."toId"
    where a."personGroupId" in (select "personGroupId" from "family_person")
      and b."personGroupId" in (select "personGroupId" from "family_person")
      and a."personGroupId" != b."personGroupId"
    on conflict do nothing
  `,
  sql`
    insert into "family_relation" ("type", "fromId", "toId", "createdAt")
    select 'sibling', least(a."personGroupId", b."personGroupId"), greatest(a."personGroupId", b."personGroupId"), now()
    from "family_member" p
    join "family_link" la on la."type" = 'parent' and la."fromId" = p."id"
    join "family_link" lb on lb."type" = 'parent' and lb."fromId" = p."id"
    join "family_member" a on a."id" = la."toId"
    join "family_member" b on b."id" = lb."toId"
    where p."isPlaceholder"
      and a."personGroupId" in (select "personGroupId" from "family_person")
      and b."personGroupId" in (select "personGroupId" from "family_person")
      and a."personGroupId" < b."personGroupId"
    on conflict do nothing
  `,
];

/**
 * Only what was said is stored; a child with one parent by blood whose parent has exactly one partner gets that
 * partner as second parent when the tree is read. The tree used to store those second parents, so a second parent
 * that the rule gives anyway is removed once (the later of the two, which was usually added automatically).
 */
const removeInferableParents = sql`
  with "bio" as (
    select "fromId", "toId", "createdAt" from "family_relation" where "type" = 'parent' and not "isStep"
  ),
  "two_parents" as (
    select "toId" from "bio" group by "toId" having count(*) = 2
  ),
  "partner_pair" as (
    select "fromId" as "id", "toId" as "partnerId" from "family_relation" where "type" = 'partner'
    union
    select "toId", "fromId" from "family_relation" where "type" = 'partner'
  ),
  "only_partner" as (
    select "id", min("partnerId"::text)::uuid as "partnerId" from "partner_pair" group by "id" having count(*) = 1
  ),
  "inferable" as (
    -- b is the only partner of a, the other parent of the same child
    select b."fromId", b."toId", b."createdAt"
    from "bio" a
    join "bio" b on b."toId" = a."toId" and b."fromId" != a."fromId"
    join "two_parents" t on t."toId" = a."toId"
    join "only_partner" o on o."id" = a."fromId" and o."partnerId" = b."fromId"
  ),
  "chosen" as (
    select distinct on ("toId") "fromId", "toId" from "inferable" order by "toId", "createdAt" desc, "fromId"
  )
  delete from "family_relation" r
  using "chosen" c
  where r."type" = 'parent' and r."fromId" = c."fromId" and r."toId" = c."toId"
`;

@Injectable()
export class FamilyRepository {
  private tables?: Promise<unknown>;

  constructor(@InjectKysely() private db: Kysely<DB>) {}

  private ensureTables() {
    this.tables ??= (async () => {
      for (const statement of createTables) {
        await statement.execute(this.db);
      }
      const { rows: old } = await sql<{ exists: boolean }>`
        select to_regclass('family_member') is not null and to_regclass('family_link') is not null as "exists"
      `.execute(this.db);
      if (old[0]?.exists) {
        await this.runOnce('one-tree-per-immich', fromPerUserTree);
      }
      await this.runOnce('only-stated-links', [removeInferableParents]);
    })().catch((error) => {
      this.tables = undefined;
      throw error;
    });
    return this.tables;
  }

  /** runs the statements in one transaction, the first time this name comes up */
  private async runOnce(name: string, statements: Array<ReturnType<typeof sql>>) {
    await this.db.transaction().execute(async (tx) => {
      const { rows } = await sql`
        insert into "family_migration" ("name") values (${name}) on conflict do nothing returning "name"
      `.execute(tx);
      if (rows.length > 0) {
        for (const statement of statements) {
          await statement.execute(tx);
        }
      }
    });
  }

  async getMembers(userId: string): Promise<FamilyMember[]> {
    await this.ensureTables();
    const { rows } = await sql<FamilyMember>`
      select
        f."personGroupId" as "id",
        coalesce(nullif(own."name", ''), other."name", '') as "name",
        f."gender",
        coalesce(own."birthDate", other."birthDate")::text as "birthDate",
        own."ownerId" is not null as "hasPerson"
      from "family_person" f
      left join "person" own on own."personGroupId" = f."personGroupId" and own."ownerId" = ${userId}
      left join lateral (
        select p."name", p."birthDate" from "person" p
        where p."personGroupId" = f."personGroupId" and p."name" != ''
        order by p."createdAt"
        limit 1
      ) other on true
      order by f."createdAt", f."personGroupId"
    `.execute(this.db);
    return rows;
  }

  async getLinks(): Promise<FamilyLink[]> {
    await this.ensureTables();
    const { rows } = await sql<FamilyLink>`
      select "type", "fromId", "toId", "isStep" from "family_relation" order by "createdAt", "fromId", "toId"
    `.execute(this.db);
    return rows;
  }

  /**
   * The face of a person for the family tree: the viewing user's own picture first, else the picture another user
   * chose, as long as the person is in the family tree (which every user sees). People outside the tree only show the
   * viewing user's own picture.
   */
  async getThumbnailPath(userId: string, id: string): Promise<string | undefined> {
    await this.ensureTables();
    const { rows } = await sql<{ thumbnailPath: string }>`
      select p."thumbnailPath" from "person" p
      where p."personGroupId" = ${id}
        and p."thumbnailPath" != ''
        and (p."ownerId" = ${userId} or exists (select 1 from "family_person" f where f."personGroupId" = ${id}))
      order by p."ownerId" = ${userId} desc, p."createdAt"
      limit 1
    `.execute(this.db);
    return rows[0]?.thumbnailPath;
  }

  async addMember(id: string, gender?: FamilyGender | null) {
    await this.ensureTables();
    await sql`
      insert into "family_person" ("personGroupId", "gender") values (${id}, ${gender ?? null})
      on conflict ("personGroupId") do nothing
    `.execute(this.db);
  }

  async setGender(id: string, gender: FamilyGender | null) {
    await this.ensureTables();
    await sql`update "family_person" set "gender" = ${gender} where "personGroupId" = ${id}`.execute(this.db);
  }

  async deleteMember(id: string) {
    await this.ensureTables();
    await sql`delete from "family_person" where "personGroupId" = ${id}`.execute(this.db);
  }

  /** adds a link, or for a parent link that exists already sets whether it is a stepparent */
  async addLink({ type, fromId, toId, isStep = false }: Omit<FamilyLink, 'isStep'> & { isStep?: boolean }) {
    await this.ensureTables();
    const [a, b] = type === FamilyLinkType.Parent ? [fromId, toId] : [fromId, toId].sort();
    const step = type === FamilyLinkType.Parent && isStep;
    await sql`
      insert into "family_relation" ("type", "fromId", "toId", "isStep") values (${type}, ${a}, ${b}, ${step})
      on conflict ("fromId", "toId", "type") do update set "isStep" = excluded."isStep"
    `.execute(this.db);
  }

  async removeLink({ type, fromId, toId }: Pick<FamilyLink, 'type' | 'fromId' | 'toId'>) {
    await this.ensureTables();
    const [a, b] = type === FamilyLinkType.Parent ? [fromId, toId] : [fromId, toId].sort();
    await sql`
      delete from "family_relation" where "type" = ${type} and "fromId" = ${a} and "toId" = ${b}
    `.execute(this.db);
  }
}
