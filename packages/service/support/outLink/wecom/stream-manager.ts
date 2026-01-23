import { addLog } from '../../../common/system/log';

/**
 * 流式片段数据结构
 */
export interface StreamChunk {
  content: string;
  is_final: boolean;
  meta?: Record<string, any>;
}

/**
 * 流式会话数据结构
 *
 * 重要：企业微信流式消息是【全量替换】模式！
 * 例如：第一次回复"1"，第二次回复"123"，展示内容为"123"（不是"1123"）
 */
export interface StreamSession {
  stream_id: string;
  msg_id: string;
  chat_id?: string;
  user_id?: string;
  created_at: number;
  last_access: number;
  // 累积的完整内容（每次轮询返回这个完整内容）
  accumulatedContent: string;
  // 是否有新内容待消费
  hasNewContent: boolean;
  // 上次消费时的内容（用于判断是否有更新）
  lastConsumedContent: string;
  finished: boolean;
}

/**
 * 流式会话管理器（企业微信智能机器人专用）
 *
 * 工作原理（全量替换模式）：
 * 1. 收到用户消息时创建 stream 会话，生成唯一的 stream_id
 * 2. 返回给企业微信，企业微信会持续轮询获取内容
 * 3. 工作流执行时，通过 appendContent 追加内容到累积内容
 * 4. 企业微信轮询时，返回【完整的累积内容】（全量替换）
 * 5. 收到 is_final=true 后，标记会话结束
 *
 * 注意：每次轮询返回的是完整内容，不是增量内容！
 */
export class StreamSessionManager {
  private sessions: Map<string, StreamSession> = new Map();
  private msgIndex: Map<string, string> = new Map(); // msgid -> stream_id
  private ttl: number; // 会话超时时间（秒）

  constructor(ttl: number = 60) {
    this.ttl = ttl;

    // 定期清理过期会话（每30秒）
    setInterval(() => {
      this.cleanup();
    }, 30000);
  }

  /**
   * 根据消息ID获取对应的 stream_id
   */
  getStreamIdByMsg(msgId: string): string | undefined {
    return this.msgIndex.get(msgId);
  }

  /**
   * 获取会话
   */
  getSession(streamId: string): StreamSession | undefined {
    const session = this.sessions.get(streamId);
    if (session) {
      session.last_access = Date.now();
    }
    return session;
  }

  /**
   * 创建或获取流式会话
   * @returns [session, isNew] - 会话实例和是否为新建标志
   */
  createOrGet(msgJson: Record<string, any>): [StreamSession, boolean] {
    const msgId = msgJson.msgid || msgJson.MsgId || '';

    // 如果已存在，返回现有会话
    if (msgId && this.msgIndex.has(msgId)) {
      const streamId = this.msgIndex.get(msgId)!;
      const session = this.sessions.get(streamId);
      if (session) {
        session.last_access = Date.now();
        addLog.info('Reuse existing stream session', { streamId, msgId });
        return [session, false];
      }
    }

    // 创建新会话
    const streamId = this.generateStreamId();
    const now = Date.now();

    const session: StreamSession = {
      stream_id: streamId,
      msg_id: msgId,
      chat_id: msgJson.chatid || msgJson.ChatId,
      user_id: msgJson.from?.userid || msgJson.FromUserName,
      created_at: now,
      last_access: now,
      accumulatedContent: '',
      hasNewContent: false,
      lastConsumedContent: '',
      finished: false
    };

    this.sessions.set(streamId, session);
    if (msgId) {
      this.msgIndex.set(msgId, streamId);
    }

    addLog.info('Create new stream session', {
      streamId,
      msgId,
      userId: session.user_id
    });

    return [session, true];
  }

  /**
   * 追加内容到累积内容（用于工作流输出）
   *
   * @param streamId 流式会话ID
   * @param content 要追加的内容
   * @param isFinal 是否是最后一个片段
   */
  async appendContent(
    streamId: string,
    content: string,
    isFinal: boolean = false
  ): Promise<boolean> {
    const session = this.sessions.get(streamId);
    if (!session) {
      addLog.warn('Stream session not found for append', { streamId });
      return false;
    }

    // 追加到累积内容
    session.accumulatedContent += content;
    session.hasNewContent = true;
    session.last_access = Date.now();

    if (isFinal) {
      session.finished = true;
      addLog.info('Stream session marked as finished', {
        streamId,
        totalContentLength: session.accumulatedContent.length
      });
    }

    addLog.info('Append stream content', {
      streamId,
      appendedLength: content.length,
      totalLength: session.accumulatedContent.length,
      isFinal
    });

    return true;
  }

  /**
   * 兼容旧接口：推送流式片段
   */
  async pushChunk(streamId: string, chunk: StreamChunk): Promise<boolean> {
    return this.appendContent(streamId, chunk.content, chunk.is_final);
  }

  /**
   * 获取完整的累积内容（用于企业微信轮询）
   *
   * 返回：{ content: 完整内容, finished: 是否结束, hasUpdate: 是否有更新 }
   */
  getFullContent(streamId: string): { content: string; finished: boolean; hasUpdate: boolean } {
    const session = this.sessions.get(streamId);
    if (!session) {
      addLog.warn('Stream session not found for getFullContent', { streamId });
      return { content: '', finished: true, hasUpdate: false };
    }

    session.last_access = Date.now();

    // 检查是否有新内容
    const hasUpdate =
      session.hasNewContent || session.accumulatedContent !== session.lastConsumedContent;

    // 更新消费记录
    session.lastConsumedContent = session.accumulatedContent;
    session.hasNewContent = false;

    addLog.info('Get full content for polling', {
      streamId,
      contentLength: session.accumulatedContent.length,
      finished: session.finished,
      hasUpdate,
      contentPreview: session.accumulatedContent.substring(0, 50)
    });

    return {
      content: session.accumulatedContent,
      finished: session.finished,
      hasUpdate
    };
  }

  /**
   * 旧接口兼容：消费队列（现在返回完整内容）
   */
  async consume(streamId: string): Promise<StreamChunk[]> {
    const { content, finished } = this.getFullContent(streamId);
    return [
      {
        content,
        is_final: finished
      }
    ];
  }

  /**
   * 清理过期会话
   */
  cleanup(): void {
    const now = Date.now();
    const expireTime = this.ttl * 1000;
    let cleanedCount = 0;

    for (const [streamId, session] of this.sessions.entries()) {
      if (now - session.last_access > expireTime) {
        this.sessions.delete(streamId);
        if (session.msg_id) {
          this.msgIndex.delete(session.msg_id);
        }
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      addLog.info('Cleanup expired stream sessions', {
        cleanedCount,
        remainingCount: this.sessions.size
      });
    }
  }

  /**
   * 生成唯一的 stream_id
   */
  private generateStreamId(): string {
    return `stream_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * 获取会话统计信息
   */
  getStats() {
    return {
      totalSessions: this.sessions.size,
      totalMsgIndex: this.msgIndex.size,
      activeSessions: Array.from(this.sessions.values()).filter((s) => !s.finished).length
    };
  }
}

// 导出全局单例
export const globalStreamManager = new StreamSessionManager(60);
