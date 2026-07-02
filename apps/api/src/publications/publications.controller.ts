import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { CreatePublicationDto, SOCIAL_PROVIDERS, StartSocialConnectionDto, type SocialProvider } from './publications.dto';

@Controller()
export class PublicationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('publications')
  async list(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    const items = await this.prisma.publication.findMany({
      where: { workspaceId: user.workspaceId },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
      include: { clip: { select: { title: true, score: true, aspectRatio: true } } },
    });
    return serialize(items);
  }

  @Post('publications')
  async create(@CurrentUser() user: AuthenticatedUser, @Body() input: CreatePublicationDto): Promise<unknown> {
    const clip = await this.prisma.clip.findFirst({
      where: { id: input.clipId, video: { workspaceId: user.workspaceId } },
      include: { seo: true },
    });
    if (!clip) throw new BadRequestException('Clip is not available in this workspace');
    const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    const status = scheduledAt && scheduledAt.getTime() > Date.now() ? 'SCHEDULED' : 'DRAFT';
    const publication = await this.prisma.publication.create({
      data: {
        workspaceId: user.workspaceId,
        clipId: clip.id,
        provider: input.provider,
        status,
        scheduledAt,
        title: input.title?.trim() || clip.title || 'Corte PicaShorts',
        description: input.description?.trim() || clip.seo?.description,
        hashtags: (input.hashtags ?? (clip.seo?.hashtags as string[] | undefined) ?? []) as Prisma.InputJsonArray,
      },
    });
    return serialize(publication);
  }

  @Post('social-connections/:provider')
  async startConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider') providerValue: string,
    @Body() input: StartSocialConnectionDto,
  ): Promise<unknown> {
    const provider = providerValue.toUpperCase() as SocialProvider;
    if (!SOCIAL_PROVIDERS.includes(provider)) throw new BadRequestException('Unsupported social provider');
    const connection = await this.prisma.socialConnection.upsert({
      where: { workspaceId_provider: { workspaceId: user.workspaceId, provider } },
      create: {
        workspaceId: user.workspaceId,
        provider,
        status: 'PENDING_CONFIGURATION',
        scopes: (input.scopes ?? []) as Prisma.InputJsonArray,
      },
      update: {
        status: 'PENDING_CONFIGURATION',
        scopes: (input.scopes ?? []) as Prisma.InputJsonArray,
      },
    });
    return serialize({
      ...connection,
      authUrl: null,
      redirectUri: input.redirectUri,
      message: 'OAuth credentials for this provider must be configured before a live connection can be completed.',
    });
  }
}

function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)));
}
