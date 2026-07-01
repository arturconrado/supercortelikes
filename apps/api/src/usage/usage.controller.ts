import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { UsageService, type UsageSnapshot } from './usage.service';

@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('current')
  async current(@CurrentUser() user: AuthenticatedUser): Promise<UsageSnapshot> {
    return this.usage.current(user);
  }
}
