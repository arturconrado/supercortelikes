import { Body, Controller, Delete, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AccountService } from './account.service';
import { DeleteAccountDto } from './account.dto';

@Controller('account')
export class AccountController {
  constructor(private readonly accounts: AccountService) {}

  @Get('export')
  async exportData(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    return this.accounts.exportData(user);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthenticatedUser, @Body() input: DeleteAccountDto): Promise<void> {
    await this.accounts.remove(user, input.password);
  }
}
