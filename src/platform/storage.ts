/**
 * 文件字节存储。
 *
 * 默认落在本地磁盘，按内容寻址：对象键是 `<workspace>/<sha 前两位>/<sha>`，
 * 同一份内容在同一个团队空间里只存一次。S3/MinIO 是可选后端，接口相同；
 * 没装 AWS SDK 时只有显式选择 s3 才会在启动时报错。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export type StorageDriver = 'fs' | 's3';

export type S3Settings = {
  bucket: string;
  region: string;
  endpoint: string | null;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string | null;
  secretAccessKey: string | null;
};

export type StorageSettings = {
  driver: StorageDriver;
  /** 本地驱动根目录；S3 驱动下只作为上传暂存目录。 */
  root: string;
  s3?: {
    bucket?: string | null;
    region?: string | null;
    endpoint?: string | null;
    prefix?: string;
    forcePathStyle?: boolean;
    accessKeyId?: string | null;
    secretAccessKey?: string | null;
  };
  /** 允许的单文件上限，默认 25 MiB。 */
  maxUploadBytes?: number;
};

export type PutResult = { sha256: string; size: number; objectKey: string };
export type OpenResult = { stream: Readable; size: number | null };
export type UploadTarget = { url: string; method: 'PUT'; headers: Record<string, string> };

export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface BlobStore {
  readonly kind: StorageDriver;
  readonly maxUploadBytes: number;
  objectKey(workspace: string, sha256: string): string;
  /** 流式写入；返回内容哈希与规范化对象键。 */
  put(workspace: string, source: AsyncIterable<Buffer | string>, limit?: number): Promise<PutResult>;
  open(objectKey: string, range?: { start: number; end: number }): Promise<OpenResult>;
  stat(objectKey: string): Promise<{ size: number } | null>;
  remove(objectKey: string): Promise<void>;
  /**
   * 浏览器/客户端可直接 PUT 的地址。本地驱动返回 null，表示 PUT 必须回到本服务，
   * 由服务端边写边算哈希；S3 驱动返回预签名地址。
   */
  uploadTarget(input: { objectKey: string; mime: string; size: number | null }): Promise<UploadTarget | null>;
  /** 对象直传完成后核对大小与哈希；返回实际值。 */
  verify(objectKey: string, expected?: { size?: number | null; sha256?: string | null }): Promise<{ size: number; sha256: string }>;
}

function assertSafeKey(objectKey: string): void {
  if (!objectKey || objectKey.includes('..') || objectKey.startsWith('/') || objectKey.includes('\0')) {
    throw new Error('对象键不合法');
  }
}

async function hashFile(path: string, limit: number): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > limit) throw new Error('文件超过大小上限');
    hash.update(buffer);
  }
  return { size, sha256: hash.digest('hex') };
}

export class FsBlobStore implements BlobStore {
  readonly kind = 'fs' as const;
  readonly maxUploadBytes: number;
  private readonly root: string;

  constructor(root: string, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES) {
    this.root = resolve(root);
    this.maxUploadBytes = maxUploadBytes;
  }

  objectKey(workspace: string, sha256: string): string {
    return `${workspace}/${sha256.slice(0, 2)}/${sha256}`;
  }

  private pathOf(objectKey: string): string {
    assertSafeKey(objectKey);
    const target = resolve(join(this.root, objectKey));
    if (target !== this.root && !target.startsWith(this.root + sep)) throw new Error('对象键越界');
    return target;
  }

  async put(
    workspace: string,
    source: AsyncIterable<Buffer | string>,
    limit = this.maxUploadBytes,
  ): Promise<PutResult> {
    const tempDir = join(this.root, workspace, '.tmp');
    await mkdir(tempDir, { recursive: true });
    const temp = join(tempDir, `${randomUUID()}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const handle = await open(temp, 'wx', 0o600);
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > limit) throw new Error(`文件超过 ${limit} 字节上限`);
        hash.update(buffer);
        await handle.write(buffer);
      }
      if (size === 0) throw new Error('文件不能为空');
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temp, { force: true });
      throw error;
    }
    await handle.close();
    const sha256 = hash.digest('hex');
    const objectKey = this.objectKey(workspace, sha256);
    const target = this.pathOf(objectKey);
    await mkdir(dirname(target), { recursive: true });
    // 同内容已存在时 rename 会覆盖成同样的字节；直接替换也是幂等的。
    await rename(temp, target);
    return { sha256, size, objectKey };
  }

  async open(objectKey: string, range?: { start: number; end: number }): Promise<OpenResult> {
    const path = this.pathOf(objectKey);
    const info = await stat(path).catch(() => null);
    if (!info) throw new Error('对象不存在');
    return {
      stream: createReadStream(path, range ? { start: range.start, end: range.end } : undefined),
      size: info.size,
    };
  }

  async stat(objectKey: string): Promise<{ size: number } | null> {
    const info = await stat(this.pathOf(objectKey)).catch(() => null);
    return info ? { size: info.size } : null;
  }

  async remove(objectKey: string): Promise<void> {
    await rm(this.pathOf(objectKey), { force: true });
  }

  async uploadTarget(): Promise<UploadTarget | null> {
    return null;
  }

  async verify(
    objectKey: string,
    expected?: { size?: number | null; sha256?: string | null },
  ): Promise<{ size: number; sha256: string }> {
    const actual = await hashFile(this.pathOf(objectKey), this.maxUploadBytes);
    if (expected?.size != null && actual.size !== expected.size) throw new Error('文件大小与声明不一致');
    if (expected?.sha256 && actual.sha256 !== expected.sha256) throw new Error('文件哈希与声明不一致');
    return actual;
  }
}

type S3Module = {
  S3Client: new (config: Record<string, unknown>) => {
    send(command: unknown): Promise<Record<string, unknown>>;
  };
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
};

async function loadS3(): Promise<{ module: S3Module; presign: (client: unknown, command: unknown, options: { expiresIn: number }) => Promise<string> }> {
  const s3Name = '@aws-sdk/client-s3';
  const presignerName = '@aws-sdk/s3-request-presigner';
  let module: S3Module;
  let presigner: { getSignedUrl: (client: unknown, command: unknown, options: { expiresIn: number }) => Promise<string> };
  try {
    module = (await import(s3Name)) as S3Module;
    presigner = (await import(presignerName)) as typeof presigner;
  } catch (error) {
    throw new Error(
      'COLLAB_STORAGE=s3 需要安装 @aws-sdk/client-s3 与 @aws-sdk/s3-request-presigner；' +
        '没有对象存储时可使用默认的本地磁盘驱动',
      { cause: error },
    );
  }
  return { module, presign: presigner.getSignedUrl };
}

export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  readonly maxUploadBytes: number;
  private readonly settings: S3Settings;
  private readonly root: string;
  private client: { send(command: unknown): Promise<Record<string, unknown>> } | null = null;
  private api: S3Module | null = null;
  private signer: ((client: unknown, command: unknown, options: { expiresIn: number }) => Promise<string>) | null = null;

  constructor(settings: S3Settings, root: string, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES) {
    this.settings = settings;
    this.root = resolve(root);
    this.maxUploadBytes = maxUploadBytes;
  }

  objectKey(workspace: string, sha256: string): string {
    const prefix = this.settings.prefix.replace(/^\/+|\/+$/g, '');
    return `${prefix ? `${prefix}/` : ''}${workspace}/${sha256.slice(0, 2)}/${sha256}`;
  }

  private async ready() {
    if (this.client && this.api && this.signer) return { client: this.client, api: this.api, signer: this.signer };
    const loaded = await loadS3();
    this.api = loaded.module;
    this.signer = loaded.presign;
    this.client = new loaded.module.S3Client({
      region: this.settings.region,
      ...(this.settings.endpoint ? { endpoint: this.settings.endpoint } : {}),
      forcePathStyle: this.settings.forcePathStyle,
      ...(this.settings.accessKeyId && this.settings.secretAccessKey
        ? {
            credentials: {
              accessKeyId: this.settings.accessKeyId,
              secretAccessKey: this.settings.secretAccessKey,
            },
          }
        : {}),
    });
    return { client: this.client!, api: this.api!, signer: this.signer! };
  }

  async put(
    workspace: string,
    source: AsyncIterable<Buffer | string>,
    limit = this.maxUploadBytes,
  ): Promise<PutResult> {
    const tempDir = join(this.root, workspace, '.tmp');
    await mkdir(tempDir, { recursive: true });
    const temp = join(tempDir, `${randomUUID()}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const handle = await open(temp, 'wx', 0o600);
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > limit) throw new Error(`文件超过 ${limit} 字节上限`);
        hash.update(buffer);
        await handle.write(buffer);
      }
      if (size === 0) throw new Error('文件不能为空');
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temp, { force: true });
      throw error;
    }
    await handle.close();
    const sha256 = hash.digest('hex');
    const key = this.objectKey(workspace, sha256);
    const { client, api } = await this.ready();
    try {
      await client.send(
        new api.PutObjectCommand({
          Bucket: this.settings.bucket,
          Key: key,
          Body: createReadStream(temp),
          ContentLength: size,
        }),
      );
    } finally {
      await rm(temp, { force: true });
    }
    return { sha256, size, objectKey: key };
  }

  async open(objectKey: string, range?: { start: number; end: number }): Promise<OpenResult> {
    const { client, api } = await this.ready();
    const output = (await client.send(
      new api.GetObjectCommand({
        Bucket: this.settings.bucket,
        Key: objectKey,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    )) as { Body?: { transformToWebStream?: () => ReadableStream; pipe?: (target: NodeJS.WritableStream) => NodeJS.WritableStream }; ContentLength?: number };
    const body = output.Body as
      | (Readable & { transformToWebStream?: () => ReadableStream })
      | undefined;
    if (!body) throw new Error('对象不存在');
    const stream =
      typeof body.transformToWebStream === 'function'
        ? Readable.fromWeb(body.transformToWebStream() as never)
        : body;
    return { stream, size: typeof output.ContentLength === 'number' ? output.ContentLength : null };
  }

  async stat(objectKey: string): Promise<{ size: number } | null> {
    const { client, api } = await this.ready();
    try {
      const output = (await client.send(
        new api.HeadObjectCommand({ Bucket: this.settings.bucket, Key: objectKey }),
      )) as { ContentLength?: number };
      return { size: Number(output.ContentLength ?? 0) };
    } catch {
      return null;
    }
  }

  async remove(objectKey: string): Promise<void> {
    const { client, api } = await this.ready();
    await client.send(new api.DeleteObjectCommand({ Bucket: this.settings.bucket, Key: objectKey }));
  }

  async uploadTarget(input: { objectKey: string; mime: string; size: number | null }): Promise<UploadTarget> {
    const { client, api, signer } = await this.ready();
    const command = new api.PutObjectCommand({
      Bucket: this.settings.bucket,
      Key: input.objectKey,
      ContentType: input.mime,
      ...(input.size != null ? { ContentLength: input.size } : {}),
    });
    return {
      url: await signer(client, command, { expiresIn: 900 }),
      method: 'PUT',
      headers: input.mime ? { 'content-type': input.mime } : {},
    };
  }

  async verify(
    objectKey: string,
    expected?: { size?: number | null; sha256?: string | null },
  ): Promise<{ size: number; sha256: string }> {
    const { stream } = await this.open(objectKey);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      if (size > this.maxUploadBytes) throw new Error('文件超过大小上限');
      hash.update(buffer);
    }
    const sha256 = hash.digest('hex');
    if (expected?.size != null && size !== expected.size) throw new Error('文件大小与声明不一致');
    if (expected?.sha256 && sha256 !== expected.sha256) throw new Error('文件哈希与声明不一致');
    return { size, sha256 };
  }
}

export function createBlobStore(settings: StorageSettings): BlobStore {
  const limit = settings.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (settings.driver === 's3') {
    const s3 = settings.s3 ?? {};
    if (!s3.bucket || !s3.region) throw new Error('COLLAB_STORAGE=s3 需要 COLLAB_S3_BUCKET 与 COLLAB_S3_REGION');
    return new S3BlobStore(
      {
        bucket: s3.bucket,
        region: s3.region,
        endpoint: s3.endpoint ?? null,
        prefix: s3.prefix ?? '',
        forcePathStyle: s3.forcePathStyle ?? false,
        accessKeyId: s3.accessKeyId ?? null,
        secretAccessKey: s3.secretAccessKey ?? null,
      },
      settings.root,
      limit,
    );
  }
  return new FsBlobStore(settings.root, limit);
}
