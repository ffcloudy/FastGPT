import type { ApiRequestProps, ApiResponseType } from '@fastgpt/service/type/next';
import {
  handleWecomEvent,
  sendWecomResponse,
  sendAiBotResponse,
  cleanResponseContent,
  encryptStreamResponse,
  globalStreamManager
} from '@fastgpt/service/support/outLink/wecom/handler';
import { MongoOutLink } from '@fastgpt/service/support/outLink/schema';
import type { WecomAppType, OutLinkSchema } from '@fastgpt/global/support/outLink/type';
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

export type OutLinkWecomQuery = any;
export type OutLinkWecomBody = any;
export type OutLinkWecomResponse = {};

async function handler(
  req: ApiRequestProps<OutLinkWecomBody, OutLinkWecomQuery>,
  res: ApiResponseType<any>
): Promise<any> {
  try {
    const { token: shareId, msg_signature, timestamp, nonce, echostr } = req.query;

    if (!shareId) {
      res.status(400).send('Missing shareId');
      return;
    }

    const query: Record<string, string> = {
      msg_signature: (msg_signature as string) || '',
      timestamp: (timestamp as string) || '',
      nonce: (nonce as string) || '',
      echostr: (echostr as string) || ''
    };

    // 核心修复：统一处理 Encrypt/encrypt 字段（兼容大小写和 XML/JSON）
    let encryptContent = '';
    const rawBody = req.body || {};

    // 场景1：body 是 JSON 对象（可能是小写 encrypt 或大写 Encrypt）
    if (typeof rawBody === 'object') {
      encryptContent = rawBody.Encrypt || rawBody.encrypt || '';
    }
    // 场景2：body 是 XML 字符串（企业微信默认推送格式）
    else if (typeof rawBody === 'string') {
      // 正则提取 Encrypt 字段
      const encryptMatch = rawBody.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
      encryptContent = encryptMatch ? encryptMatch[1] : '';
    }

    // 统一规范化为大写 Encrypt，确保 handler 能正确识别
    const body = encryptContent ? { Encrypt: encryptContent } : rawBody;

    addLog.info('Wecom received request', {
      shareId,
      bodyType: typeof req.body,
      bodyPreview:
        typeof req.body === 'string'
          ? req.body.substring(0, 200)
          : JSON.stringify(req.body).substring(0, 200),
      encryptContent: encryptContent.substring(0, 50) + '...',
      hasEncrypt: !!encryptContent
    });

    let result;
    try {
      result = await handleWecomEvent(shareId, body, query);
    } catch (decryptError) {
      addLog.error('Wecom decrypt error', {
        shareId,
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
        stack: decryptError instanceof Error ? decryptError.stack : ''
      });
      res.status(200).send('success');
      res.end();
      return;
    }

    // 1. 如果是 URL 验证，直接返回解密后的 echostr
    if (typeof result === 'string' && echostr) {
      res.send(result);
      res.end();
      return;
    }

    // ============ 2. 智能机器人流式响应 ============
    // 根据官方 demo：需要加密响应，Content-Type 为 text/plain
    // 关键：智能机器人的 receiveid 是空字符串！
    if (result && typeof result === 'object' && result.isStreamResponse) {
      const { streamResponse, msgCrypt, needProcess, messageInfo } = result;

      // 加密流式响应（智能机器人用空字符串作为 receiverId）
      const encryptedResponse = encryptStreamResponse(
        msgCrypt,
        streamResponse,
        query.nonce,
        query.timestamp
      );

      // 返回加密后的流式响应（Content-Type: text/plain）
      res.setHeader('Content-Type', 'text/plain');
      res.status(200).send(encryptedResponse);
      res.end();

      addLog.info('Sent encrypted stream response to wecom', {
        streamId: streamResponse.stream.id,
        finish: streamResponse.stream.finish,
        contentLength: streamResponse.stream.content.length,
        encryptedLength: encryptedResponse.length,
        needProcess
      });

      // 如果需要处理（初始消息），启动异步工作流
      if (needProcess && messageInfo) {
        const { userMessage, userId, streamId } = messageInfo;

        const outLink = await MongoOutLink.findOne({ shareId }).lean<OutLinkSchema<WecomAppType>>();
        if (!outLink) {
          addLog.error('OutLink not found', { shareId });
          // 追加错误消息并结束流
          await globalStreamManager.appendContent(streamId, '配置错误，无法处理请求。', true);
          return;
        }

        // 异步执行工作流，结果追加到累积内容
        processStreamChat(shareId, outLink, userMessage, userId, streamId).catch((err) => {
          addLog.error('Process stream chat error', err);
          // 追加错误消息并结束流
          globalStreamManager.appendContent(streamId, '\n\n抱歉，处理请求时发生错误。', true);
        });
      }

      return;
    }

    // ============ 3. 普通应用消息（非智能机器人） ============
    res.status(200).send('success');
    res.end();

    if (result && typeof result === 'object' && result.needProcess && result.messageInfo) {
      const { userMessage, userId } = result.messageInfo;

      if (!userMessage || !userId) {
        addLog.warn('Wecom message info invalid', { userMessage, userId });
        return;
      }

      const outLink = await MongoOutLink.findOne({ shareId }).lean<OutLinkSchema<WecomAppType>>();
      if (!outLink) {
        addLog.error('OutLink not found', { shareId });
        return;
      }

      addLog.info('Start process wecom chat (non-stream)', {
        shareId,
        userId,
        userMessage: userMessage.substring(0, 50)
      });

      // 异步处理普通应用消息
      processChatAndRespond(shareId, outLink, userMessage, userId).catch((err) => {
        addLog.error('Process wecom chat error', err);
      });
    }
  } catch (error) {
    addLog.error('Wecom handler error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : ''
    });
    res.status(200).send('success'); // 必须返回 200 + success
  }
}

/**
 * 处理聊天并响应（简化版：优先使用 response_url）
 */
async function processChatAndRespond(
  shareId: string,
  outLink: OutLinkSchema<WecomAppType>,
  userMessage: string,
  userId: string,
  responseUrl?: string
) {
  // 智能机器人使用 responseUrl 直接回复
  const isAiBot = !!responseUrl;

  try {
    // 验证配置完整性
    if (
      !isAiBot &&
      (!outLink.app || !outLink.app.CorpId || !outLink.app.SuiteSecret || !outLink.app.AgentId)
    ) {
      throw new Error('Wecom app config incomplete for application message');
    }

    addLog.info('Start internal chat processing', {
      shareId,
      userId,
      userMessage: userMessage.substring(0, 50),
      appId: outLink.appId,
      isAiBot,
      hasResponseUrl: !!responseUrl
    });

    // 注意：response_url 只能使用一次，不能先发"正在思考"再发最终回复
    // 所以直接执行工作流，最后一次性发送回复

    // 获取应用信息和配置
    const app = await MongoApp.findById(outLink.appId).lean();
    if (!app) throw new Error('App not found');

    const { nodes, edges, chatConfig } = await getAppLatestVersion(app._id, app);
    const { timezone, externalProvider } = await getUserChatInfoAndAuthTeamPoints(outLink.tmbId);
    const runningUserInfo = await getRunningUserInfoByTmbId(outLink.tmbId);

    const runtimeNodes = storeNodes2RuntimeNodes(nodes, getWorkflowEntryNodeIds(nodes));
    const runtimeEdges = storeEdges2RuntimeEdges(edges);

    // 执行工作流
    let responseText = '';

    // 模拟响应对象，防止 FastGPT 因为缺少 res 而跳过流式逻辑
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
      uid: userId,
      runtimeNodes,
      runtimeEdges,
      variables: {},
      query: [{ type: 'text' as const, text: { content: userMessage } }] as any,
      chatConfig,
      histories: [],
      stream: false, // 禁用流式，使用同步模式
      retainDatasetCite: false,
      maxRunTimes: WORKFLOW_MAX_RUN_TIMES
    };

    // 执行工作流（同步模式）
    const result: any = await dispatchWorkFlow(workflowParams as any);
    const assistantResponses = result.assistantResponses || [];

    for (const response of assistantResponses) {
      if (response.type === 'text' && response.text?.content) {
        responseText += response.text.content;
      }
    }

    // 如果没有响应内容，使用默认回复
    if (!responseText && outLink.defaultResponse) {
      responseText = outLink.defaultResponse;
    } else if (!responseText) {
      responseText = '抱歉，我暂时无法处理您的请求。';
    }

    // 清理 Markdown 并截断
    const finalResponse = cleanResponseContent(responseText).substring(0, 2048);

    // 发送最终响应
    if (isAiBot && responseUrl) {
      await sendAiBotResponse(responseUrl, finalResponse);
      addLog.info('Sent AI bot response via response_url', {
        userId,
        responseLength: finalResponse.length
      });
    } else {
      await sendWecomResponse(outLink, userId, finalResponse);
      addLog.info('Sent wecom app response', {
        userId,
        responseLength: finalResponse.length
      });
    }

    addLog.info('Chat processing completed', {
      userId,
      responseLength: responseText.length,
      isAiBot
    });
  } catch (error) {
    addLog.error('Process chat and respond error', {
      shareId,
      userId,
      error: error instanceof Error ? error.message : String(error)
    });

    // 发送错误回复
    if (outLink?.defaultResponse || true) {
      try {
        const errorResponse = cleanResponseContent(
          outLink?.defaultResponse || '处理请求时发生错误，请稍后重试。'
        ).substring(0, 2048);

        if (isAiBot && responseUrl) {
          await sendAiBotResponse(responseUrl, errorResponse);
        } else {
          await sendWecomResponse(outLink, userId, errorResponse);
        }
      } catch (e) {
        addLog.error('Send error response failed', e);
      }
    }
  }
}

/**
 * 处理流式聊天（智能机器人专用）
 *
 * 工作流程：
 * 1. 执行工作流
 * 2. 将结果推送到流式队列
 * 3. 企业微信通过轮询获取内容
 */
async function processStreamChat(
  shareId: string,
  outLink: OutLinkSchema<WecomAppType>,
  userMessage: string,
  userId: string,
  streamId: string
) {
  try {
    addLog.info('Start stream chat processing', {
      shareId,
      userId,
      userMessage: userMessage.substring(0, 50),
      streamId
    });

    // 获取应用信息和配置
    const app = await MongoApp.findById(outLink.appId).lean();
    if (!app) {
      await globalStreamManager.appendContent(streamId, '应用配置错误。', true);
      throw new Error('App not found');
    }

    const { nodes, edges, chatConfig } = await getAppLatestVersion(app._id, app);
    const { timezone, externalProvider } = await getUserChatInfoAndAuthTeamPoints(outLink.tmbId);
    const runningUserInfo = await getRunningUserInfoByTmbId(outLink.tmbId);

    const runtimeNodes = storeNodes2RuntimeNodes(nodes, getWorkflowEntryNodeIds(nodes));
    const runtimeEdges = storeEdges2RuntimeEdges(edges);

    // 工作流参数（同步模式，因为我们自己管理流式推送）
    const workflowParams = {
      res: null as any,
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
      uid: userId,
      runtimeNodes,
      runtimeEdges,
      variables: {},
      query: [{ type: 'text' as const, text: { content: userMessage } }] as any,
      chatConfig,
      histories: [],
      stream: false, // 使用同步模式
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

    // 如果没有响应内容，使用默认回复
    if (!responseText && outLink.defaultResponse) {
      responseText = outLink.defaultResponse;
    } else if (!responseText) {
      responseText = '抱歉，我暂时无法处理您的请求。';
    }

    addLog.info('Stream chat workflow completed', {
      userId,
      streamId,
      responseLength: responseText.length
    });

    // 追加最终内容到累积内容（流式消息支持 Markdown）
    // 注意：这会追加到之前的 <think>...</think> 后面
    await globalStreamManager.appendContent(streamId, responseText, true);

    addLog.info('Stream chat processing completed', {
      userId,
      streamId,
      responseLength: responseText.length
    });
  } catch (error) {
    addLog.error('Process stream chat error', {
      shareId,
      userId,
      streamId,
      error: error instanceof Error ? error.message : String(error)
    });

    // 追加错误消息并结束流
    await globalStreamManager.appendContent(
      streamId,
      '\n\n' + (outLink?.defaultResponse || '处理请求时发生错误，请稍后重试。'),
      true // is_final
    );
  }
}

export default handler;
