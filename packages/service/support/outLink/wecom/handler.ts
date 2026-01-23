import axios from 'axios';
import crypto from 'crypto';
import type { WecomAppType, OutLinkSchema } from '@fastgpt/global/support/outLink/type';
import { MongoOutLink } from '../schema';
import { addLog } from '../../../common/system/log';
import { globalStreamManager } from './stream-manager';

/**
 * 企业微信消息加解密（修复 IV 无效问题）
 */
class WXBizMsgCrypt {
  private token: string;
  private encodingAesKey: Buffer;
  private corpId: string;
  private iv: Buffer; // 新增：固定 IV 缓存

  constructor(token: string, encodingAesKey: string, corpId: string) {
    this.token = token;
    this.corpId = corpId;

    // encodingAesKey 是43位字符，base64解码后为32字节
    // 验证 encodingAesKey 格式
    if (!encodingAesKey) {
      addLog.error('EncodingAesKey is empty or undefined');
      throw new Error('EncodingAesKey is required');
    }

    // 清理可能的空格或换行符
    const cleanedKey = encodingAesKey.trim();

    if (cleanedKey.length !== 43) {
      addLog.error('Invalid encodingAesKey length', {
        originalLength: encodingAesKey.length,
        cleanedLength: cleanedKey.length,
        expected: 43,
        key: cleanedKey.substring(0, 10) + '...' // 只显示前10位用于调试
      });
      throw new Error(`Invalid encodingAesKey: expected 43 characters, got ${cleanedKey.length}`);
    }

    try {
      // 企业微信的 EncodingAESKey 需要添加 '=' 补齐 base64
      this.encodingAesKey = Buffer.from(cleanedKey + '=', 'base64');

      // 验证解码后的长度必须是 32 字节
      if (this.encodingAesKey.length !== 32) {
        addLog.error('Invalid encodingAesKey decoded length', {
          decodedLength: this.encodingAesKey.length,
          expected: 32,
          isBuffer: Buffer.isBuffer(this.encodingAesKey)
        });
        throw new Error(
          `Invalid encodingAesKey: decoded to ${this.encodingAesKey.length} bytes, expected 32 bytes`
        );
      }

      // 修复核心：初始化固定长度的 IV（16字节）
      // 企业微信标准：IV 为 encodingAesKey 的前16字节
      this.iv = this.encodingAesKey.subarray(0, 16);
      // 二次验证 IV 长度
      if (this.iv.length !== 16) {
        addLog.error('IV initialization failed', {
          ivLength: this.iv.length,
          expected: 16,
          keyLength: this.encodingAesKey.length
        });
        throw new Error(`IV length error: ${this.iv.length} bytes, expected 16 bytes`);
      }

      addLog.info('Successfully initialized WXBizMsgCrypt', {
        keyLength: this.encodingAesKey.length,
        ivLength: this.iv.length,
        corpId: corpId
      });
    } catch (error) {
      addLog.error('Failed to decode encodingAesKey', {
        error: error instanceof Error ? error.message : String(error),
        keyLength: encodingAesKey.length
      });
      throw new Error('Invalid encodingAesKey: must be valid base64 string');
    }
  }

  /**
   * 验证签名（修复：必须包含第四个参数）
   * @param signature - msg_signature 参数
   * @param timestamp - timestamp 参数
   * @param nonce - nonce 参数
   * @param encryptedData - 第四个参数：URL验证时为echostr，消息验证时为加密消息体
   */
  verifySignature(
    signature: string,
    timestamp: string,
    nonce: string,
    encryptedData: string
  ): boolean {
    try {
      // 企业微信签名验证算法：
      // 将 token、timestamp、nonce、encrypt(或echostr) 四个参数按字典序排序后拼接，进行SHA1哈希
      const tmpArr = [this.token, timestamp, nonce, encryptedData].sort();
      const tmpStr = tmpArr.join('');
      const hash = crypto.createHash('sha1').update(tmpStr).digest('hex');

      addLog.info('Verify signature result', {
        calculated: hash,
        received: signature,
        match: hash === signature,
        encryptedDataLength: encryptedData?.length || 0
      });

      return hash === signature;
    } catch (error) {
      addLog.error('Signature verification error', error);
      return false;
    }
  }

  /**
   * 生成签名
   * @param timestamp - 时间戳
   * @param nonce - 随机字符串
   * @param encryptedData - 加密后的消息
   */
  generateSignature(timestamp: string, nonce: string, encryptedData: string): string {
    const tmpArr = [this.token, timestamp, nonce, encryptedData].sort();
    const tmpStr = tmpArr.join('');
    return crypto.createHash('sha1').update(tmpStr).digest('hex');
  }

  /**
   * 解密消息（核心修复）
   */
  decrypt(encrypted: string): string {
    try {
      if (!encrypted) {
        throw new Error('Empty encrypted string');
      }

      // Base64 解码
      const aesCipher = Buffer.from(encrypted, 'base64');

      if (aesCipher.length === 0) {
        throw new Error('Invalid base64 encrypted string');
      }

      // 详细验证密钥和IV
      if (!Buffer.isBuffer(this.encodingAesKey) || this.encodingAesKey.length !== 32) {
        addLog.error('Invalid encodingAesKey', {
          isBuffer: Buffer.isBuffer(this.encodingAesKey),
          length: this.encodingAesKey?.length || 0
        });
        throw new Error('EncodingAesKey must be 32-byte Buffer');
      }

      if (!Buffer.isBuffer(this.iv) || this.iv.length !== 16) {
        addLog.error('Invalid IV in decrypt', {
          isBuffer: Buffer.isBuffer(this.iv),
          length: this.iv?.length || 0,
          expected: 16
        });
        throw new Error(
          `Invalid initialization vector: length ${this.iv?.length}, expected 16 bytes`
        );
      }

      addLog.info('Start decrypting wecom message', {
        cipherLength: aesCipher.length,
        keyLength: this.encodingAesKey.length,
        ivLength: this.iv.length
      });

      // 修复：移除 any 类型断言，确保类型正确
      // 使用 aes-256-cbc 算法，关闭自动填充，手动处理 PKCS7
      const decipher = crypto.createDecipheriv('aes-256-cbc', this.encodingAesKey, this.iv);
      decipher.setAutoPadding(false); // 手动处理填充

      // 修复：正确拼接解密结果（避免类型错误）
      const decryptedBuffer1 = decipher.update(aesCipher);
      const decryptedBuffer2 = decipher.final();
      let decrypted = Buffer.concat([decryptedBuffer1, decryptedBuffer2]);

      if (decrypted.length === 0) {
        throw new Error('Decryption returned empty buffer');
      }

      // 添加调试：打印解密后原始数据信息
      addLog.info('Decrypted raw data', {
        rawLength: decrypted.length,
        lastByte: decrypted[decrypted.length - 1],
        last5Bytes: Array.from(decrypted.subarray(-5))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')
      });

      // 修复：正确处理 PKCS7 填充（字节级别）
      const pad = decrypted[decrypted.length - 1];
      // PKCS7 填充值应该在 1-16 之间（AES 块大小为 16）
      if (pad >= 1 && pad <= 16) {
        // 验证填充是否有效（所有填充字节应该相同）
        const paddingBytes = decrypted.subarray(-pad);
        const isValidPadding = Array.from(paddingBytes).every((b) => b === pad);
        if (isValidPadding) {
          decrypted = decrypted.subarray(0, decrypted.length - pad);
          addLog.info('PKCS7 padding removed', { padValue: pad, newLength: decrypted.length });
        } else {
          addLog.warn('Invalid PKCS7 padding pattern, keeping original data', { padValue: pad });
        }
      } else {
        addLog.warn('Unexpected padding value, keeping original data', { padValue: pad });
      }

      // 解析：16字节随机字符串 + 4字节消息长度 + 消息内容 [+ corpId（可选）]
      if (decrypted.length < 20) {
        throw new Error(`Decrypted data too short: ${decrypted.length} bytes (min 20)`);
      }

      // 读取 4 字节消息长度（网络字节序/BE格式）
      const lengthBuffer = decrypted.subarray(16, 20);
      const msgLength = lengthBuffer.readUInt32BE(0);
      const contentStart = 20;
      const contentEnd = contentStart + msgLength;

      // 验证长度是否合法
      if (contentEnd > decrypted.length) {
        throw new Error(
          `Message length out of bounds: ${msgLength} bytes, available ${decrypted.length - 20} bytes`
        );
      }

      // 提取消息内容
      const message = decrypted.subarray(contentStart, contentEnd).toString('utf8');

      // 检查是否有 CorpId 后缀（智能机器人接口可能没有）
      const remainingBytes = decrypted.length - contentEnd;
      let corpIdFromData = '';
      if (remainingBytes > 0) {
        corpIdFromData = decrypted.subarray(contentEnd).toString('utf8');
      }

      // 添加详细调试日志
      addLog.info('Decrypt content details', {
        decryptedTotalLength: decrypted.length,
        msgLength: msgLength,
        contentStart: contentStart,
        contentEnd: contentEnd,
        remainingBytes: remainingBytes,
        messagePreview: message.substring(0, 300),
        corpIdFromData: corpIdFromData || '(none)',
        isJsonFormat: message.startsWith('{')
      });

      // 验证 corpId（如果有）
      if (corpIdFromData && corpIdFromData !== this.corpId) {
        addLog.warn('CorpId mismatch (may be expected for AI bot interface)', {
          expected: this.corpId,
          received: corpIdFromData
        });
      }

      addLog.info('Decrypt wecom message success', {
        messageLength: message.length,
        hasCorpId: !!corpIdFromData,
        corpIdMatch: corpIdFromData === this.corpId || !corpIdFromData
      });

      return message;
    } catch (error) {
      addLog.error('Decrypt wecom message error', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        encryptedLength: encrypted?.length || 0,
        encryptedPreview: encrypted?.substring(0, 50),
        keyLength: this.encodingAesKey?.length || 0,
        ivLength: this.iv?.length || 0
      });
      throw new Error(
        `Decryption failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 加密消息（同步修复 IV 处理）
   */
  encrypt(message: string): string {
    try {
      const random16 = crypto.randomBytes(16);
      const msgLength = Buffer.alloc(4);
      msgLength.writeUInt32BE(Buffer.byteLength(message), 0);

      const raw = Buffer.concat([
        random16,
        msgLength,
        Buffer.from(message),
        Buffer.from(this.corpId)
      ]);

      // PKCS7 padding
      const blockSize = 32;
      const padLength = blockSize - (raw.length % blockSize);
      const padded = Buffer.concat([raw, Buffer.alloc(padLength, padLength)]);

      // 修复：使用预初始化的 IV，移除 any 断言
      const cipher = crypto.createCipheriv('aes-256-cbc', this.encodingAesKey, this.iv);
      cipher.setAutoPadding(false);

      const encryptedBuffer1 = cipher.update(padded);
      const encryptedBuffer2 = cipher.final();
      const encrypted = Buffer.concat([encryptedBuffer1, encryptedBuffer2]);

      return encrypted.toString('base64');
    } catch (error) {
      addLog.error('Encrypt wecom message error', error);
      throw new Error(
        `Encryption failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 加密消息并生成签名（用于被动回复）
   * 返回包含 Encrypt、MsgSignature、TimeStamp、Nonce 的 JSON 字符串
   */
  /**
   * 加密消息并生成签名（用于被动回复）
   *
   * 重要：智能机器人的 receiveid 是空字符串！
   * 参考官方 demo: https://developer.work.weixin.qq.com/document/path/101039
   *
   * @param message - 要加密的 JSON 字符串
   * @param nonce - 随机字符串
   * @param timestamp - 时间戳
   * @param useEmptyReceiverId - 是否使用空字符串作为 receiverId（智能机器人用）
   */
  encryptMsg(
    message: string,
    nonce: string,
    timestamp: string,
    useEmptyReceiverId: boolean = false
  ): string {
    try {
      // 智能机器人需要使用空字符串作为 receiverId
      const receiverId = useEmptyReceiverId ? '' : this.corpId;

      // 1. 加密消息（使用正确的 receiverId）
      const encrypted = this.encryptWithReceiverId(message, receiverId);

      // 2. 生成签名
      const signature = this.generateSignature(timestamp, nonce, encrypted);

      // 3. 构建响应 JSON
      const response = {
        encrypt: encrypted,
        msgsignature: signature,
        timestamp: timestamp,
        nonce: nonce
      };

      addLog.info('Encrypt message for response', {
        messageLength: message.length,
        encryptedLength: encrypted.length,
        signature: signature.substring(0, 20) + '...',
        useEmptyReceiverId
      });

      return JSON.stringify(response);
    } catch (error) {
      addLog.error('EncryptMsg error', error);
      throw new Error(
        `EncryptMsg failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 使用指定的 receiverId 加密消息
   */
  encryptWithReceiverId(message: string, receiverId: string): string {
    try {
      const random16 = crypto.randomBytes(16);
      const msgLength = Buffer.alloc(4);
      msgLength.writeUInt32BE(Buffer.byteLength(message), 0);

      const raw = Buffer.concat([
        random16,
        msgLength,
        Buffer.from(message),
        Buffer.from(receiverId) // 使用传入的 receiverId
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
      addLog.error('Encrypt with receiverId error', error);
      throw new Error(
        `Encryption failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

// Access Token 缓存（内存缓存，生产环境建议使用 Redis）
const accessTokenCache: Map<string, { token: string; expiresAt: number }> = new Map();

// 消息去重缓存（记录最近10分钟处理过的消息ID）
const processedMessageIds: Map<string, number> = new Map();
const MESSAGE_ID_CACHE_DURATION = 10 * 60 * 1000; // 10分钟

/**
 * 检查消息是否已处理（去重）
 */
function isMessageProcessed(msgId: string): boolean {
  const now = Date.now();

  // 清理过期的记录（每次检查时清理）
  for (const [id, timestamp] of processedMessageIds.entries()) {
    if (now - timestamp > MESSAGE_ID_CACHE_DURATION) {
      processedMessageIds.delete(id);
    }
  }

  // 检查是否已处理
  if (processedMessageIds.has(msgId)) {
    addLog.info('Message already processed (duplicate)', { msgId });
    return true;
  }

  // 标记为已处理
  processedMessageIds.set(msgId, now);
  return false;
}

/**
 * 获取企业微信访问令牌（带缓存）
 * access_token 有效期为 7200 秒（2小时），应该缓存避免频繁请求
 */
async function getWecomAccessToken(corpId: string, secret: string): Promise<string> {
  try {
    const cacheKey = `${corpId}:${secret}`;
    const now = Date.now();

    // 检查缓存（提前5分钟过期以确保安全）
    const cached = accessTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > now + 300000) {
      addLog.info('Use cached access token', {
        corpId,
        remainingSeconds: Math.floor((cached.expiresAt - now) / 1000)
      });
      return cached.token;
    }

    // 请求新的 token
    const response = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
      params: {
        corpid: corpId,
        corpsecret: secret
      },
      timeout: 10000
    });

    if (response.data.errcode === 0) {
      const token = response.data.access_token;
      const expiresIn = response.data.expires_in || 7200; // 默认2小时
      const expiresAt = now + expiresIn * 1000;

      // 缓存 token
      accessTokenCache.set(cacheKey, { token, expiresAt });

      addLog.info('Get new access token success', {
        corpId,
        expiresIn,
        cacheSize: accessTokenCache.size
      });
      return token;
    }

    throw new Error(
      `Get wecom access token failed: ${response.data.errmsg} (code: ${response.data.errcode})`
    );
  } catch (error) {
    addLog.error('Get wecom access token error', {
      error: error instanceof Error ? error.message : String(error),
      corpId: corpId
    });
    throw error;
  }
}

/**
 * 发送企业微信消息（优化错误处理）
 */
async function sendWecomMessage(
  accessToken: string,
  userId: string,
  agentId: string,
  content: string
): Promise<void> {
  try {
    const response = await axios.post(
      'https://qyapi.weixin.qq.com/cgi-bin/message/send',
      {
        touser: userId,
        msgtype: 'text',
        agentid: agentId,
        text: {
          content: content.substring(0, 2048) // 企业微信文本消息最大长度限制
        },
        safe: 0
      },
      {
        params: {
          access_token: accessToken
        },
        timeout: 10000
      }
    );

    if (response.data.errcode !== 0) {
      throw new Error(
        `Send message failed: ${response.data.errmsg} (code: ${response.data.errcode})`
      );
    }

    addLog.info('Send wecom message success', { userId, agentId, contentLength: content.length });
  } catch (error) {
    addLog.error('Send wecom message error', {
      error: error instanceof Error ? error.message : String(error),
      userId,
      agentId
    });
    throw error;
  }
}

/**
 * 清理 AI 回复内容，使其更适合企业微信显示
 * 企业微信 AI Bot response_url 似乎只支持纯文本，不支持 Markdown
 */
export function cleanResponseContent(content: string): string {
  if (!content) return content;

  let cleaned = content;

  // 移除代码块标记
  cleaned = cleaned.replace(/```[\s\S]*?```/g, (match) => {
    // 提取代码块内容，移除标记
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

  // 简化链接（保留链接文本和URL）
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // 移除图片标记
  cleaned = cleaned.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[图片: $1]');

  // 简化标题标记
  cleaned = cleaned.replace(/^#+\s+/gm, '');

  // 简化列表标记
  cleaned = cleaned.replace(/^[\*\-\+]\s+/gm, '• ');
  cleaned = cleaned.replace(/^\d+\.\s+/gm, (match, offset) => {
    const lineNum =
      content
        .substring(0, offset)
        .split('\n')
        .filter((l) => /^\d+\./.test(l)).length + 1;
    return `${lineNum}. `;
  });

  // 简化表格（转换为简单文本）
  cleaned = cleaned.replace(/\|(.+)\|/g, '$1');
  cleaned = cleaned.replace(/[\|\-]+/g, '');

  // 移除引用标记
  cleaned = cleaned.replace(/^>\s+/gm, '');

  // 清理多余的空行（保留最多一个空行）
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * 解析企业微信消息（支持 JSON 和 XML 格式）
 */
function parseWecomMessage(content: string): Record<string, any> {
  if (!content) return {};

  // 尝试 JSON 解析（智能机器人接口使用 JSON 格式）
  if (content.trim().startsWith('{')) {
    try {
      const jsonData = JSON.parse(content);
      // 如果是流式轮询消息，打印 stream 信息
      if (jsonData.msgtype === 'stream') {
        addLog.info('Parsed stream polling message', {
          hasStream: !!jsonData.stream,
          streamId: jsonData.stream?.id,
          streamObj: JSON.stringify(jsonData.stream)
        });
      }

      addLog.info('Parsed wecom JSON message', {
        keys: Object.keys(jsonData),
        msgtype: jsonData.msgtype,
        hasContent: !!jsonData.text?.content
      });

      // 统一格式：将 JSON 格式转换为与 XML 格式兼容的结构
      return {
        MsgId: jsonData.msgid,
        MsgType: jsonData.msgtype,
        FromUserName: jsonData.from?.userid || jsonData.from?.openid,
        Content: jsonData.text?.content || jsonData.content,
        CreateTime: jsonData.create_time,
        // 智能机器人专用：回复 URL
        ResponseUrl: jsonData.response_url,
        AiBotId: jsonData.aibotid,
        // 流式轮询专用：stream 对象（包含 stream.id）
        stream: jsonData.stream,
        Stream: jsonData.stream, // 同时保存大写版本
        // 保留原始数据
        _raw: jsonData,
        _isJson: true
      };
    } catch (e) {
      addLog.warn('JSON parse failed, trying XML', { error: (e as Error).message });
    }
  }

  // XML 解析（传统回调接口使用 XML 格式）
  const result: Record<string, any> = {};

  // 先提取 <xml>...</xml> 内部的内容
  let xmlContent = content;
  const xmlMatch = /<xml>([\s\S]*?)<\/xml>/i.exec(content);
  if (xmlMatch) {
    xmlContent = xmlMatch[1];
  }

  // 解析内层元素（跳过嵌套的 xml 标签）
  const regex = /<(\w+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/g;
  let match;

  while ((match = regex.exec(xmlContent)) !== null) {
    const key = match[1];
    if (key.toLowerCase() === 'xml') continue; // 跳过 xml 标签
    let value = match[2] !== undefined ? match[2] : match[3] || '';
    value = value.trim();
    result[key] = value;
  }

  addLog.info('Parsed wecom XML message', { keys: Object.keys(result) });
  return result;
}

/**
 * 处理企业微信事件（优化流程）
 */
export async function handleWecomEvent(
  shareId: string,
  body: any,
  query: Record<string, string>
): Promise<any> {
  try {
    // 获取 outLink 配置
    const outLink = await MongoOutLink.findOne({ shareId }).lean<OutLinkSchema<WecomAppType>>();
    if (!outLink || !outLink.app) {
      throw new Error(`OutLink not found or not configured (shareId: ${shareId})`);
    }

    // 提取并清理配置（去除前后空格）
    const CorpId = outLink.app.CorpId?.trim() || '';
    const SuiteSecret = outLink.app.SuiteSecret?.trim() || '';
    const AgentId = outLink.app.AgentId?.trim() || '';
    const CallbackToken = outLink.app.CallbackToken?.trim() || '';
    const CallbackEncodingAesKey = outLink.app.CallbackEncodingAesKey?.trim() || '';

    // 验证必需的配置项
    const missingConfigs: string[] = [];
    if (!CorpId) missingConfigs.push('CorpId');
    if (!CallbackToken) missingConfigs.push('CallbackToken');
    if (!CallbackEncodingAesKey) missingConfigs.push('CallbackEncodingAesKey');

    if (missingConfigs.length > 0) {
      addLog.error('Missing wecom config items', {
        shareId,
        missing: missingConfigs
      });
      throw new Error(`Missing configuration: ${missingConfigs.join(', ')}`);
    }

    // 兼容 Encrypt/encrypt 大小写
    const encryptedContent = body?.Encrypt || body?.encrypt || '';

    addLog.info('Start handling wecom event', {
      shareId,
      corpId: CorpId,
      token: CallbackToken,
      tokenLength: CallbackToken.length,
      aesKeyLength: CallbackEncodingAesKey.length,
      hasSignature: !!query.msg_signature,
      hasEncrypt: !!encryptedContent,
      encryptPreview: encryptedContent ? encryptedContent.substring(0, 30) + '...' : 'none',
      isEcho: !!query.echostr,
      bodyType: typeof body,
      bodyKeys: body ? Object.keys(body) : [],
      queryParams: {
        msg_signature: query.msg_signature,
        timestamp: query.timestamp,
        nonce: query.nonce,
        echostr: query.echostr?.substring(0, 20) + '...'
      }
    });

    const msgCrypt = new WXBizMsgCrypt(CallbackToken, CallbackEncodingAesKey, CorpId);

    // 1. URL 验证逻辑
    if (query.msg_signature && query.echostr) {
      const { msg_signature, timestamp, nonce, echostr } = query;

      // 验证签名
      if (!msgCrypt.verifySignature(msg_signature, timestamp || '', nonce || '', echostr)) {
        throw new Error('Invalid signature for echostr verification');
      }

      // 解密并返回 echostr
      const decrypted = msgCrypt.decrypt(echostr);
      addLog.info('Wecom URL verification success', { shareId, decryptedLength: decrypted.length });
      return decrypted;
    }

    // 2. 消息处理逻辑（兼容 Encrypt/encrypt 大小写）
    if (encryptedContent) {
      const { msg_signature, timestamp, nonce } = query;

      // 验证签名（使用 encryptedContent 而不是 body.Encrypt）
      if (
        !msgCrypt.verifySignature(
          msg_signature || '',
          timestamp || '',
          nonce || '',
          encryptedContent
        )
      ) {
        throw new Error('Invalid signature for message');
      }

      // 解密消息（使用 encryptedContent）
      const decryptedContent = msgCrypt.decrypt(encryptedContent);
      const message = parseWecomMessage(decryptedContent);

      const isAiBot = !!message.AiBotId;
      const msgId = message.MsgId || '';
      const userId = message.FromUserName || '';

      addLog.info('Process wecom message', {
        msgType: message.MsgType,
        fromUser: userId,
        contentLength: message.Content?.length || 0,
        isAiBot,
        aiBotId: message.AiBotId
      });

      // ============ 智能机器人流式轮询处理 ============
      // 企业微信会发送 msgtype: "stream" 来轮询获取流式内容
      // 轮询消息格式：{ msgtype: "stream", stream: { id: "我们返回的stream_id" } }
      // 重要：每次返回【完整的累积内容】（全量替换模式）
      if (message.MsgType === 'stream' && isAiBot) {
        // 从多个可能的位置获取 stream_id
        // 1. message.stream.id (解析后的)
        // 2. message._raw.stream.id (原始 JSON)
        // 3. 通过 msgId 查找
        const streamIdFromMsg = message.stream?.id || message._raw?.stream?.id;
        const streamId = streamIdFromMsg || globalStreamManager.getStreamIdByMsg(msgId);

        addLog.info('Stream polling request', {
          streamId,
          msgId,
          hasStreamId: !!streamId,
          streamIdFromMsg: streamIdFromMsg || '(not found)',
          messageStream: JSON.stringify(message.stream),
          rawStream: JSON.stringify(message._raw?.stream)
        });

        if (!streamId) {
          // 没有找到流式会话，返回结束信号
          return {
            isStreamResponse: true,
            streamResponse: {
              msgtype: 'stream',
              stream: {
                id: msgId,
                finish: true,
                content: ''
              }
            },
            msgCrypt,
            query
          };
        }

        // 获取完整的累积内容（全量替换模式）
        const { content, finished, hasUpdate } = globalStreamManager.getFullContent(streamId);

        addLog.info('Stream polling response (full content)', {
          streamId,
          contentLength: content.length,
          finished,
          hasUpdate,
          contentPreview: content.substring(0, 100)
        });

        return {
          isStreamResponse: true,
          streamResponse: {
            msgtype: 'stream',
            stream: {
              id: streamId,
              finish: finished,
              content: content // 返回完整的累积内容
            }
          },
          msgCrypt,
          query
        };
      }

      // ============ 智能机器人初始消息处理 ============
      if (message.MsgType === 'text' && isAiBot) {
        const userMessage = message.Content || '';

        if (!userMessage.trim()) {
          return 'success';
        }

        // 消息去重检查
        if (msgId && isMessageProcessed(msgId)) {
          addLog.info('Message already processed, skip', { msgId });
          return 'success';
        }

        // 创建流式会话
        const [session, isNew] = globalStreamManager.createOrGet(message);
        const streamId = session.stream_id;

        addLog.info('AI Bot message received, stream session created', {
          streamId,
          msgId,
          userId,
          isNew
        });

        // 首次回复的内容（官方 demo 要求首次回复必须包含内容）
        const initialContent = '<think>正在分析您的问题...</think>\n';

        // 同时保存到流式会话中（供后续轮询使用）
        if (isNew) {
          await globalStreamManager.appendContent(streamId, initialContent, false);
        }

        // 返回流式初始响应（包含实际内容，不能为空！）
        return {
          isStreamResponse: true,
          needProcess: true,
          streamResponse: {
            msgtype: 'stream',
            stream: {
              id: streamId,
              finish: false,
              content: initialContent // 首次回复必须包含内容！
            }
          },
          msgCrypt,
          query,
          messageInfo: {
            userMessage,
            userId,
            msgId,
            streamId,
            aiBotId: message.AiBotId,
            responseUrl: message.ResponseUrl
          }
        };
      }

      // ============ 普通应用消息处理 ============
      if (message.MsgType === 'text') {
        const userMessage = message.Content || '';

        if (!userMessage.trim()) {
          return 'success';
        }

        if (msgId && isMessageProcessed(msgId)) {
          return 'success';
        }

        // 发送即时响应（如果配置了）
        if (outLink.immediateResponse) {
          try {
            if (!SuiteSecret || !AgentId) {
              addLog.warn('Missing SuiteSecret/AgentId for immediate response', { shareId });
            } else {
              const accessToken = await getWecomAccessToken(CorpId, SuiteSecret);
              await sendWecomMessage(accessToken, userId, AgentId, outLink.immediateResponse);
            }
          } catch (error) {
            addLog.error('Send immediate response failed', error);
          }
        }

        return {
          success: true,
          needProcess: true,
          messageInfo: {
            userMessage,
            userId,
            msgId: message.MsgId,
            createTime: message.CreateTime
          }
        };
      }

      // 处理其他消息类型
      return {
        success: true,
        needProcess: false,
        msgType: message.MsgType
      };
    }

    return 'success';
  } catch (error) {
    addLog.error('Handle wecom event error', {
      shareId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      bodyPreview: JSON.stringify(body)?.substring(0, 200),
      query: query
    });
    throw new Error(
      `Wecom event handling failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * 发送企业微信响应消息（封装）
 */
export async function sendWecomResponse(
  outLink: OutLinkSchema<WecomAppType>,
  userId: string,
  response: string
): Promise<void> {
  if (!outLink.app) {
    throw new Error('Wecom app not configured in outLink');
  }

  const { CorpId, SuiteSecret, AgentId } = outLink.app;

  if (!SuiteSecret || !AgentId) {
    throw new Error('Missing SuiteSecret or AgentId in wecom config');
  }

  const accessToken = await getWecomAccessToken(CorpId, SuiteSecret);
  await sendWecomMessage(accessToken, userId, AgentId, response);
}

/**
 * 通过 response_url 发送智能机器人回复
 * 参考: https://developer.work.weixin.qq.com/document/path/100719
 *
 * 官方文档格式（智能机器人主动回复）：
 * POST {response_url}
 * Content-Type: application/json
 *
 * 请求体：
 * {
 *   "msgtype": "text",
 *   "text": {
 *     "content": "您好"
 *   }
 * }
 *
 * 注意：response_url 只能使用一次！
 */
export async function sendAiBotResponse(responseUrl: string, content: string): Promise<void> {
  try {
    // 确保内容不为空且有效
    const trimmedContent = content?.trim();
    if (!trimmedContent) {
      throw new Error('Content cannot be empty');
    }

    // 截取内容长度（企业微信限制 2048 字符）
    const finalContent = trimmedContent.substring(0, 2048);

    // 构建请求体 - 按官方文档格式
    const requestBody = {
      msgtype: 'text',
      text: {
        content: finalContent
      }
    };

    // 打印完整的请求信息用于调试
    const requestJson = JSON.stringify(requestBody);

    addLog.info('Sending AI bot response', {
      contentLength: finalContent.length,
      contentPreview: finalContent.substring(0, 100),
      requestBody: requestJson,
      requestBodyLength: requestJson.length,
      responseUrl: responseUrl // 打印完整URL便于调试
    });

    // 发送 JSON 请求
    const response = await axios.post(responseUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    // 检查响应
    if (response.data) {
      addLog.info('AI bot response received', {
        statusCode: response.status,
        responseData: response.data
      });

      if (typeof response.data === 'object' && response.data.errcode !== undefined) {
        if (response.data.errcode !== 0) {
          throw new Error(
            `AI Bot response failed: ${response.data.errmsg || 'Unknown error'} (code: ${response.data.errcode})`
          );
        }
      }
    }

    addLog.info('Send AI bot response success', {
      contentLength: finalContent.length
    });
  } catch (error) {
    // 增强错误日志以便调试
    const axiosError = error as any;
    const errorDetails: any = {
      error: error instanceof Error ? error.message : String(error),
      responseUrl: responseUrl.substring(0, 50) + '...',
      contentLength: content?.length || 0,
      contentPreview: content?.substring(0, 100)
    };

    if (axiosError.response) {
      errorDetails.statusCode = axiosError.response.status;
      errorDetails.responseData = axiosError.response.data;
      errorDetails.responseHeaders = axiosError.response.headers;
    }

    if (axiosError.request) {
      errorDetails.requestSent = true;
      errorDetails.requestData = axiosError.config?.data;
    }

    addLog.error('Send AI bot response error', errorDetails);
    throw error;
  }
}

/**
 * 加密流式响应消息
 * 参考: https://developer.work.weixin.qq.com/document/path/101031
 *
 * 流式消息格式：
 * {
 *   "msgtype": "stream",
 *   "stream": {
 *     "id": "STREAMID",
 *     "finish": false,
 *     "content": "内容..."
 *   }
 * }
 */
/**
 * 加密流式响应消息（智能机器人专用）
 *
 * 重要：智能机器人的 receiveid 是空字符串！
 * Content-Type 应该是 text/plain
 */
export function encryptStreamResponse(
  msgCrypt: any,
  streamResponse: {
    msgtype: string;
    stream: {
      id: string;
      finish: boolean;
      content: string;
    };
  },
  nonce: string,
  timestamp: string
): string {
  // 使用 ensure_ascii=False 等效：直接 JSON 字符串化
  const jsonStr = JSON.stringify(streamResponse);

  // 关键：智能机器人使用空字符串作为 receiverId
  const encrypted = msgCrypt.encryptMsg(jsonStr, nonce, timestamp, true);

  addLog.info('Encrypt stream response', {
    streamId: streamResponse.stream.id,
    contentLength: streamResponse.stream.content.length,
    finish: streamResponse.stream.finish,
    encryptedLength: encrypted.length,
    plainText: jsonStr.substring(0, 100)
  });

  return encrypted;
}

// 重新导出 globalStreamManager
export { globalStreamManager };
