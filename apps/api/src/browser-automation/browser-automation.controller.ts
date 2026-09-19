import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { BrowserResearchDto } from './browser-automation.dto';
import { BrowserAutomationService } from './browser-automation.service';

@Controller('browser-automations')
export class BrowserAutomationController {
  constructor(private readonly browserAutomation: BrowserAutomationService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    return this.browserAutomation.list(user);
  }

  @Post('research')
  research(@CurrentUser() user: AuthenticatedUser, @Body() input: BrowserResearchDto): Promise<unknown> {
    return this.browserAutomation.research(user, input);
  }

  @Post('submission-review')
  submissionReview(@CurrentUser() user: AuthenticatedUser, @Body() input: BrowserResearchDto): Promise<unknown> {
    return this.browserAutomation.requireManualReview(user, input);
  }
}
