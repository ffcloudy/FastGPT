// https://github.com/labring/FastGPT/blob/ca3053f04d06a5d2d5d5bb5d80cbc9150d244a2b/projects/app/src/web/core/app/api/log.ts
/**
 * 临时调试用：强制调用本地 Next API（/api/core/...），避免走 /proApi/...（商业版）路径。
 * 把此文件替换到 projects/app/src/web/core/app/api/log.ts 并重启前端以验证本地数据返回。
 *
 * 注意：这是临时文件，验证通过后请把逻辑改回根据 feConfigs.isPlus + FastGPTProUrl 判断的安全实现。
 */

import type { getLogKeysQuery, getLogKeysResponse } from '@/pages/api/core/app/logs/getLogKeys';
import type { updateLogKeysBody } from '@/pages/api/core/app/logs/updateLogKeys';
import { GET, POST } from '@/web/common/api/request';
import type { AppLogsListItemType } from '@/types/app';
import type { PaginationResponse } from '@fastgpt/web/common/fetch/type';
import type { GetAppChatLogsParams } from '@/global/core/api/appReq';
import type {
  getChartDataBody,
  getChartDataResponse,
  getTotalDataQuery,
  getTotalDataResponse
} from '@fastgpt/global/core/app/logs/api';

/**
 * 保留并使用本地 Next API 路径（/api/core/...）
 * 这些方法在临时调试时直接调用本地实现，避免走 pro 接口。
 */

export const updateLogKeys = (data: updateLogKeysBody) =>
  POST('/core/app/logs/updateLogKeys', data);

export const getLogKeys = (data: getLogKeysQuery) =>
  GET<getLogKeysResponse>('/core/app/logs/getLogKeys', data);

export const getAppChatLogs = (data: GetAppChatLogsParams) =>
  POST<PaginationResponse<AppLogsListItemType>>('/core/app/getChatLogs', data, {
    maxQuantity: 1
  });

/**
 * 强制使用本地 Next API（临时）
 * - POST /api/core/app/logs/getChartData
 * - GET  /api/core/app/logs/getTotalData?appId=...
 *
 * 在确认本地实现正常后，再将此处恢复为按 feConfigs.isPlus + PRO_URL 决定走 proApi 或本地。
 */
export const getAppChartData = (data: getChartDataBody) => {
  return POST<getChartDataResponse>('/core/app/logs/getChartData', data);
};

export const getAppTotalData = (data: getTotalDataQuery) => {
  // GET with params
  return GET<getTotalDataResponse>('/core/app/logs/getTotalData', { appId: data.appId });
};
