import axios from 'axios';
import crypto from 'crypto';
import type { OffiAccountAppType, OutLinkSchema } from '@fastgpt/global/support/outLink/type';
import { MongoOutLink } from '../schema';
import { addLog } from '../../../common/system/log';

/**
 * 微信公众号消息加解密
 * 参考: https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Message_Encryption_and_Decryption_Instructions.html
 */
class WXMsgCrypt {
  private token: string;
  private encodingAesKey: Buffer;
  private appId: string;
  private iv: Buffer;

  constructor(token: string, encodingAesKey: string, appId: string) {
    this.token = token;
    this.appId = appId;

    if (!encodingAesKey) {
      // 如果没有配置 AES Key，则不使用加密
      this.encodingAesKey = Buffer.alloc(0);
      this.iv = Buffer.alloc(0);
      return;
    }

    const cleanedKey = encodingAesKey.trim();

    if (cleanedKey.length !== 43) {
      addLog.error('Invalid encodingAesKey length', {
        originalLength: encodingAesKey.length,
        cleanedLength: cleanedKey.length,
        expected: 43
      });
      throw new Error(`Invalid encodingAesKey: expected 43 characters, got ${cleanedKey.length}`);
    }

    try {
      this.encodingAesKey = Buffer.from(cleanedKey + '=', 'base64');

      if (this.encodingAesKey.length !== 32) {
        throw new Error(
          `Invalid encodingAesKey: decoded to ${this.encodingAesKey.length} bytes, expected 32 bytes`
        );
      }

      this.iv = this.encodingAesKey.subarray(0, 16);

      addLog.info('Successfully initialized WXMsgCrypt', {
        keyLength: this.encodingAesKey.length,
        ivLength: this.iv.length,
        appId: appId
      });
    } catch (error) {
      addLog.error('Failed to decode encodingAesKey', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error('Invalid encodingAesKey: must be valid base64 string');
    }
  }

  /**
   * 验证签名
   */
  verifySignature(
    signature: string,
    timestamp: string,
    nonce: string,
    encryptedData?: string
  ): boolean {
    try {
      // 如果有加密数据，使用4个参数；否则使用3个参数（明文模式）
      const tmpArr = encryptedData
        ? [this.token, timestamp, nonce, encryptedData].sort()
        : [this.token, timestamp, nonce].sort();
      const tmpStr = tmpArr.join('');
      const hash = crypto.createHash('sha1').update(tmpStr).digest('hex');

      return hash === signature;
    } catch (error) {
      addLog.error('Signature verification error', error);
      return false;
    }
  }

  /**
   * 解密消息
   */
  decrypt(encrypted: string): string {
    try {
      if (!encrypted) {
        throw new Error('Empty encrypted string');
      }

      if (this.encodingAesKey.length === 0) {
        throw new Error('EncodingAesKey not configured');
      }

      const aesCipher = Buffer.from(encrypted, 'base64');

      if (aesCipher.length === 0) {
        throw new Error('Invalid base64 encrypted string');
      }

      const decipher = crypto.createDecipheriv('aes-256-cbc', this.encodingAesKey, this.iv);
      decipher.setAutoPadding(false);

      const decryptedBuffer1 = decipher.update(aesCipher);
      const decryptedBuffer2 = decipher.final();
      let decrypted = Buffer.concat([decryptedBuffer1, decryptedBuffer2]);

      if (decrypted.length === 0) {
        throw new Error('Decryption returned empty buffer');
      }

      // PKCS7 填充移除
      const pad = decrypted[decrypted.length - 1];
      if (pad >= 1 && pad <= 16) {
        const paddingBytes = decrypted.subarray(-pad);
        const isValidPadding = Array.from(paddingBytes).every((b) => b === pad);
        if (isValidPadding) {
          decrypted = decrypted.subarray(0, decrypted.length - pad);
        }
      }

      // 解析: 16字节随机字符串 + 4字节消息长度 + 消息内容 + appId
      if (decrypted.length < 20) {
        throw new Error(`Decrypted data too short: ${decrypted.length} bytes`);
      }

      const lengthBuffer = decrypted.subarray(16, 20);
      const msgLength = lengthBuffer.readUInt32BE(0);
      const contentStart = 20;
      const contentEnd = contentStart + msgLength;

      if (contentEnd > decrypted.length) {
        throw new Error(`Message length out of bounds: ${msgLength} bytes`);
      }

      const message = decrypted.subarray(contentStart, contentEnd).toString('utf8');

      addLog.info('Decrypt wechat message success', {
        messageLength: message.length
      });

      return message;
    } catch (error) {
      addLog.error('Decrypt wechat message error', {
        message: error instanceof Error ? error.message : String(error)
      });
      throw new Error(
        `Decryption failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 加密消息
   */
  encrypt(message: string): string {
    try {
      if (this.encodingAesKey.length === 0) {
        throw new Error('EncodingAesKey not configured');
      }

      const random16 = crypto.randomBytes(16);
      const msgLength = Buffer.alloc(4);
      msgLength.writeUInt32BE(Buffer.byteLength(message), 0);

      const raw = Buffer.concat([
        random16,
        msgLength,
        Buffer.from(message),
        Buffer.from(this.appId)
      ]);

      // PKCS7 padding
      const blockSize = 32;
      const padLength = blockSize - (raw.length % blockSize);
      const padded = Buffer.concat([raw, Buffer.alloc(padLength, padLength)]);

      const cipher = crypto.createCipheriv('aes-256-cbc', this.encodingAesKey, this.iv);
      cipher.setAutoPadding(false);

      const encryptedBuffer1 = cipher.update(padded);
      const encryptedBuffer2 = cipher.final();
      const encrypted = Buffer.concat([encryptedBuffer1, encryptedBuffer2]);

      return encrypted.toString('base64');
    } catch (error) {
      addLog.error('Encrypt wechat message error', error);
      throw new Error(
        `Encryption failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 生成签名
   */
  generateSignature(timestamp: string, nonce: string, encryptedData: string): string {
    const tmpArr = [this.token, timestamp, nonce, encryptedData].sort();
    const tmpStr = tmpArr.join('');
    return crypto.createHash('sha1').update(tmpStr).digest('hex');
  }
}

// Access Token 缓存
const accessTokenCache: Map<string, { token: string; expiresAt: number }> = new Map();

// 消息去重缓存
const processedMessageIds: Map<string, number> = new Map();
const MESSAGE_ID_CACHE_DURATION = 10 * 60 * 1000; // 10分钟

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
 * 获取微信公众号 access_token
 */
async function getOffiAccountAccessToken(appId: string, secret: string): Promise<string> {
  try {
    const cacheKey = `${appId}:${secret}`;
    const now = Date.now();

    const cached = accessTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > now + 300000) {
      addLog.info('Use cached offiaccount access token', {
        appId,
        remainingSeconds: Math.floor((cached.expiresAt - now) / 1000)
      });
      return cached.token;
    }

    const response = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: {
        grant_type: 'client_credential',
        appid: appId,
        secret: secret
      },
      timeout: 10000
    });

    if (response.data.access_token) {
      const token = response.data.access_token;
      const expiresIn = response.data.expires_in || 7200;
      const expiresAt = now + expiresIn * 1000;

      accessTokenCache.set(cacheKey, { token, expiresAt });

      addLog.info('Get new offiaccount access token success', {
        appId,
        expiresIn
      });
      return token;
    }

    throw new Error(
      `Get access token failed: ${response.data.errmsg} (code: ${response.data.errcode})`
    );
  } catch (error) {
    addLog.error('Get offiaccount access token error', {
      error: error instanceof Error ? error.message : String(error),
      appId
    });
    throw error;
  }
}

/**
 * 发送客服消息（需要已认证的公众号）
 * 参考: https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Service_Center_messages.html
 */
export async function sendOffiAccountMessage(
  accessToken: string,
  openId: string,
  content: string
): Promise<void> {
  try {
    const response = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`,
      {
        touser: openId,
        msgtype: 'text',
        text: {
          content: content.substring(0, 2048) // 微信文本消息限制
        }
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    if (response.data.errcode !== 0) {
      throw new Error(
        `Send message failed: ${response.data.errmsg} (code: ${response.data.errcode})`
      );
    }

    addLog.info('Send offiaccount message success', { openId, contentLength: content.length });
  } catch (error) {
    addLog.error('Send offiaccount message error', {
      error: error instanceof Error ? error.message : String(error),
      openId
    });
    throw error;
  }
}

/**
 * 解析微信公众号 XML 消息
 */
function parseWechatXmlMessage(xml: string): Record<string, any> {
  const result: Record<string, any> = {};

  // 提取 <xml>...</xml> 内部内容
  let xmlContent = xml;
  const xmlMatch = /<xml>([\s\S]*?)<\/xml>/i.exec(xml);
  if (xmlMatch) {
    xmlContent = xmlMatch[1];
  }

  // 解析各字段
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
function buildReplyXml(
  toUser: string,
  fromUser: string,
  content: string,
  createTime?: number
): string {
  const timestamp = createTime || Math.floor(Date.now() / 1000);
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${timestamp}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
}

/**
 * 处理微信公众号事件
 */
export async function handleOffiAccountEvent(
  shareId: string,
  body: string | Record<string, any>,
  query: Record<string, string>
): Promise<any> {
  try {
    // 获取 outLink 配置
    const outLink = await MongoOutLink.findOne({ shareId }).lean<
      OutLinkSchema<OffiAccountAppType>
    >();
    if (!outLink || !outLink.app) {
      throw new Error(`OutLink not found or not configured (shareId: ${shareId})`);
    }

    const { appId, secret, CallbackToken, CallbackEncodingAesKey } = outLink.app;

    // 验证必需配置
    if (!appId || !secret || !CallbackToken) {
      throw new Error('Missing required configuration: appId, secret, or CallbackToken');
    }

    const { signature, timestamp, nonce, echostr, msg_signature, encrypt_type } = query;

    addLog.info('Start handling offiaccount event', {
      shareId,
      appId,
      hasSignature: !!signature,
      hasEchoStr: !!echostr,
      encryptType: encrypt_type,
      hasMsgSignature: !!msg_signature
    });

    // 初始化加解密工具（如果配置了 AES Key）
    const msgCrypt = CallbackEncodingAesKey
      ? new WXMsgCrypt(CallbackToken, CallbackEncodingAesKey, appId)
      : null;

    // 1. URL 验证（GET 请求）
    if (echostr) {
      // 验证签名
      const tmpArr = [CallbackToken, timestamp || '', nonce || ''].sort();
      const tmpStr = tmpArr.join('');
      const hash = crypto.createHash('sha1').update(tmpStr).digest('hex');

      if (hash !== signature) {
        addLog.error('URL verification signature mismatch', {
          expected: hash,
          received: signature
        });
        throw new Error('Invalid signature');
      }

      addLog.info('Offiaccount URL verification success', { shareId });
      return echostr;
    }

    // 2. 消息处理（POST 请求）
    let xmlContent = typeof body === 'string' ? body : '';

    // 如果 body 是对象且包含 xml 字段（某些框架会预解析）
    if (typeof body === 'object' && body.xml) {
      // 直接使用解析后的对象
      const message = body.xml;
      return processMessage(outLink, message, query);
    }

    // 安全模式：需要解密
    if (encrypt_type === 'aes' && msgCrypt) {
      // 提取加密内容
      const encryptMatch = /<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/.exec(xmlContent);
      if (!encryptMatch) {
        throw new Error('Cannot find Encrypt field in message');
      }

      const encryptedContent = encryptMatch[1];

      // 验证消息签名
      if (
        msg_signature &&
        !msgCrypt.verifySignature(msg_signature, timestamp || '', nonce || '', encryptedContent)
      ) {
        throw new Error('Invalid message signature');
      }

      // 解密消息
      xmlContent = msgCrypt.decrypt(encryptedContent);
    }

    // 解析 XML 消息
    const message = parseWechatXmlMessage(xmlContent);
    return processMessage(outLink, message, query);
  } catch (error) {
    addLog.error('Handle offiaccount event error', {
      shareId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
}

/**
 * 处理消息
 */
async function processMessage(
  outLink: OutLinkSchema<OffiAccountAppType>,
  message: Record<string, any>,
  query: Record<string, string>
): Promise<any> {
  const msgType = message.MsgType;
  const msgId = message.MsgId || '';
  const fromUser = message.FromUserName || '';
  const toUser = message.ToUserName || '';

  addLog.info('Process offiaccount message', {
    msgType,
    msgId,
    fromUser,
    toUser
  });

  // 处理事件消息（关注、取消关注等）
  if (msgType === 'event') {
    const event = message.Event;
    addLog.info('Offiaccount event received', { event, fromUser });

    if (event === 'subscribe') {
      // 用户关注时的欢迎消息
      const welcomeMsg = outLink.immediateResponse || '欢迎关注！有什么可以帮您的吗？';
      return {
        success: true,
        replyXml: buildReplyXml(fromUser, toUser, welcomeMsg)
      };
    }

    return { success: true, replyXml: '' };
  }

  // 处理文本消息
  if (msgType === 'text') {
    const userMessage = message.Content || '';

    if (!userMessage.trim()) {
      return { success: true, replyXml: '' };
    }

    // 消息去重
    if (msgId && isMessageProcessed(msgId)) {
      addLog.info('Message already processed, skip', { msgId });
      return { success: true, replyXml: '' };
    }

    return {
      success: true,
      needProcess: true,
      messageInfo: {
        userMessage,
        openId: fromUser,
        toUser,
        msgId,
        createTime: message.CreateTime
      }
    };
  }

  // 其他类型消息
  return { success: true, replyXml: '' };
}

/**
 * 发送公众号响应消息（封装）
 */
export async function sendOffiAccountResponse(
  outLink: OutLinkSchema<OffiAccountAppType>,
  openId: string,
  response: string
): Promise<void> {
  if (!outLink.app) {
    throw new Error('Offiaccount app not configured in outLink');
  }

  const { appId, secret } = outLink.app;

  if (!appId || !secret) {
    throw new Error('Missing appId or secret in offiaccount config');
  }

  const accessToken = await getOffiAccountAccessToken(appId, secret);
  await sendOffiAccountMessage(accessToken, openId, response);
}

/**
 * 清理 AI 回复内容，移除 Markdown 格式
 */
export function cleanResponseContent(content: string): string {
  if (!content) return content;

  let cleaned = content;

  // 移除代码块标记
  cleaned = cleaned.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/```(\w+)?\n?/g, '').replace(/```$/g, '');
  });

  // 移除行内代码标记
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // 移除加粗标记
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/__([^_]+)__/g, '$1');

  // 移除斜体标记
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/_([^_]+)_/g, '$1');

  // 移除删除线
  cleaned = cleaned.replace(/~~([^~]+)~~/g, '$1');

  // 简化链接
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // 移除图片标记
  cleaned = cleaned.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[图片: $1]');

  // 简化标题标记
  cleaned = cleaned.replace(/^#+\s+/gm, '');

  // 简化列表标记
  cleaned = cleaned.replace(/^[\*\-\+]\s+/gm, '• ');

  // 移除引用标记
  cleaned = cleaned.replace(/^>\s+/gm, '');

  // 清理多余的空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}
