import type { ApiRequestProps, ApiResponseType } from '@fastgpt/service/type/next';
import { MongoOutLink } from '@fastgpt/service/support/outLink/schema';
import type { OffiAccountAppType, OutLinkSchema } from '@fastgpt/global/support/outLink/type';
import { addLog } from '@fastgpt/service/common/system/log';
import { MongoApp } from '@fastgpt/service/core/app/schema';
import { dispatchWorkFlow } from '@fastgpt/service/core/workflow/dispatch';
import {
  storeNodes2RuntimeNodes,
  storeEdges2RuntimeEdges,
  getWorkflowEntryNodeIds
} from '@fastgpt/global/core/workflow/runtime/utils';
import { getAppLatestVersion } from '@fastgpt/service/core/app/version/controller';
import { getUserChatInfoAndAuthTeamPoints } from '@fastgpt/service/support/permission/auth/team';
import { getRunningUserInfoByTmbId } from '@fastgpt/service/support/user/team/utils';
import { WORKFLOW_MAX_RUN_TIMES } from '@fastgpt/service/core/workflow/constants';
import crypto from 'crypto';

export type OutLinkOffiAccountQuery = any;
export type OutLinkOffiAccountBody = any;
export type OutLinkOffiAccountResponse = {};

// 消息去重缓存
const processedMessageIds: Map<string, number> = new Map();
const MESSAGE_ID_CACHE_DURATION = 10 * 60 * 1000; // 10分钟

// 被动回复超时时间（微信要求5秒内响应，留0.5秒余量）
const PASSIVE_REPLY_TIMEOUT = 4500;

/**
 * 检查消息是否已处理
 */
function isMessageProcessed(msgId: string): boolean {
  const now = Date.now();

  // 清理过期记录
  for (const [id, timestamp] of processedMessageIds.entries()) {
    if (now - timestamp > MESSAGE_ID_CACHE_DURATION) {
      processedMessageIds.delete(id);
    }
  }

  if (processedMessageIds.has(msgId)) {
    return true;
  }

  processedMessageIds.set(msgId, now);
  return false;
}

/**
 * 解析微信公众号 XML 消息
 */
function parseWechatXmlMessage(xml: string): Record<string, any> {
  const result: Record<string, any> = {};

  let xmlContent = xml;
  const xmlMatch = /<xml>([\s\S]*?)<\/xml>/i.exec(xml);
  if (xmlMatch) {
    xmlContent = xmlMatch[1];
  }

  const regex = /<(\w+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/g;
  let match;

  while ((match = regex.exec(xmlContent)) !== null) {
    const key = match[1];
    if (key.toLowerCase() === 'xml') continue;
    let value = match[2] !== undefined ? match[2] : match[3] || '';
    result[key] = value.trim();
  }

  addLog.info('Parsed wechat XML message', { keys: Object.keys(result) });
  return result;
}

/**
 * 构建被动回复 XML 消息
 */
function buildReplyXml(toUser: string, fromUser: string, content: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${timestamp}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
}

/**
 * 清理 AI 回复内容，移除 Markdown 格式
 */
function cleanResponseContent(content: string): string {
  if (!content) return content;

  let cleaned = content;

  cleaned = cleaned.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/```(\w+)?\n?/g, '').replace(/```$/g, '');
  });

  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/_([^_]+)_/g, '$1');
  cleaned = cleaned.replace(/~~([^~]+)~~/g, '$1');
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  cleaned = cleaned.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[图片: $1]');
  cleaned = cleaned.replace(/^#+\s+/gm, '');
  cleaned = cleaned.replace(/^[\*\-\+]\s+/gm, '• ');
  cleaned = cleaned.replace(/^>\s+/gm, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * 带超时的 Promise
 */
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutValue: T): Promise<T> {
  const timeout = new Promise<T>((resolve) => {
    setTimeout(() => resolve(timeoutValue), ms);
  });
  return Promise.race([promise, timeout]);
}

async function handler(
  req: ApiRequestProps<OutLinkOffiAccountBody, OutLinkOffiAccountQuery>,
  res: ApiResponseType<any>
): Promise<any> {
  try {
    const { token: shareId, signature, timestamp, nonce, echostr } = req.query;

    if (!shareId) {
      res.status(400).send('Missing shareId');
      return;
    }

    addLog.info('OffiAccount received request', {
      shareId,
      method: req.method,
      hasSignature: !!signature,
      hasEchoStr: !!echostr
    });

    // 获取 outLink 配置
    const outLink = await MongoOutLink.findOne({ shareId }).lean<
      OutLinkSchema<OffiAccountAppType>
    >();
    if (!outLink || !outLink.app) {
      addLog.error('OutLink not found', { shareId });
      res.status(400).send('Configuration not found');
      return;
    }

    const { CallbackToken } = outLink.app;

    if (!CallbackToken) {
      addLog.error('Missing CallbackToken', { shareId });
      res.status(400).send('Missing configuration');
      return;
    }

    // 1. URL 验证（GET 请求）
    if (echostr && signature && timestamp && nonce) {
      const tmpArr = [CallbackToken, timestamp as string, nonce as string].sort();
      const tmpStr = tmpArr.join('');
      const hash = crypto.createHash('sha1').update(tmpStr).digest('hex');

      if (hash !== signature) {
        addLog.error('URL verification signature mismatch', {
          expected: hash,
          received: signature
        });
        res.status(403).send('Invalid signature');
        return;
      }

      addLog.info('OffiAccount URL verification success', { shareId });
      res.send(echostr);
      return;
    }

    // 2. 消息处理（POST 请求）
    let body = req.body;

    if (Buffer.isBuffer(body)) {
      body = body.toString('utf8');
    }

    if (!body) {
      res.status(200).send('success');
      return;
    }

    addLog.info('OffiAccount message received', {
      shareId,
      bodyType: typeof body,
      bodyPreview:
        typeof body === 'string' ? body.substring(0, 300) : JSON.stringify(body).substring(0, 300)
    });

    // 解析 XML 消息
    let message: Record<string, any>;
    if (typeof body === 'string') {
      message = parseWechatXmlMessage(body);
    } else if (typeof body === 'object' && body.xml) {
      message = body.xml;
    } else {
      message = body;
    }

    const msgType = message.MsgType;
    const msgId = message.MsgId || '';
    const fromUser = message.FromUserName || '';
    const toUser = message.ToUserName || '';

    addLog.info('Process offiaccount message', {
      msgType,
      msgId,
      fromUser: fromUser.substring(0, 10) + '...'
    });

    // 处理事件消息（关注等）
    if (msgType === 'event') {
      const event = message.Event;
      addLog.info('OffiAccount event received', { event, fromUser });

      if (event === 'subscribe') {
        const welcomeMsg = outLink.immediateResponse || '欢迎关注！有什么可以帮您的吗？';
        const replyXml = buildReplyXml(fromUser, toUser, welcomeMsg);
        res.setHeader('Content-Type', 'application/xml');
        res.status(200).send(replyXml);
        return;
      }

      res.status(200).send('success');
      return;
    }

    // 处理文本消息
    if (msgType === 'text') {
      const userMessage = message.Content || '';

      if (!userMessage.trim()) {
        res.status(200).send('success');
        return;
      }

      // 消息去重
      if (msgId && isMessageProcessed(msgId)) {
        addLog.info('Message already processed, skip', { msgId });
        res.status(200).send('success');
        return;
      }

      // 未认证公众号：使用被动回复，需要在5秒内返回结果
      try {
        const responseText = await withTimeout(
          processChat(outLink, userMessage, fromUser),
          PASSIVE_REPLY_TIMEOUT,
          null // 超时返回 null
        );

        let finalResponse: string;
        if (responseText === null) {
          // 超时
          finalResponse =
            outLink.defaultResponse ||
            '您的问题正在处理中，由于回复时间较长，请稍后再次发送消息获取回复。';
          addLog.warn('OffiAccount response timeout, using default message', {
            fromUser: fromUser.substring(0, 10) + '...'
          });
        } else {
          finalResponse = cleanResponseContent(responseText).substring(0, 2048);
        }

        const replyXml = buildReplyXml(fromUser, toUser, finalResponse);
        res.setHeader('Content-Type', 'application/xml');
        res.status(200).send(replyXml);

        addLog.info('OffiAccount passive reply sent', {
          fromUser: fromUser.substring(0, 10) + '...',
          responseLength: finalResponse.length,
          isTimeout: responseText === null
        });
      } catch (error) {
        addLog.error('OffiAccount process error', {
          error: error instanceof Error ? error.message : String(error)
        });

        const errorResponse = outLink.defaultResponse || '处理请求时发生错误，请稍后重试。';
        const replyXml = buildReplyXml(fromUser, toUser, errorResponse);
        res.setHeader('Content-Type', 'application/xml');
        res.status(200).send(replyXml);
      }

      return;
    }

    // 其他类型消息
    res.status(200).send('success');
  } catch (error) {
    addLog.error('OffiAccount handler error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : ''
    });
    res.status(200).send('success');
  }
}

/**
 * 处理聊天（不发送消息，只返回结果）
 */
async function processChat(
  outLink: OutLinkSchema<OffiAccountAppType>,
  userMessage: string,
  openId: string
): Promise<string> {
  addLog.info('Start chat processing for offiaccount', {
    openId: openId.substring(0, 10) + '...',
    userMessage: userMessage.substring(0, 50),
    appId: outLink.appId
  });

  // 获取应用信息
  const app = await MongoApp.findById(outLink.appId).lean();
  if (!app) throw new Error('App not found');

  const { nodes, edges, chatConfig } = await getAppLatestVersion(app._id, app);
  const { timezone, externalProvider } = await getUserChatInfoAndAuthTeamPoints(outLink.tmbId);
  const runningUserInfo = await getRunningUserInfoByTmbId(outLink.tmbId);

  const runtimeNodes = storeNodes2RuntimeNodes(nodes, getWorkflowEntryNodeIds(nodes));
  const runtimeEdges = storeEdges2RuntimeEdges(edges);

  // 模拟响应对象
  const mockRes: any = {
    finished: false,
    writableEnded: false,
    headersSent: false,
    setHeader: () => {},
    getHeader: () => {},
    write: () => true,
    end: () => {},
    on: () => {},
    once: () => {},
    emit: () => {},
    status: () => mockRes,
    send: () => mockRes,
    json: () => mockRes
  };

  const workflowParams = {
    res: mockRes,
    lang: 'zh-CN' as any,
    requestOrigin: '',
    mode: 'chat' as any,
    timezone,
    externalProvider,
    runningAppInfo: {
      id: String(app._id),
      teamId: String(app.teamId),
      tmbId: String(app.tmbId)
    },
    runningUserInfo,
    uid: openId,
    runtimeNodes,
    runtimeEdges,
    variables: {},
    query: [{ type: 'text' as const, text: { content: userMessage } }] as any,
    chatConfig,
    histories: [],
    stream: false,
    retainDatasetCite: false,
    maxRunTimes: WORKFLOW_MAX_RUN_TIMES
  };

  // 执行工作流
  const result: any = await dispatchWorkFlow(workflowParams as any);
  const assistantResponses = result.assistantResponses || [];

  let responseText = '';
  for (const response of assistantResponses) {
    if (response.type === 'text' && response.text?.content) {
      responseText += response.text.content;
    }
  }

  if (!responseText && outLink.defaultResponse) {
    responseText = outLink.defaultResponse;
  } else if (!responseText) {
    responseText = '抱歉，我暂时无法处理您的请求。';
  }

  addLog.info('Chat processing completed', {
    openId: openId.substring(0, 10) + '...',
    responseLength: responseText.length
  });

  return responseText;
}

export default handler;
