/**
 * 统一的错误类型。
 *
 * 领域层只抛出 AppError；HTTP 层负责把它映射成状态码和 {"error":{...}} 结构。
 * 这样领域代码不依赖 HTTP，也不会出现"字符串比较状态码"的写法。
 */

export type ErrorCode =
  | 'invalid' // 400 请求内容不合法
  | 'unauthenticated' // 401 缺少或无效凭据
  | 'forbidden' // 403 已认证但无权执行
  | 'not_found' // 404 不存在或不可见
  | 'conflict' // 409 状态或唯一性冲突
  | 'precondition_failed' // 412 版本不匹配
  | 'payload_too_large' // 413
  | 'internal'; // 500

const STATUS: Record<ErrorCode, number> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
  }
}

export const invalid = (message: string) => new AppError('invalid', message);
export const unauthenticated = (message: string) => new AppError('unauthenticated', message);
export const forbidden = (message: string) => new AppError('forbidden', message);
export const notFound = (message: string) => new AppError('not_found', message);
export const conflict = (message: string) => new AppError('conflict', message);
export const preconditionFailed = (message: string) => new AppError('precondition_failed', message);
