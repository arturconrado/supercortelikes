import { Module } from '@nestjs/common';
import { BrowserAutomationController } from './browser-automation.controller';
import { BrowserAutomationService } from './browser-automation.service';

@Module({ controllers: [BrowserAutomationController], providers: [BrowserAutomationService] })
export class BrowserAutomationModule {}
