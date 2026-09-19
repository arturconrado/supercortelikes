import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AdvanceOpportunityDto, CreateMetricSnapshotDto, CreateOpportunityDto, DecideOpportunityDto, ScoutOpportunitiesDto, UpdateMediaAssetStatusDto } from './opportunities.dto';
import { OpportunitiesService } from './opportunities.service';

@Controller('opportunities')
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

  @Get()
  summary(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    return this.opportunities.summary(user);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() input: CreateOpportunityDto): Promise<unknown> {
    return this.opportunities.create(user, input);
  }

  @Post('scout')
  scout(@CurrentUser() user: AuthenticatedUser, @Body() input: ScoutOpportunitiesDto): Promise<unknown> {
    return this.opportunities.scout(user, input);
  }

  @Post(':id/decision')
  decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: DecideOpportunityDto,
  ): Promise<unknown> {
    return this.opportunities.decide(user, id, input);
  }

  @Patch(':id/status')
  advance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: AdvanceOpportunityDto,
  ): Promise<unknown> {
    return this.opportunities.advance(user, id, input);
  }

  @Post(':id/products')
  generateProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<unknown> {
    return this.opportunities.generateProduct(user, id);
  }

  @Post(':id/launch')
  prepareLaunch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<unknown> {
    return this.opportunities.prepareLaunch(user, id);
  }

  @Post(':id/metrics')
  createMetricSnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: CreateMetricSnapshotDto,
  ): Promise<unknown> {
    return this.opportunities.createMetricSnapshot(user, id, input);
  }

  @Get('products/:productId/media-assets')
  listMediaAssets(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<unknown> {
    return this.opportunities.listMediaAssets(user, productId);
  }

  @Post('products/:productId/media-assets')
  generateMediaAssets(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<unknown> {
    return this.opportunities.generateMediaAssets(user, productId);
  }

  @Patch('media-assets/:assetId/status')
  updateMediaAssetStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
    @Body() input: UpdateMediaAssetStatusDto,
  ): Promise<unknown> {
    return this.opportunities.updateMediaAssetStatus(user, assetId, input);
  }
}
