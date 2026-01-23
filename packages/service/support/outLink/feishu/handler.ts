import axios from 'axios';
import crypto from 'crypto';
import type { FeishuAppType, OutLinkSchema } from '@fastgpt/global/support/outLink/type';
import { MongoOutLink } from '../schema';
import { addLog } from '../../../common/system/log';

interface FeishuEventHeader {
  event_id: string;
  event_type: string;
  app_id: string;
  tenant_key: string;
  create_time: string;
  token: string;
}

interface FeishuEvent {
  schema: string;
  header: FeishuEventHeader;
  event: {
    message?: {
      chat_id: string;
      chat_type: string;
      message_id: string;
      content: string;
      message_type: string;
    };
    sender?: {
      sender_id: {
        open_id: string;
        user_id: string;
      };
    };
  };
}

interface FeishuChallenge {
  challenge?: string;
  token?: string;
  type?: string;
}

interface FeishuEncryptedRequest {
  encrypt?: string;
}

/**
 * 验证飞书请求签名
 */
export function verifyFeishuSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string,
  signature: string
): boolean {
  if (!encryptKey) {
    // 如果没有配置加密密钥，跳过验证
    return true;
  }

  const signString = `${timestamp}${nonce}${encryptKey}${body}`;
  const hash = crypto.createHash('sha256').update(signString).digest('hex');

  return hash === signature;
}

/**
 * 解密飞书消息
 * 参考: https://open.feishu.cn/document/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 */
export function decryptFeishuMessage(encrypt: string, encryptKey: string): string {
  if (!encryptKey || !encrypt) {
    return encrypt;
  }

  try {
    // 1. 使用 SHA256 对 encrypt_key 进行哈希得到32字节的密钥
    const key = crypto.createHash('sha256').update(encryptKey).digest();

    // 2. 使用密钥的前16字节作为 IV
    const iv = key.subarray(0, 16);

    // 3. Base64 解码加密内容
    const encryptData = Buffer.from(encrypt, 'base64');

    // 4. 使用 AES-256-CBC 解密
    const decipher = crypto.createDecipheriv('aes-256-cbc', key as any, iv as any);
    decipher.setAutoPadding(true);

    const decryptedParts: any[] = [];
    decryptedParts.push(decipher.update(encryptData as any));
    decryptedParts.push(decipher.final());
    const decrypted = Buffer.concat(decryptedParts as any);

    // 5. 转换为字符串并清理
    let result = decrypted.toString('utf8');

    // 6. 移除可能的 BOM 和控制字符
    result = result.trim();
    if (result.charCodeAt(0) === 0xfeff) {
      result = result.substring(1);
    }

    return result;
  } catch (error) {
    addLog.error('Decrypt feishu message error', error);
    throw error;
  }
}

/**
 * 安全解析 JSON（处理飞书可能的格式异常）
 */
function safeJsonParse(jsonString: string, context: string = ''): any {
  try {
    // 1. 基本清理
    let cleaned = jsonString.trim();

    // 2. 移除 UTF-8 BOM
    if (cleaned.charCodeAt(0) === 0xfeff) {
      cleaned = cleaned.substring(1);
    }

    // 3. 检查是否有多个连续的 JSON 对象
    // 飞书标准格式应该是单个 JSON 对象
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace > 0) {
      addLog.warn(`JSON has leading characters in ${context}`, {
        leading: cleaned.substring(0, firstBrace)
      });
      cleaned = cleaned.substring(firstBrace);
    }

    // 4. 尝试解析
    const parsed = JSON.parse(cleaned);

    return parsed;
  } catch (error) {
    // 记录详细的错误信息用于调试
    const errorMessage = error instanceof Error ? error.message : String(error);
    addLog.error(`JSON parse failed in ${context}`, {
      error: errorMessage,
      preview: jsonString.substring(0, 200),
      length: jsonString.length,
      firstChars: Array.from(jsonString.substring(0, 10))
        .map((c) => `'${c}'(${c.charCodeAt(0)})`)
        .join(' '),
      lastChars: Array.from(jsonString.substring(Math.max(0, jsonString.length - 10)))
        .map((c) => `'${c}'(${c.charCodeAt(0)})`)
        .join(' ')
    });
    throw new Error(`Failed to parse JSON in ${context}: ${errorMessage}`);
  }
}

/**
 * 获取飞书访问令牌
 */
async function getFeishuAccessToken(appId: string, appSecret: string): Promise<string> {
  try {
    const response = await axios.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: appId,
        app_secret: appSecret
      }
    );

    if (response.data.code === 0) {
      return response.data.tenant_access_token;
    }

    throw new Error(`Get feishu access token failed: ${response.data.msg}`);
  } catch (error) {
    addLog.error('Get feishu access token error', error);
    throw error;
  }
}

/**
 * 发送飞书消息
 */
async function sendFeishuMessage(
  accessToken: string,
  openId: string,
  content: string
): Promise<void> {
  try {
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages',
      {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text: content })
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        params: {
          receive_id_type: 'open_id'
        }
      }
    );
  } catch (error) {
    addLog.error('Send feishu message error', error);
    throw error;
  }
}

/**
 * 处理飞书事件
 */
export async function handleFeishuEvent(
  shareId: string,
  body: FeishuChallenge | FeishuEvent | FeishuEncryptedRequest,
  headers: Record<string, string>
): Promise<any> {
  // 获取 outLink 配置
  const outLink = await MongoOutLink.findOne({ shareId }).lean<OutLinkSchema<FeishuAppType>>();
  if (!outLink || !outLink.app) {
    throw new Error('OutLink not found or not configured');
  }

  const { appId, appSecret, encryptKey, verificationToken } = outLink.app;

  // 处理加密请求
  // 飞书加密配置文档: https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
  if ('encrypt' in body && body.encrypt) {
    addLog.info('Received encrypted feishu request');

    if (!encryptKey) {
      throw new Error('Encrypt key is required for encrypted requests');
    }

    try {
      // 验证签名（对加密内容验证）
      const timestamp = headers['x-lark-request-timestamp'] || '';
      const nonce = headers['x-lark-request-nonce'] || '';
      const signature = headers['x-lark-signature'] || '';

      // 签名验证：使用加密后的字符串
      const signString = `${timestamp}${nonce}${encryptKey}${body.encrypt}`;
      const hash = crypto.createHash('sha256').update(signString).digest('hex');

      if (signature && hash !== signature) {
        addLog.error('Signature verification failed', {
          expected: hash,
          received: signature
        });
        throw new Error('Invalid signature for encrypted request');
      }

      // 解密
      const decrypted = decryptFeishuMessage(body.encrypt, encryptKey);
      addLog.info('Decrypted feishu message successfully', {
        length: decrypted.length,
        preview: decrypted.substring(0, 100)
      });

      // 解析解密后的内容（使用安全解析）
      const decryptedBody = safeJsonParse(decrypted, 'encrypted message');

      // 如果是 URL 验证（challenge），直接返回
      if (decryptedBody.type === 'url_verification' && decryptedBody.challenge) {
        addLog.info('URL verification challenge received (encrypted)', {
          challenge: decryptedBody.challenge
        });
        return { challenge: decryptedBody.challenge };
      }

      // 验证 token（如果配置了）
      if (verificationToken && decryptedBody.token !== verificationToken) {
        throw new Error('Invalid verification token in decrypted request');
      }

      // 递归处理解密后的内容（处理事件消息）
      return handleFeishuEvent(shareId, decryptedBody, headers);
    } catch (e) {
      addLog.error('Failed to handle encrypted request', e);
      throw e;
    }
  }

  // 处理 URL 验证（未加密或已解密）
  if ('challenge' in body && body.challenge) {
    addLog.info('Feishu URL verification, returning challenge');
    return { challenge: body.challenge };
  }

  // 类型守卫：确保是 FeishuEvent
  if (!('header' in body)) {
    return { success: true };
  }

  // 现在 TypeScript 知道 body 是 FeishuEvent 类型
  const event = body as FeishuEvent;

  // 验证 token
  if (verificationToken && event.header?.token !== verificationToken) {
    throw new Error('Invalid verification token');
  }

  // 验证签名（仅在配置了加密且提供了签名时验证）
  const timestamp = headers['x-lark-request-timestamp'] || '';
  const nonce = headers['x-lark-request-nonce'] || '';
  const signature = headers['x-lark-signature'] || '';

  // 只有在配置了 encryptKey 且飞书发送了签名时才验证
  // 对于本地测试或未加密场景，如果没有提供签名则跳过验证
  if (encryptKey && signature) {
    const bodyStr = JSON.stringify(body);
    if (!verifyFeishuSignature(timestamp, nonce, encryptKey, bodyStr, signature)) {
      addLog.error('Signature verification failed', {
        timestamp,
        nonce,
        signature,
        bodyPreview: bodyStr.substring(0, 100)
      });
      throw new Error('Invalid signature');
    }
  }

  // 处理消息事件
  if (event.header?.event_type === 'im.message.receive_v1') {
    const message = event.event?.message;
    const sender = event.event?.sender;

    if (!message || !sender) {
      return { success: true };
    }

    // 解析消息内容
    let userMessage = '';
    if (message.message_type === 'text') {
      try {
        const content = safeJsonParse(message.content, 'message content');
        userMessage = content.text || '';
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        addLog.warn('Failed to parse message content as JSON, using raw text', {
          content: message.content.substring(0, 100),
          error: errorMessage
        });
        userMessage = message.content;
      }
    }

    if (!userMessage.trim()) {
      return { success: true };
    }

    const openId = sender.sender_id.open_id;

    // 发送即时响应（如果配置了）
    if (outLink.immediateResponse) {
      const accessToken = await getFeishuAccessToken(appId, appSecret);
      await sendFeishuMessage(accessToken, openId, outLink.immediateResponse);
    }

    // 这里需要调用聊天 API 处理消息
    // 但由于这是服务层，实际的调用应该在 API 层完成
    // 返回需要处理的消息信息
    return {
      success: true,
      needProcess: true,
      messageInfo: {
        userMessage,
        openId,
        chatId: message.chat_id,
        messageId: message.message_id
      }
    };
  }

  return { success: true };
}

/**
 * 发送飞书响应消息
 */
export async function sendFeishuResponse(
  outLink: OutLinkSchema<FeishuAppType>,
  openId: string,
  response: string
): Promise<void> {
  if (!outLink.app) {
    throw new Error('Feishu app not configured');
  }

  const { appId, appSecret } = outLink.app;
  const accessToken = await getFeishuAccessToken(appId, appSecret);
  await sendFeishuMessage(accessToken, openId, response);
}
