import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { FamilyGender, FamilyLinkType } from 'src/dtos/family.dto.js';
import { DB } from 'src/schema/index.js';

export interface FamilyMember {
  id: string;
  personGroupId: string | null;
  /** the person's name when linked, else the name stored on the member */
  name: string;
  gender: FamilyGender | null;
  birthDate: string | null;
  isPlaceholder: boolean;
  isMe: boolean;
}

export interface FamilyLink {
  type: FamilyLinkType;
  fromId: string;
  toId: string;
}

export interface FamilyMemberValues {
  personGroupId?: string | null;
  name?: string;
  gender?: FamilyGender | null;
  isPlaceholder?: boolean;
}

// the family tree lives in its own tables, outside Immich's schema and migrations,
// so the official image keeps working on this database (extra tables are ignored by the drift check)
const createTables = [
  sql`
    create table if not exists "family_member" (
      "id" uuid primary key default gen_random_uuid(),
      "ownerId" uuid not null references "user" ("id") on delete cascade,
      "personGroupId" uuid,
      "name" text not null default '',
      "gender" text check ("gender" in ('female', 'male')),
      "isPlaceholder" boolean not null default false,
      "isMe" boolean not null default false,
      "createdAt" timestamp with time zone not null default now(),
      "updatedAt" timestamp with time zone not null default now()
    )
  `,
  sql`
    create unique index if not exists "family_member_ownerId_personGroupId_uq"
    on "family_member" ("ownerId", "personGroupId") where "personGroupId" is not null
  `,
  sql`create unique index if not exists "family_member_ownerId_isMe_uq" on "family_member" ("ownerId") where "isMe"`,
  sql`
    create table if not exists "family_link" (
      "ownerId" uuid not null references "user" ("id") on delete cascade,
      "type" text not null check ("type" in ('parent', 'partner')),
      "fromId" uuid not null references "family_member" ("id") on delete cascade,
      "toId" uuid not null references "family_member" ("id") on delete cascade,
      "createdAt" timestamp with time zone not null default now(),
      primary key ("fromId", "toId", "type"),
      check ("fromId" != "toId")
    )
  `,
  sql`create index if not exists "family_link_ownerId_idx" on "family_link" ("ownerId")`,
  sql`create table if not exists "family_migration" ("name" text primary key)`,
];

/**
 * a child with one known parent whose parent has exactly one partner gets that partner as second parent,
 * so the children of a couple are siblings by default
 */
const completeParents = (where: ReturnType<typeof sql>) => sql`
  with "single_parent" as (
    select "ownerId", "toId" as "childId", min("fromId"::text)::uuid as "parentId"
    from "family_link"
    where "type" = 'parent' and ${where}
    group by "ownerId", "toId"
    having count(*) = 1
  ),
  "partner_pair" as (
    select "ownerId", "fromId" as "id", "toId" as "partnerId" from "family_link" where "type" = 'partner'
    union
    select "ownerId", "toId", "fromId" from "family_link" where "type" = 'partner'
  ),
  "only_partner" as (
    select "ownerId", "id", min("partnerId"::text)::uuid as "partnerId"
    from "partner_pair"
    group by "ownerId", "id"
    having count(*) = 1
  )
  insert into "family_link" ("ownerId", "type", "fromId", "toId")
  select s."ownerId", 'parent', p."partnerId", s."childId"
  from "single_parent" s
  join "only_partner" p on p."ownerId" = s."ownerId" and p."id" = s."parentId"
  where p."partnerId" != s."childId"
    and not exists (
      select from "family_link" c where c."type" = 'parent' and c."fromId" = s."childId" and c."toId" = p."partnerId"
    )
  on conflict do nothing
`;

/** inserts a partner link for every two parents of the given children, so parents are partners by default */
const linkCoParents = (where: ReturnType<typeof sql>) => sql`
  insert into "family_link" ("ownerId", "type", "fromId", "toId")
  select distinct a."ownerId", 'partner', a."fromId", b."fromId"
  from "family_link" a
  join "family_link" b on b."toId" = a."toId" and b."type" = 'parent' and a."fromId" < b."fromId"
  where a."type" = 'parent' and ${where}
    and not exists (
      select from "family_link" p
      where p."type" = 'partner' and p."fromId" = b."fromId" and p."toId" = a."fromId"
    )
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
      // trees made before these defaults get the links once; links removed later stay removed
      const migrations = [
        { name: 'children-of-a-couple-are-siblings', statement: completeParents(sql`true`) },
        { name: 'co-parents-are-partners', statement: linkCoParents(sql`true`) },
      ];
      for (const { name, statement } of migrations) {
        const { rows } = await sql`
          insert into "family_migration" ("name") values (${name}) on conflict do nothing returning "name"
        `.execute(this.db);
        if (rows.length > 0) {
          await statement.execute(this.db);
        }
      }
    })().catch((error) => {
      this.tables = undefined;
      throw error;
    });
    return this.tables;
  }

  async getMembers(ownerId: string): Promise<FamilyMember[]> {
    await this.ensureTables();
    const { rows } = await sql<FamilyMember>`
      select
        "member"."id",
        "member"."personGroupId",
        coalesce(nullif("person"."name", ''), "member"."name") as "name",
        "member"."gender",
        "person"."birthDate"::text as "birthDate",
        "member"."isPlaceholder",
        "member"."isMe"
      from "family_member" as "member"
      left join "person" on "person"."ownerId" = "member"."ownerId" and "person"."personGroupId" = "member"."personGroupId"
      where "member"."ownerId" = ${ownerId}
      order by "member"."createdAt"
    `.execute(this.db);
    return rows;
  }

  async getLinks(ownerId: string): Promise<FamilyLink[]> {
    await this.ensureTables();
    const { rows } = await sql<FamilyLink>`
      select "type", "fromId", "toId" from "family_link" where "ownerId" = ${ownerId} order by "createdAt"
    `.execute(this.db);
    return rows;
  }

  async createMember(ownerId: string, values: FamilyMemberValues): Promise<string> {
    await this.ensureTables();
    const { rows } = await sql<{ id: string }>`
      insert into "family_member" ("ownerId", "personGroupId", "name", "gender", "isPlaceholder")
      values (
        ${ownerId},
        ${values.personGroupId ?? null},
        ${values.name ?? ''},
        ${values.gender ?? null},
        ${values.isPlaceholder ?? false}
      )
      returning "id"
    `.execute(this.db);
    return rows[0].id;
  }

  async updateMember(ownerId: string, id: string, values: FamilyMemberValues) {
    await this.ensureTables();
    const set = [
      values.personGroupId === undefined ? undefined : sql`"personGroupId" = ${values.personGroupId}`,
      values.name === undefined ? undefined : sql`"name" = ${values.name}`,
      values.gender === undefined ? undefined : sql`"gender" = ${values.gender}`,
      values.isPlaceholder === undefined ? undefined : sql`"isPlaceholder" = ${values.isPlaceholder}`,
    ].filter((item) => item !== undefined);
    if (set.length === 0) {
      return;
    }
    await sql`
      update "family_member" set ${sql.join(set)}, "updatedAt" = now()
      where "ownerId" = ${ownerId} and "id" = ${id}
    `.execute(this.db);
  }

  async setMe(ownerId: string, id: string | null) {
    await this.ensureTables();
    await this.db.transaction().execute(async (tx) => {
      await sql`update "family_member" set "isMe" = false where "ownerId" = ${ownerId} and "isMe"`.execute(tx);
      if (id) {
        await sql`update "family_member" set "isMe" = true where "ownerId" = ${ownerId} and "id" = ${id}`.execute(tx);
      }
    });
  }

  async deleteMembers(ownerId: string, ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    await this.ensureTables();
    await sql`delete from "family_member" where "ownerId" = ${ownerId} and "id" = any(${ids}::uuid[])`.execute(this.db);
  }

  async addLink(ownerId: string, { type, fromId, toId }: FamilyLink) {
    await this.ensureTables();
    await sql`
      insert into "family_link" ("ownerId", "type", "fromId", "toId")
      values (${ownerId}, ${type}, ${fromId}, ${toId})
      on conflict do nothing
    `.execute(this.db);
  }

  async completeParents(ownerId: string, childIds: string[]) {
    if (childIds.length === 0) {
      return;
    }
    await this.ensureTables();
    await completeParents(sql`"ownerId" = ${ownerId} and "toId" = any(${childIds}::uuid[])`).execute(this.db);
  }

  async linkCoParents(ownerId: string, childIds: string[]) {
    if (childIds.length === 0) {
      return;
    }
    await this.ensureTables();
    await linkCoParents(sql`a."ownerId" = ${ownerId} and a."toId" = any(${childIds}::uuid[])`).execute(this.db);
  }

  async removeLink(ownerId: string, { type, fromId, toId }: FamilyLink) {
    await this.ensureTables();
    await sql`
      delete from "family_link"
      where "ownerId" = ${ownerId} and "type" = ${type}
        and (("fromId" = ${fromId} and "toId" = ${toId}) or ("type" = 'partner' and "fromId" = ${toId} and "toId" = ${fromId}))
    `.execute(this.db);
  }

  /** moves every link of source over to target and deletes source */
  async mergeMember(ownerId: string, sourceId: string, targetId: string) {
    await this.ensureTables();
    await this.db.transaction().execute(async (tx) => {
      await sql`
        insert into "family_link" ("ownerId", "type", "fromId", "toId")
        select "ownerId", "type",
          case when "fromId" = ${sourceId} then ${targetId}::uuid else "fromId" end,
          case when "toId" = ${sourceId} then ${targetId}::uuid else "toId" end
        from "family_link"
        where "ownerId" = ${ownerId} and (("fromId" = ${sourceId} and "toId" != ${targetId}) or ("toId" = ${sourceId} and "fromId" != ${targetId}))
        on conflict do nothing
      `.execute(tx);
      await sql`delete from "family_member" where "ownerId" = ${ownerId} and "id" = ${sourceId}`.execute(tx);
    });
  }
}
