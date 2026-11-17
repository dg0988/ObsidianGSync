import type { RequestUrlResponse } from "obsidian";
import type { FolderAccess } from "./drive";

/**
 * GSync's interface for add-ons such as GSync Teams.
 * An add-on gets it with `app.plugins.getPlugin("gsync")?.api` and checks `version`.
 * Bump GSYNC_API_VERSION only for breaking changes; adding members is not breaking.
 */
export const GSYNC_API_VERSION = 1;

/** A synced folder: the whole vault (id "main", local "") or an extra folder pair. */
export interface GSyncFolder {
  id: string;
  /** Vault folder ("" = whole vault). */
  local: string;
  /** Drive folder path, e.g. "Obsidian/Notes" or "Shared drives/Company/Notes". */
  remote: string;
}

export type DriveRequestOptions = {
  method?: string;
  body?: string | ArrayBuffer;
  contentType?: string;
  headers?: Record<string, string>;
  retry?: boolean;
};

/** What the GSync Teams add-on provides. */
export interface TeamsExtension {
  /** Turn a Shared Drive's name into its id (throws if not found). */
  resolveSharedDrive(name: string): Promise<string>;
  /** Open the add-on's access manager for a Drive folder path. */
  manageAccess(remotePath: string): void;
}

export interface GSyncApi {
  version: number;
  /** Authorized Google Drive API request, using GSync's sign-in. */
  request(url: string, opts?: DriveRequestOptions): Promise<RequestUrlResponse>;
  /** Resolve (and create if missing) a Drive folder path to its id. */
  ensureFolderPath(path: string): Promise<string>;
  /** What the signed-in user may do in a Drive folder. */
  folderAccess(folderId: string): Promise<FolderAccess>;
  /** The folders GSync syncs, whole vault first. */
  folders(): GSyncFolder[];
  /** Register the Teams add-on. Returns a function that unregisters it. */
  registerTeams(ext: TeamsExtension): () => void;
}
