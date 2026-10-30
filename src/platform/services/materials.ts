/**
 * 任务材料：创建任务时随任务提交的文件。
 *
 * 材料属于任务，可见性完全跟随任务本身：能读任务的人才能列目录、取内容。
 * 内容以 base64 存在数据库里，不引入外部对象存储，备份与租户隔离都沿用现有路径。
 */

import { invalid, notFound } from '../../protocol/errors.ts';
import { asObject, asString } from '../../protocol/parse.ts';
import type { Queryable, Row } from '../db/driver.ts';

export const MAX_MATERIALS = 5;
export const MAX_MATERIAL_BYTES = 1024 * 1024;
export const MAX_TOTAL_MATERIAL_BYTES = 2 * 1024 * 1024;

export type MaterialUpload = {
  name: string;
  mime: string;
  size: number;
  data: string;
};

export type MaterialMeta = {
  id: string;
  name: string;
  mime: string;
  size: number;
  uploadedBy: string;
  createdAt: string;
};

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

function decodeBase64(data: string, name: string): Buffer {
  if (data.length === 0) throw invalid(`${name} 不能为空`);
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw invalid(`${name} 不是合法的 base64`);
  return Buffer.from(data, 'base64');
}

/** 解析请求体里的 materials；忽略空值，但任何一项不合法都整单失败。 */
export function parseMaterialUploads(raw: unknown): MaterialUpload[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('materials 必须是数组');
  if (raw.length > MAX_MATERIALS) throw invalid(`最多上传 ${MAX_MATERIALS} 个材料`);

  let total = 0;
  return raw.map((item, index) => {
    const entry = asObject(item);
    const label = `materials[${index}]`;
    const name = asString(entry.name, `${label}.name`, { max: 200 }).replace(/[\\/]/g, '_');
    const mime =
      entry.mime === undefined
        ? 'application/octet-stream'
        : asString(entry.mime, `${label}.mime`, { max: 120, pattern: MIME });
    const data = asString(entry.data, `${label}.data`, { max: 2_000_000 });
    const buffer = decodeBase64(data, `${label}.data`);
    if (buffer.byteLength > MAX_MATERIAL_BYTES) {
      throw invalid(`材料 ${name} 超过 ${MAX_MATERIAL_BYTES / 1024 / 1024} MB`);
    }
    total += buffer.byteLength;
    if (total > MAX_TOTAL_MATERIAL_BYTES) {
      throw invalid(`材料合计不能超过 ${MAX_TOTAL_MATERIAL_BYTES / 1024 / 1024} MB`);
    }
    return { name, mime, size: buffer.byteLength, data };
  });
}

export async function insertMaterials(
  tx: Queryable,
  taskId: string,
  actorId: string,
  uploads: MaterialUpload[],
  now: string,
  newId: () => string,
): Promise<void> {
  for (const upload of uploads) {
    await tx.run(
      `INSERT INTO task_materials(id, task_id, name, mime, size, data, uploaded_by, created_at)
       VALUES(:id, :taskId, :name, :mime, :size, :data, :actor, :at)`,
      {
        id: newId(),
        taskId,
        name: upload.name,
        mime: upload.mime,
        size: upload.size,
        data: upload.data,
        actor: actorId,
        at: now,
      },
    );
  }
}

function toMeta(row: Row): MaterialMeta {
  return {
    id: String(row.id),
    name: String(row.name),
    mime: String(row.mime),
    size: Number(row.size),
    uploadedBy: String(row.uploaded_by),
    createdAt: String(row.created_at),
  };
}

export async function listMaterials(db: Queryable, taskId: string): Promise<MaterialMeta[]> {
  const rows = await db.all(
    `SELECT id, name, mime, size, uploaded_by, created_at
     FROM task_materials WHERE task_id = :taskId ORDER BY created_at, id`,
    { taskId },
  );
  return rows.map(toMeta);
}

export async function readMaterial(
  db: Queryable,
  taskId: string,
  materialId: string,
): Promise<(MaterialMeta & { data: string }) | null> {
  const row = await db.one(
    `SELECT id, name, mime, size, uploaded_by, created_at, data
     FROM task_materials WHERE task_id = :taskId AND id = :id`,
    { taskId, id: materialId },
  );
  if (!row) return null;
  return { ...toMeta(row), data: String(row.data) };
}

/** 详情页与下载接口共用：任务可见即可读材料，找不到按 404 处理。 */
export async function requireMaterial(
  db: Queryable,
  taskId: string,
  materialId: string,
): Promise<MaterialMeta & { data: string }> {
  const material = await readMaterial(db, taskId, materialId);
  if (!material) throw notFound('材料不存在');
  return material;
}
