/**
 * 本地实现：GET/POST 接口 /api/core/app/logs/getChartData
 * - 返回格式按前端 LogChart.tsx 的期待构造：
 *   {
 *     userData: [{ timestamp, summary: { userCount, newUserCount, ... } }, ...],
 *     chatData: [{ timestamp, summary: { chatCount, chatItemCount, ... } }, ...],
 *     appData: [{ timestamp, summary: { goodFeedBackCount, badFeedBackCount, totalPoints, ... } }, ...]
 *   }
 *
 * 说明：
 * - 为避免前端因为缺字段抛异常，这里把大部分常用字段都填上（无法直接计算的字段填 0 / {}）。
 * - 该实现按天聚合（$dateToString），若需要按 hour/week/minute 可拓展 pipeline。
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { NextAPI } from '@/service/middleware/entry';
import { Types } from '@fastgpt/service/common/mongo';
import { MongoAppChatLog } from '@fastgpt/service/core/app/logs/chatLogsSchema';
import { authApp } from '@fastgpt/service/support/permission/app/auth';
import { AppReadChatLogPerVal } from '@fastgpt/global/support/permission/app/constant';
import { addDays } from 'date-fns';
import type { getChartDataBody, getChartDataResponse } from '@fastgpt/global/core/app/logs/api';

const dayStrToTimestamp = (str: string) => new Date(str + 'T00:00:00.000Z').getTime();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const body = (req.method === 'GET' ? req.query : req.body) as unknown as getChartDataBody;
    const { appId, dateStart, dateEnd, source } = body;

    if (!appId) {
      return res.status(400).json({ code: 400, message: 'missing appId' });
    }

    // 权限校验（与 getChatLogs 保持一致）
    const { teamId } = await authApp({
      req,
      authToken: true,
      appId,
      per: AppReadChatLogPerVal
    });

    const start = dateStart ? new Date(dateStart) : addDays(new Date(), -6);
    const end = dateEnd ? new Date(dateEnd) : new Date();

    const match: any = {
      teamId: new Types.ObjectId(teamId),
      appId: new Types.ObjectId(appId),
      updateTime: {
        $gte: start,
        $lte: end
      }
    };
    if (source && Array.isArray(source) && source.length > 0) {
      match.source = { $in: source };
    }

    // 聚合：按天统计常用字段（从本地日志集合统计）
    const pipeline: any[] = [
      { $match: match },
      {
        $group: {
          _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$updateTime' } } },
          chatCount: { $sum: 1 },
          totalPoints: { $sum: { $ifNull: ['$totalPoints', 0] } },
          totalResponseTime: { $sum: { $ifNull: ['$totalResponseTime', 0] } },
          chatItemCount: { $sum: { $ifNull: ['$chatItemCount', 0] } },
          errorCount: { $sum: { $ifNull: ['$errorCount', 0] } },
          goodFeedBackCount: { $sum: { $ifNull: ['$goodFeedbackCount', 0] } },
          badFeedBackCount: { $sum: { $ifNull: ['$badFeedbackCount', 0] } },
          uniqueUsers: { $addToSet: '$userId' }
        }
      },
      {
        $project: {
          day: '$_id.day',
          _id: 0,
          chatCount: 1,
          userCount: { $size: '$uniqueUsers' },
          totalPoints: 1,
          errorCount: 1,
          goodFeedBackCount: 1,
          badFeedBackCount: 1,
          totalResponseTime: 1,
          chatItemCount: 1
        }
      },
      { $sort: { day: 1 } as any }
    ];

    const aggResult = await MongoAppChatLog.aggregate(pipeline as any).allowDiskUse(true);

    // 构造返回结构：直接使用数组（每项含 timestamp 与 summary）
    const userData: { timestamp: number; summary: Record<string, any> }[] = [];
    const chatData: { timestamp: number; summary: Record<string, any> }[] = [];
    const appData: { timestamp: number; summary: Record<string, any> }[] = [];

    let cumulativeUsers = 0;
    let cumulativeChats = 0;
    let cumulativePoints = 0;
    let cumulativeGood = 0;
    let cumulativeBad = 0;

    for (const item of aggResult) {
      const ts = dayStrToTimestamp(item.day);

      // user summary：前端可能访问 userCount/newUserCount/retentionUserCount/points/sourceCountMap
      const userSummary = {
        userCount: item.userCount || 0,
        newUserCount: 0,
        retentionUserCount: 0,
        points: item.totalPoints || 0,
        sourceCountMap: {} // 若需更细粒度可增加针对 source 的聚合
      };

      // chat summary：前端会访问 chatItemCount/chatCount/pointsPerChat/errorCount/errorRate/avgDuration
      const chatSummary = {
        chatItemCount: item.chatItemCount || 0,
        chatCount: item.chatCount || 0,
        points: item.totalPoints || 0,
        errorCount: item.errorCount || 0,
        errorRate: 0,
        pointsPerChat: item.chatCount
          ? Number(((item.totalPoints || 0) / item.chatCount).toFixed(2))
          : 0,
        averageResponseTime:
          item.chatItemCount && item.chatItemCount > 0
            ? item.totalResponseTime / item.chatItemCount
            : 0
      };

      // app summary：前端会访问 goodFeedBackCount/badFeedBackCount/totalPoints/pointsPerChat/avgDuration
      const appSummary = {
        goodFeedBackCount: item.goodFeedBackCount || 0,
        badFeedBackCount: item.badFeedBackCount || 0,
        totalPoints: item.totalPoints || 0,
        pointsPerChat: item.chatCount
          ? Number(((item.totalPoints || 0) / item.chatCount).toFixed(2))
          : 0,
        avgDuration:
          item.chatItemCount && item.chatItemCount > 0
            ? item.totalResponseTime / item.chatItemCount
            : 0
      };

      cumulativeUsers += userSummary.userCount || 0;
      cumulativeChats += chatSummary.chatCount || 0;
      cumulativePoints += appSummary.totalPoints || 0;
      cumulativeGood += appSummary.goodFeedBackCount || 0;
      cumulativeBad += appSummary.badFeedBackCount || 0;

      userData.push({ timestamp: ts, summary: userSummary });
      chatData.push({ timestamp: ts, summary: chatSummary });
      appData.push({ timestamp: ts, summary: appSummary });
    }

    const response: getChartDataResponse = {
      // 直接使用数组，匹配前端 processChartData 的输入期望
      userData,
      chatData,
      appData
    } as any;

    return res.status(200).json({ code: 200, data: response });
  } catch (error) {
    console.error('getChartData error', error);
    return res.status(500).json({ code: 500, message: 'internal error', error });
  }
}

export default NextAPI(handler);
