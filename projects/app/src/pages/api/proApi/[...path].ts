import type { NextApiRequest, NextApiResponse } from 'next';
import { jsonRes } from '@fastgpt/service/common/response';

import { request } from 'http';
import { FastGPTProUrl } from '@fastgpt/service/common/system/constants';

// 为关键功能提供默认数据
function getDefaultProApiData(path: string[], method: string) {
  const apiPath = path.join('/');

  switch (apiPath) {
    // 系统插件组配置
    case 'core/app/plugin/getPluginGroups':
      return [
        {
          groupId: 'systemPlugin',
          groupAvatar: 'core/app/type/pluginLight',
          groupName: 'common:core.module.template.System Plugin',
          groupOrder: 0,
          groupTypes: [
            { typeId: 'tools', typeName: 'app:tool_type_tools' },
            { typeId: 'search', typeName: 'app:tool_type_search' },
            { typeId: 'multimodal', typeName: 'app:tool_type_multimodal' },
            { typeId: 'productivity', typeName: 'app:tool_type_productivity' },
            { typeId: 'scientific', typeName: 'app:tool_type_scientific' },
            { typeId: 'finance', typeName: 'app:tool_type_finance' },
            { typeId: 'design', typeName: 'app:tool_type_design' },
            { typeId: 'news', typeName: 'app:tool_type_news' },
            { typeId: 'entertainment', typeName: 'app:tool_type_entertainment' },
            { typeId: 'communication', typeName: 'app:tool_type_communication' },
            { typeId: 'social', typeName: 'app:tool_type_social' },
            { typeId: 'other', typeName: 'common:Other' }
          ]
        }
      ];

    // 应用模板类型 - typeId 需要与本地模板的 tags 格式匹配（使用短横线）
    case 'core/app/template/getTemplateTypes':
      return [
        {
          typeName: 'common:templateTags.Writing',
          typeId: 'writing',
          typeOrder: 0
        },
        {
          typeName: 'common:templateTags.Image_generation',
          typeId: 'image-generation',
          typeOrder: 1
        },
        {
          typeName: 'common:templateTags.Web_search',
          typeId: 'web-search',
          typeOrder: 2
        },
        {
          typeName: 'common:templateTags.Roleplay',
          typeId: 'roleplay',
          typeOrder: 3
        },
        {
          typeName: 'common:templateTags.Office_services',
          typeId: 'office-services',
          typeOrder: 4
        }
      ];

    // 模板市场列表 - 不需要在这里返回，前端会调用本地 API /core/app/template/list
    case 'core/app/template/getTemplateList':
      return [];

    // 用户通知相关
    case 'support/user/inform/getSystemMsgModal':
      return null; // 没有系统通知弹窗
    case 'support/user/inform/countUnread':
      return { count: 0 };

    // 聊天设置详情
    case 'core/chat/setting/detail':
      return null; // 使用默认设置

    // 团队相关
    case 'support/user/team/list':
      return [];
    case 'support/user/team/member/list':
      return { total: 0, list: [] };
    case 'support/user/team/member/count':
      return { count: 0 };
    case 'support/user/team/plan/getTeamPlanStatus':
      return null;

    // 钱包使用情况
    case 'support/wallet/usage/getUsage':
      return { total: 0, list: [], totalPoints: 0 };

    // 评估相关
    case 'core/app/evaluation/list':
      return { total: 0, list: [] };

    // 数据集协作与标签（社区版默认空）
    case 'core/dataset/collaborator/list':
      return [];
    case 'core/dataset/tag/getAllTags':
      return { list: [] };

    default:
      return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { path = [], ...query } = req.query as any;
    const requestPath = `/api/${path?.join('/')}?${new URLSearchParams(query).toString()}`;

    if (!requestPath) {
      throw new Error('url is empty');
    }

    if (!FastGPTProUrl) {
      const apiPath = path.join('/');
      console.log(`🔄 商业版API调用: ${apiPath} [${req.method}]`);

      // 为常用功能提供默认数据，避免前端报错
      const supportedApis = [
        // 核心功能
        'core/app/plugin/getPluginGroups',
        'core/app/template/getTemplateTypes',
        'core/app/template/getTemplateList',
        'core/chat/setting/detail',
        'core/app/evaluation/list',
        // 数据集协作与标签（避免前端报错）
        'core/dataset/collaborator/list',
        'core/dataset/tag/getAllTags',
        // 用户通知
        'support/user/inform/getSystemMsgModal',
        'support/user/inform/countUnread',
        // 团队相关
        'support/user/team/list',
        'support/user/team/member/list',
        'support/user/team/plan/getTeamPlanStatus',
        // 钱包使用情况
        'support/wallet/usage/getUsage'
      ];

      if (supportedApis.includes(apiPath)) {
        const defaultData = getDefaultProApiData(path, req.method || 'GET');
        console.log(`✅ 返回默认数据 [${apiPath}]:`, defaultData);

        return jsonRes(res, {
          code: 200,
          data: defaultData
        });
      }

      // 其他API抛出错误，让前端知道需要配置商业版
      console.log(`⚠️ 未支持的API: ${apiPath}`);
      throw new Error(`未配置商业版链接: ${path.join('/')}`);
    }

    const parsedUrl = new URL(FastGPTProUrl);
    delete req.headers?.rootkey;

    const requestResult = request({
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: requestPath,
      method: req.method,
      headers: req.headers
    });
    req.pipe(requestResult);

    requestResult.on('response', (response) => {
      Object.keys(response.headers).forEach((key) => {
        // @ts-ignore
        res.setHeader(key, response.headers[key]);
      });
      response.statusCode && res.writeHead(response.statusCode);
      response.pipe(res);
    });

    requestResult.on('error', (e) => {
      res.send(e);
      res.end();
    });
  } catch (error) {
    jsonRes(res, {
      code: 500,
      error
    });
  }
}

export const config = {
  api: {
    bodyParser: false
  }
};
