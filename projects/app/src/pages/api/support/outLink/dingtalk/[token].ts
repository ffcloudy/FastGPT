import type { ApiRequestProps, ApiResponseType } from '@fastgpt/service/type/next';
import {
  handleDingtalkEvent,
  sendDingtalkResponse
} from '@fastgpt/service/support/outLink/dingtalk/handler';
import { MongoOutLink } from '@fastgpt/service/support/outLink/schema';
import type { DingtalkAppType, OutLinkSchema } from '@fastgpt/global/support/outLink/type';
import { addLog } from '@fastgpt/service/common/system/log';
import axios from 'axios';
import { NextAPI } from '@/service/middleware/entry';

export type OutLinkDingtalkQuery = any;
export type OutLinkDingtalkBody = any;
export type OutLinkDingtalkResponse = {};

async function handler(
  req: ApiRequestProps<OutLinkDingtalkBody, OutLinkDingtalkQuery>,
  res: ApiResponseType<any>
): Promise<any> {
  if (req.method === 'GET') {
    return {
      success: true
    };
  }

  try {
    const { token: shareId } = req.query;

    if (!shareId) {
      return {
        success: false,
        error: 'Missing shareId'
      };
    }

    const headers: Record<string, string> = {
      timestamp: (req.headers.timestamp as string) || '',
      sign: (req.headers.sign as string) || ''
    };

    const result = await handleDingtalkEvent(shareId, req.body, headers);

    // 如果需要处理消息，调用聊天 API
    if (result.needProcess && result.messageInfo) {
      const { userMessage, conversationId, senderId } = result.messageInfo;

      // 获取 outLink 配置
      const outLink = await MongoOutLink.findOne({ shareId }).lean<
        OutLinkSchema<DingtalkAppType>
      >();

      if (outLink) {
        // 异步处理聊天请求
        processChatAndRespond(shareId, outLink, userMessage, conversationId, senderId).catch(
          (err) => {
            addLog.error('Process dingtalk chat error', err);
          }
        );
      }
    }

    return { success: true };
  } catch (error) {
    addLog.error('Dingtalk handler error', error);
    return {
      success: false,
      error: String(error)
    };
  }
}

/**
 * 处理聊天并响应
 */
async function processChatAndRespond(
  shareId: string,
  outLink: OutLinkSchema<DingtalkAppType>,
  userMessage: string,
  conversationId: string,
  senderId: string
) {
  try {
    // 调用聊天 API
    const chatResponse = await axios.post(
      `${process.env.NEXT_PUBLIC_DOMAIN || 'http://localhost:3000'}/api/v1/chat/completions`,
      {
        shareId,
        outLinkUid: senderId,
        stream: false,
        messages: [
          {
            role: 'user',
            content: userMessage
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    // 提取响应内容
    let responseText = '';
    if (chatResponse.data?.choices?.[0]?.message?.content) {
      responseText = chatResponse.data.choices[0].message.content;
    } else if (outLink.defaultResponse) {
      responseText = outLink.defaultResponse;
    } else {
      responseText = '抱歉，我暂时无法处理您的请求。';
    }

    // 发送响应给用户
    await sendDingtalkResponse(outLink, conversationId, responseText);
  } catch (error) {
    addLog.error('Process chat and respond error', error);

    // 发送错误响应
    if (outLink.defaultResponse) {
      try {
        await sendDingtalkResponse(outLink, conversationId, outLink.defaultResponse);
      } catch (e) {
        addLog.error('Send error response failed', e);
      }
    }
  }
}

export default NextAPI(handler);
