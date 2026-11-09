import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  FamilyLinkDto,
  FamilyMemberCreateDto,
  FamilyMemberUpdateDto,
  FamilyRelationCreateDto,
  FamilyStepUpdateDto,
  FamilyTreeResponseDto,
} from 'src/dtos/family.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { FamilyService } from 'src/services/family.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.People)
@Controller('family')
export class FamilyController {
  constructor(private service: FamilyService) {}

  @Get()
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get the family tree',
    description: 'The family tree of this Immich, shared by all users: its people and the parent, partner and sibling links between them.',
    history: new HistoryBuilder().added('v3.3.5').beta('v3.3.5'),
  })
  getFamilyTree(@Auth() auth: AuthDto): Promise<FamilyTreeResponseDto> {
    return this.service.getTree(auth);
  }

  @Post('members')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Add a family member',
    description: 'Add a person to the family tree.',
    history: new HistoryBuilder().added('v3.3.5').beta('v3.3.5'),
  })
  createFamilyMember(@Auth() auth: AuthDto, @Body() dto: FamilyMemberCreateDto): Promise<FamilyTreeResponseDto> {
    return this.service.createMember(auth, dto);
  }

  @Patch('members/:id')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Update a family member',
    description: 'Set the gender of a family member.',
    history: new HistoryBuilder().added('v3.3.5').beta('v3.3.5'),
  })
  updateFamilyMember(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: FamilyMemberUpdateDto,
  ): Promise<FamilyTreeResponseDto> {
    return this.service.updateMember(auth, id, dto);
  }

  @Delete('members/:id')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Remove a family member',
    description: 'Remove a person and their links from the family tree. The person and their photos stay.',
    history: new HistoryBuilder().added('v3.3.5').beta('v3.3.5'),
  })
  deleteFamilyMember(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<FamilyTreeResponseDto> {
    return this.service.deleteMember(auth, id);
  }

  @Post('relations')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Add a family relationship',
    description:
      'Say that a person is the parent, child, sibling or partner of someone in the family tree. Siblings without known parents are linked directly.',
    history: new HistoryBuilder().added('v3.3.5').beta('v3.3.5'),
  })
  addFamilyRelation(@Auth() auth: AuthDto, @Body() dto: FamilyRelationCreateDto): Promise<FamilyTreeResponseDto> {
    return this.service.addRelation(auth, dto);
  }

  @Post('relations/step')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Mark a parent as stepparent or parent by blood',
    description:
      'Say whether a parent (stored, or the partner of the only other parent) is a stepparent or a parent by blood of a child.',
    history: new HistoryBuilder().added('v3.3.6').beta('v3.3.6'),
  })
  setFamilyStep(@Auth() auth: AuthDto, @Body() dto: FamilyStepUpdateDto): Promise<FamilyTreeResponseDto> {
    return this.service.setStep(auth, dto);
  }

  @Post('relations/remove')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Remove a family link',
    description: 'Remove one stored parent, partner or sibling link.',
    history: new HistoryBuilder().added('v3.3.5').beta('v3.3.5'),
  })
  removeFamilyLink(@Auth() auth: AuthDto, @Body() dto: FamilyLinkDto): Promise<FamilyTreeResponseDto> {
    return this.service.removeLink(auth, dto);
  }
}
