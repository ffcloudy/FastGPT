/**
 * 本地实现：GET 接口 /api/core/app/logs/getTotalData
 * - 返回 totalUsers / totalChats / totalPoints（用于界面上的总览卡片）
 * - 使用 authApp 做鉴权
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { NextAPI } from '@/service/middleware/entry';
import { Types } from '@fastgpt/service/common/mongo';
import { MongoAppChatLog } from '@fastgpt/service/core/app/logs/chatLogsSchema';
import { authApp } from '@fastgpt/service/support/permission/app/auth';
import { AppReadChatLogPerVal } from '@fastgpt/global/support/permission/app/constant';
import type { getTotalDataResponse } from '@fastgpt/global/core/app/logs/api';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { appId } = req.query as { appId?: string };

    if (!appId) {
      return res.status(400).json({ code: 400, message: 'missing appId' });
    }

    const { teamId } = await authApp({
      req,
      authToken: true,
      appId,
      per: AppReadChatLogPerVal
    });

    const match = {
      teamId: new Types.ObjectId(teamId),
      appId: new Types.ObjectId(appId)
    };

    // 聚合 totalChats / totalPoints / distinct users / totalMessages
    const agg = await MongoAppChatLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalChats: { $sum: 1 },
          totalPoints: { $sum: { $ifNull: ['$totalPoints', 0] } },
          users: { $addToSet: '$userId' },
          totalMessages: { $sum: { $ifNull: ['$chatItemCount', 0] } }
        }
      },
      {
        $project: {
          _id: 0,
          totalChats: 1,
          totalPoints: 1,
          totalUsers: { $size: '$users' },
          totalMessages: 1
        }
      }
    ]);

    const result = agg[0] || { totalChats: 0, totalPoints: 0, totalUsers: 0, totalMessages: 0 };

    const response: getTotalDataResponse = {
      totalUsers: result.totalUsers || 0,
      totalChats: result.totalChats || 0,
      totalPoints: result.totalPoints || 0,
      totalMessages: result.totalMessages || 0
    };

    return res.status(200).json({ code: 200, data: response });
  } catch (error) {
    console.error('getTotalData error', error);
    return res.status(500).json({ code: 500, message: 'internal error', error });
  }
}

export default NextAPI(handler);
