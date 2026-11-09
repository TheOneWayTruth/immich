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
}

export interface FamilyLink {
  type: FamilyLinkType;
  /** parent links point from the parent to the child; partner and sibling links are stored with fromId < toId */
  fromId: string;
  toId: string;
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
 * a child with one known parent whose parent has exactly one partner gets that partner as second parent,
 * so the children of a couple are siblings by default
 */
const completeParents = (childIds: string[]) => sql`
  with "single_parent" as (
    select "toId" as "childId", min("fromId"::text)::uuid as "parentId"
    from "family_relation"
    where "type" = 'parent' and "toId" = any(${childIds}::uuid[])
    group by "toId"
    having count(*) = 1
  ),
  "partner_pair" as (
    select "fromId" as "id", "toId" as "partnerId" from "family_relation" where "type" = 'partner'
    union
    select "toId", "fromId" from "family_relation" where "type" = 'partner'
  ),
  "only_partner" as (
    select "id", min("partnerId"::text)::uuid as "partnerId"
    from "partner_pair"
    group by "id"
    having count(*) = 1
  )
  insert into "family_relation" ("type", "fromId", "toId")
  select 'parent', p."partnerId", s."childId"
  from "single_parent" s
  join "only_partner" p on p."id" = s."parentId"
  where p."partnerId" != s."childId"
    and not exists (
      select from "family_relation" c where c."type" = 'parent' and c."fromId" = s."childId" and c."toId" = p."partnerId"
    )
  on conflict do nothing
`;

/** inserts a partner link for every two parents of the given children, so parents are partners by default */
const linkCoParents = (childIds: string[]) => sql`
  insert into "family_relation" ("type", "fromId", "toId")
  select distinct 'partner', a."fromId", b."fromId"
  from "family_relation" a
  join "family_relation" b on b."type" = 'parent' and b."toId" = a."toId" and a."fromId" < b."fromId"
  where a."type" = 'parent' and a."toId" = any(${childIds}::uuid[])
  on conflict do nothing
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
        await this.db.transaction().execute(async (tx) => {
          const { rows } = await sql`
            insert into "family_migration" ("name") values ('one-tree-per-immich') on conflict do nothing returning "name"
          `.execute(tx);
          if (rows.length > 0) {
            for (const statement of fromPerUserTree) {
              await statement.execute(tx);
            }
          }
        });
      }
    })().catch((error) => {
      this.tables = undefined;
      throw error;
    });
    return this.tables;
  }

  async getMembers(userId: string): Promise<FamilyMember[]> {
    await this.ensureTables();
    const { rows } = await sql<FamilyMember>`
      select
        f."personGroupId" as "id",
        coalesce(nullif(own."name", ''), other."name", '') as "name",
        f."gender",
        coalesce(own."birthDate", other."birthDate")::text as "birthDate"
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
      select "type", "fromId", "toId" from "family_relation" order by "createdAt", "fromId", "toId"
    `.execute(this.db);
    return rows;
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

  async addLink({ type, fromId, toId }: FamilyLink) {
    await this.ensureTables();
    const [a, b] = type === FamilyLinkType.Parent ? [fromId, toId] : [fromId, toId].sort();
    await sql`
      insert into "family_relation" ("type", "fromId", "toId") values (${type}, ${a}, ${b}) on conflict do nothing
    `.execute(this.db);
  }

  async removeLink({ type, fromId, toId }: FamilyLink) {
    await this.ensureTables();
    const [a, b] = type === FamilyLinkType.Parent ? [fromId, toId] : [fromId, toId].sort();
    await sql`
      delete from "family_relation" where "type" = ${type} and "fromId" = ${a} and "toId" = ${b}
    `.execute(this.db);
  }

  async completeParents(childIds: string[]) {
    if (childIds.length > 0) {
      await this.ensureTables();
      await completeParents(childIds).execute(this.db);
    }
  }

  async linkCoParents(childIds: string[]) {
    if (childIds.length > 0) {
      await this.ensureTables();
      await linkCoParents(childIds).execute(this.db);
    }
  }
}
