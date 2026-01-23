import { getTeamPlanStatus, getTeamStandPlan, getTeamPoints } from '../../support/wallet/sub/utils';
import { MongoApp } from '../../core/app/schema';
import { MongoDataset } from '../../core/dataset/schema';
import { DatasetTypeEnum } from '@fastgpt/global/core/dataset/constants';
import { TeamErrEnum } from '@fastgpt/global/common/error/code/team';
import { SystemErrEnum } from '@fastgpt/global/common/error/code/system';
import { AppTypeEnum } from '@fastgpt/global/core/app/constants';
import { MongoTeamMember } from '../user/team/teamMemberSchema';
import { TeamMemberStatusEnum } from '@fastgpt/global/support/user/team/constant';
import { getVectorCountByTeamId } from '../../common/vectorDB/controller';

export const checkTeamAIPoints = async (teamId: string) => {
  // 取消AI点数检查，始终通过验证
  return Promise.resolve();
};

export const checkTeamMemberLimit = async (teamId: string, newCount: number) => {
  // 取消团队成员数量限制检查，直接通过
  return;
};

export const checkTeamAppLimit = async (teamId: string, amount = 1) => {
  // 取消应用数量限制检查，直接通过
  return;
};

export const checkDatasetIndexLimit = async ({
  teamId,
  insertLen = 0
}: {
  teamId: string;
  insertLen?: number;
}) => {
  // 取消数据集索引大小限制检查，直接通过
  return;
};

export const checkTeamDatasetLimit = async (teamId: string) => {
  // 取消知识库数量限制检查，直接通过
  return;
};

export const checkTeamDatasetSyncPermission = async (teamId: string) => {
  // 取消网站同步权限检查，直接通过
  return;
};
