import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import * as argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port';
import type { BrandKitDto, BrandLogoDto, ChangePasswordDto, NotificationsDto } from './settings.dto';

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async updateProfile(user: AuthenticatedUser, name: string): Promise<unknown> {
    const updated = await this.prisma.user.update({
      where: { id: user.userId },
      data: { displayName: name.trim() },
      select: { id: true, email: true, displayName: true },
    });
    return { id: updated.id, email: updated.email, name: updated.displayName };
  }

  async notifications(user: AuthenticatedUser): Promise<NotificationsDto> {
    const account = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { notificationPreferences: true } });
    return {
      processing: true,
      exports: true,
      billing: true,
      product: false,
      ...((account?.notificationPreferences as Partial<NotificationsDto> | null) ?? {}),
    };
  }

  async updateNotifications(user: AuthenticatedUser, input: NotificationsDto): Promise<NotificationsDto> {
    await this.prisma.user.update({ where: { id: user.userId }, data: { notificationPreferences: { ...input } } });
    return input;
  }

  async brandKit(user: AuthenticatedUser): Promise<unknown> {
    const kit = await this.prisma.brandKit.findFirst({ where: { workspaceId: user.workspaceId }, orderBy: { createdAt: 'asc' } });
    if (!kit) return kit;
    const watermark = jsonRecord(kit.watermark);
    return {
      ...kit,
      watermarkText: typeof watermark.text === 'string' ? watermark.text : '',
      watermarkPosition: typeof watermark.position === 'string' ? watermark.position : 'W-tw-32:H-th-32',
      watermarkOpacity: typeof watermark.opacity === 'number' ? watermark.opacity : 0.75,
    };
  }

  async updateBrandKit(user: AuthenticatedUser, input: BrandKitDto): Promise<unknown> {
    const current = await this.prisma.brandKit.findFirst({ where: { workspaceId: user.workspaceId } });
    const currentWatermark = jsonRecord(current?.watermark ?? null);
    const nextWatermark = { ...currentWatermark };
    if (input.watermarkText !== undefined) {
      const text = input.watermarkText.trim();
      if (text) nextWatermark.text = text;
      else delete nextWatermark.text;
    }
    const data = {
      name: input.name,
      primaryColor: input.primaryColor,
      accentColor: input.accentColor ?? '#FFFFFF',
      ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
      ...(input.watermarkText !== undefined ? { watermark: nextWatermark as Prisma.InputJsonObject } : {}),
    };
    const kit = current
      ? await this.prisma.brandKit.update({ where: { id: current.id }, data })
      : await this.prisma.brandKit.create({ data: { ...data, workspaceId: user.workspaceId } });
    await this.invalidateReadyClipExports(user.workspaceId);
    return kit;
  }

  async updateBrandLogo(user: AuthenticatedUser, input: BrandLogoDto): Promise<unknown> {
    const current = await this.prisma.brandKit.findFirst({ where: { workspaceId: user.workspaceId } });
    const currentWatermark = jsonRecord(current?.watermark ?? null);
    const uploadedLogoKey = input.dataUrl ? await this.uploadBrandLogo(user.workspaceId, input) : undefined;
    const logoKey = uploadedLogoKey ?? input.logoKey;
    const watermark: Record<string, unknown> = {
      ...currentWatermark,
      position: input.position ?? 'W-tw-32:H-th-32',
      opacity: input.opacity ?? 0.75,
    };
    if (input.watermarkText?.trim()) watermark.text = input.watermarkText.trim();
    if (current) {
      const kit = await this.prisma.brandKit.update({
        where: { id: current.id },
        data: {
          ...(logoKey !== undefined ? { logoKey: logoKey.trim() || null } : {}),
          watermark: watermark as Prisma.InputJsonObject,
        },
      });
      await this.invalidateReadyClipExports(user.workspaceId);
      return kit;
    }
    const kit = await this.prisma.brandKit.create({
      data: {
        workspaceId: user.workspaceId,
        name: 'Default',
        primaryColor: '#B8FF2C',
        accentColor: '#FFFFFF',
        ...(logoKey ? { logoKey: logoKey.trim() } : {}),
        watermark: watermark as Prisma.InputJsonObject,
      },
    });
    await this.invalidateReadyClipExports(user.workspaceId);
    return kit;
  }

  private async invalidateReadyClipExports(workspaceId: string): Promise<void> {
    await this.prisma.clip.updateMany({
      where: { status: 'READY', video: { workspaceId } },
      data: { status: 'SUGGESTED' },
    });
  }

  private async uploadBrandLogo(workspaceId: string, input: BrandLogoDto): Promise<string> {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(input.dataUrl ?? '');
    if (!match) throw new BadRequestException('Logo must be a PNG, JPEG or WebP data URL');
    const contentType = match[1]!;
    const extension = LOGO_TYPES[contentType];
    if (!extension) throw new BadRequestException('Unsupported logo type');
    const buffer = Buffer.from(match[2]!, 'base64');
    if (!buffer.length || buffer.byteLength > MAX_LOGO_BYTES) throw new BadRequestException('Logo must be between 1 byte and 5 MiB');
    const key = `brand-kits/${workspaceId}/${randomUUID()}.${extension}`;
    await this.storage.upload(key, Readable.from(buffer), contentType);
    return key;
  }

  async changePassword(user: AuthenticatedUser, input: ChangePasswordDto): Promise<void> {
    const account = await this.prisma.user.findUnique({ where: { id: user.userId } });
    if (!account || !(await argon2.verify(account.passwordHash, input.currentPassword))) {
      throw new UnauthorizedException('Current password is invalid');
    }
    const passwordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.userId }, data: { passwordHash } }),
      this.prisma.refreshSession.updateMany({ where: { userId: user.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }
}

const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const LOGO_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function jsonRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
