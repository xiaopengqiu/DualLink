export class CaptureAssembler {
  constructor({ maxBytes = 12 * 1024 * 1024, timeoutMs = 30000, expectedDeviceId } = {}) {
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.expectedDeviceId = expectedDeviceId;
    this.current = null;
  }

  reset() { this.current = null; }

  push(message, now = Date.now()) {
    try {
      if (typeof message === 'string') {
        if (message.length > 8192) throw new Error('无效的图片传输消息');
        const data = JSON.parse(message);
        if (data.type === 'capture.start') {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.captureId)) throw new Error('无效的截图编号');
          if (!Number.isSafeInteger(data.size) || data.size <= 0 || data.size > this.maxBytes) throw new Error('图片大小超出接收限制');
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(data.mime)) throw new Error('不支持的图片格式');
          if (this.expectedDeviceId && data.deviceId !== this.expectedDeviceId) throw new Error('图片来源设备不匹配');
          this.current = { metadata: { ...data, name: String(data.name || 'screenshot.png').slice(0, 160), analyze: data.analyze === true }, startedAt: now, size: 0, chunks: [] };
          return null;
        }
        if (this.current && now - this.current.startedAt > this.timeoutMs) throw new Error('局域网图片接收超时，请重试截图');
        if (data.type === 'capture.end') {
          const current = this.current;
          if (!current || data.captureId !== current.metadata.captureId || current.size !== current.metadata.size) throw new Error('图片未接收完整');
          const bytes = new Uint8Array(current.size);
          let offset = 0;
          for (const chunk of current.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          this.reset();
          return { metadata: current.metadata, bytes };
        }
        throw new Error('未知的图片传输消息');
      }
      if (this.current && now - this.current.startedAt > this.timeoutMs) throw new Error('局域网图片接收超时，请重试截图');
      if (!this.current) throw new Error('尚未收到图片开始信息');
      const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : ArrayBuffer.isView(message) ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength) : null;
      if (!bytes || !bytes.byteLength || bytes.byteLength > 48 * 1024) throw new Error('无效的图片分块大小');
      if (this.current.size + bytes.byteLength > this.current.metadata.size) throw new Error('图片分块超过声明大小');
      this.current.chunks.push(bytes.slice());
      this.current.size += bytes.byteLength;
      return null;
    } catch (error) {
      this.reset();
      throw error;
    }
  }
}
export function shouldAnalyze(metadata, webAutoAnalyze) { return metadata.analyze === true && webAutoAnalyze === true; }
