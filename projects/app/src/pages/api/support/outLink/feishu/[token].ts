import type { ApiRequestProps, ApiResponseType } from '@fastgpt/service/type/next';
import {
  handleFeishuEvent,
  sendFeishuResponse
} from '@fastgpt/service/support/outLink/feishu/handler';
import { MongoOutLink } from '@fastgpt/service/support/outLink/schema';
import type { FeishuAppType, OutLinkSchema } from '@fastgpt/global/support/outLink/type';
import { addLog } from '@fastgpt/service/common/system/log';
import axios from 'axios';

export type OutLinkFeishuQuery = any;
export type OutLinkFeishuBody = any;
export type OutLinkFeishuResponse = {};

async function handler(
  req: ApiRequestProps<OutLinkFeishuBody, OutLinkFeishuQuery>,
  res: ApiResponseType<any>
): Promise<void> {
  try {
    const { token: shareId } = req.query;

    if (!shareId) {
      return res.status(400).json({ error: 'Missing shareId' });
    }

    const headers: Record<string, string> = {
      'x-lark-request-timestamp': (req.headers['x-lark-request-timestamp'] as string) || '',
      'x-lark-request-nonce': (req.headers['x-lark-request-nonce'] as string) || '',
      'x-lark-signature': (req.headers['x-lark-signature'] as string) || ''
    };

    const result = await handleFeishuEvent(shareId, req.body, headers);

    // 如果是 URL 验证，直接返回 challenge
    if (result.challenge) {
      return res.json(result);
    }

    // 如果需要处理消息，调用聊天 API
    if (result.needProcess && result.messageInfo) {
      const { userMessage, openId, chatId } = result.messageInfo;

      // 获取 outLink 配置
      const outLink = await MongoOutLink.findOne({ shareId }).lean<OutLinkSchema<FeishuAppType>>();

      if (outLink) {
        // 异步处理聊天请求
        processChatAndRespond(shareId, outLink, userMessage, openId, chatId).catch((err) => {
          addLog.error('Process feishu chat error', err);
        });
      }
    }

    return res.json({ success: true });
  } catch (error) {
    addLog.error('Feishu handler error', error);
    return res.status(500).json({ error: String(error) });
  }
}

/**
 * 处理聊天并响应
 */
async function processChatAndRespond(
  shareId: string,
  outLink: OutLinkSchema<FeishuAppType>,
  userMessage: string,
  openId: string,
  chatId?: string
) {
  try {
    // 调用聊天 API
    const chatResponse = await axios.post(
      `${process.env.NEXT_PUBLIC_DOMAIN || 'http://localhost:3000'}/api/v1/chat/completions`,
      {
        shareId,
        outLinkUid: openId,
        chatId: chatId || undefined,
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
    await sendFeishuResponse(outLink, openId, responseText);
  } catch (error) {
    addLog.error('Process chat and respond error', error);

    // 发送错误响应
    if (outLink.defaultResponse) {
      try {
        await sendFeishuResponse(outLink, openId, outLink.defaultResponse);
      } catch (e) {
        addLog.error('Send error response failed', e);
      }
    }
  }
}

export default handler;
