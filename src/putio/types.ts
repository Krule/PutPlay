/** put.io does not return is_folder; derive it. */
export function putioIsFolder(f: { content_type?: string; is_folder?: boolean; file_type?: string }): boolean {
  return f.content_type === "application/x-directory" || f.is_folder === true || f.file_type === "FOLDER";
}

export interface PutAccountInfo {
  account_active: boolean;
  account_status: string;
  avatar_url?: string;
  family_owner: string;
  mail?: string;
  disk: { avail: number; size: number; used: number };
  download_token?: string;
  settings?: {
    subtitle_languages?: string[];
    dark_theme?: boolean;
    [k: string]: any;
  };
  quota_info?: any;
  [k: string]: any;
}

export interface PutFile {
  id: number;
  name: string;
  size: number;
  content_type: string;
  file_type?: string;
  is_hidden?: boolean;
  is_folder?: boolean;
  parent_id: number | null;
  folder_id?: number | null;
  icon?: string;
  screenshot?: string;
  is_mp4_available?: boolean;
  mp4_size?: number | null;
  need_convert?: boolean;
  start_from?: number; // seconds, 0 = none
  created_at?: string;
  updated_at?: string;
  type?: "REGULAR" | "FOLDER";
  // media (only with ?media_info=true)
  media_info?: {
    format?: { name?: string; long_name?: string };
    streams?: MediaStream[];
  } | null;
}

export interface MediaStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  duration?: number;
  tags?: { language?: string; title?: string };
}

export interface SubtitleInfo {
  format: "srt" | "ass" | "vtt" | "sub" | "ssa" | "txt";
  key: string;
  language: string;
  language_code: string;
  name: string;
  source: string;
  url: string;
}

export interface SubtitlesResponse {
  default: string | null;
  status: string;
  subtitles: SubtitleInfo[];
}

export interface FilesListResponse {
  cursor: string | null;
  files: PutFile[];
  parent?: PutFile | null;
  total?: number;
}

export interface OOBCodeResponse {
  code: string;
  qr_code_url: string;
  status: string;
  [k: string]: any;
}

export interface OOBPollResponse {
  oauth_token: string | null;
  status: string;
  [k: string]: any;
}
