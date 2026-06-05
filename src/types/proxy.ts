export type SupportedMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

export interface CurlProxyRequestBody {
  curl: string;
}

export interface ProxyErrorPayload {
  type: string;
  message: string;
}

export interface CurlProxyResponse {
  status_code: number | null;
  headers: Record<string, string>;
  body: unknown;
  execution_time_ms: number;
  error: ProxyErrorPayload | null;
}

export interface ParsedCurlRequest {
  method: SupportedMethod;
  url: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  auth: [string, string] | null;
  data: string | Buffer | null;
  params: string | null;
  files: FormDataField[] | null;
  followRedirects: boolean;
  verifySSL: boolean;
  timeout: number;
  openedFiles: OpenedFileHandle[];
}

export interface OpenedFileHandle {
  path: string;
  // Close handle on completion
  close: () => void;
}

// [filename, Buffer] for multipart, or [undefined, string] for plain form value
export type FormDataField = [string, string | null, Buffer | string | undefined];

// Re-export the form-data module type
export type FormDataInstance = unknown;
