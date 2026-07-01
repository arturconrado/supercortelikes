import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { CreateProjectDto, UpdateProjectDto } from './projects.dto';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    const projects = await this.prisma.project.findMany({
      where: { workspaceId: user.workspaceId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { videos: true } } },
    });
    return projects.map((project) => ({ ...project, videosCount: project._count.videos }));
  }

  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() input: CreateProjectDto): Promise<unknown> {
    return this.prisma.project.create({
      data: {
        workspaceId: user.workspaceId,
        createdById: user.userId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
      },
    });
  }

  @Get(':id')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<unknown> {
    const project = await this.prisma.project.findFirst({
      where: { id, workspaceId: user.workspaceId },
      include: { videos: { orderBy: { createdAt: 'desc' }, take: 100 } },
    });
    if (!project) throw new NotFoundException('Project not found');
    return serializeBigInts(project);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateProjectDto,
  ): Promise<unknown> {
    const result = await this.prisma.project.updateMany({
      where: { id, workspaceId: user.workspaceId },
      data: {
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() || null } : {}),
      },
    });
    if (result.count !== 1) throw new NotFoundException('Project not found');
    return this.prisma.project.findUnique({ where: { id } });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    const result = await this.prisma.project.deleteMany({ where: { id, workspaceId: user.workspaceId } });
    if (result.count !== 1) throw new NotFoundException('Project not found');
  }
}

function serializeBigInts(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)));
}
