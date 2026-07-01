import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  BrandKitDto,
  BrandLogoDto,
  ChangePasswordDto,
  NotificationsDto,
  UpdateProfileDto,
} from './settings.dto';
import { SettingsService } from './settings.service';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Patch('users/me')
  async profile(@CurrentUser() user: AuthenticatedUser, @Body() input: UpdateProfileDto): Promise<unknown> {
    return this.settings.updateProfile(user, input.name);
  }

  @Get('users/me/notifications')
  async notifications(@CurrentUser() user: AuthenticatedUser): Promise<NotificationsDto> {
    return this.settings.notifications(user);
  }

  @Put('users/me/notifications')
  async updateNotifications(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: NotificationsDto,
  ): Promise<NotificationsDto> {
    return this.settings.updateNotifications(user, input);
  }

  @Get('brand-kits')
  async brandKit(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    return this.settings.brandKit(user);
  }

  @Put('brand-kits')
  async updateBrandKit(@CurrentUser() user: AuthenticatedUser, @Body() input: BrandKitDto): Promise<unknown> {
    return this.settings.updateBrandKit(user, input);
  }

  @Post('brand-kits/logo')
  async updateBrandLogo(@CurrentUser() user: AuthenticatedUser, @Body() input: BrandLogoDto): Promise<unknown> {
    return this.settings.updateBrandLogo(user, input);
  }

  @Patch('auth/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async password(@CurrentUser() user: AuthenticatedUser, @Body() input: ChangePasswordDto): Promise<void> {
    await this.settings.changePassword(user, input);
  }

}
