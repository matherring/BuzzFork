import { invoke } from "@tauri-apps/api/core";

export type LocalDocument = {
  path: string;
  filename: string;
  language: string;
  content: string;
  bytes: number;
  lines: number;
  truncated: boolean;
};

export async function readLocalDocument(path: string): Promise<LocalDocument> {
  return invoke<LocalDocument>("read_local_document", { path });
}
