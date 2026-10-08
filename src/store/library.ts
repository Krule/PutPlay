import { writable, get } from "svelte/store";
import { putioIsFolder, type PutFile } from "../putio/types";
import { listFiles, listContinue, type Auth } from "../putio/api";

export type SortBy = "name" | "date_added" | "size";

export interface Breadcrumb {
  id: number | null; // null = root
  name: string;
}

export interface LibraryState {
  auth: Auth | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  files: PutFile[];
  cursor: string | null;
  hasMore: boolean;
  folderId: number | null;
  breadcrumbs: Breadcrumb[];
  sortBy: SortBy;
  sortDir: "asc" | "desc";
  selected: PutFile | null;
}

const initial: LibraryState = {
  auth: null,
  loading: false,
  loadingMore: false,
  error: null,
  files: [],
  cursor: null,
  hasMore: false,
  folderId: null,
  breadcrumbs: [{ id: null, name: "My Library" }],
  sortBy: "name",
  sortDir: "asc",
  selected: null,
};

export const library = writable<LibraryState>(initial);

function set(patch: Partial<LibraryState>) {
  library.update((s) => ({ ...s, ...patch }));
}

/** Load (and replace) the listing for a folder. */
export async function listFolder(auth: Auth, folderId: number | null, reset = true): Promise<void> {
  if (reset) {
    set({
      loading: true,
      error: null,
      files: [],
      cursor: null,
      hasMore: false,
      folderId,
      breadcrumbs: reset ? buildBreadcrumbs(folderId) : get(library).breadcrumbs,
    });
  }
  try {
    const res = await listFiles(auth, {
      parentId: folderId,
      perPage: 50,
      orderBy: toAPIOrder(get(library).sortBy),
      order: get(library).sortDir,
    });
    const files = res.files || [];
    // folders first, then by API sort
    files.sort((a, b) => {
      const af = putioIsFolder(a) ? 0 : 1;
      const bf = putioIsFolder(b) ? 0 : 1;
      return af - bf;
    });
    library.update((s) => ({
      ...s,
      loading: false,
      files: reset ? files : [...s.files, ...files],
      cursor: res.cursor,
      hasMore: !!res.cursor,
    }));
  } catch (e: any) {
    set({ loading: false, error: e.message || "Could not load folder" });
  }
}

function buildBreadcrumbs(folderId: number | null): Breadcrumb[] {
  // full breadcrumb rebuild requires folder ids up the tree; we maintain it incrementally instead
  if (!folderId) return [{ id: null, name: "My Library" }];
  return get(library).breadcrumbs;
}

/** Open a folder (or refresh in place). */
export async function openFolder(auth: Auth, file: PutFile): Promise<void> {
  if (!putioIsFolder(file)) return;
  // rebuild from the current tail (single source of truth = the folder id chain)
  const cur = get(library).breadcrumbs;
  const last = cur[cur.length - 1];
  // avoid self-reference (a folder can appear inside itself via re-open)
  if (last && last.id === file.id) return listFolder(auth, file.id);
  let bc = [...cur, { id: file.id, name: file.name }];
  // dedupe a same-name/same-id chain
  bc = bc.filter((b, i) => bc.findIndex((x) => x.id === b.id) === i);
  library.update((s) => ({ ...s, breadcrumbs: bc }));
  await listFolder(auth, file.id);
}

/** Load the next page (cursor pagination). */
export async function loadMore(auth: Auth): Promise<void> {
  const s = get(library);
  if (!s.hasMore || s.loadingMore) return;
  set({ loadingMore: true });
  try {
    const res = await listContinue(auth, s.cursor!);
    library.update((st) => ({
      ...st,
      loadingMore: false,
      files: [...st.files, ...res.files],
      cursor: res.cursor,
      hasMore: !!res.cursor,
    }));
  } catch (e: any) {
    set({ loadingMore: false, error: e.message });
  }
}

export function cycleSort(): void {
  const s = get(library);
  const orders: SortBy[] = ["name", "date_added", "size"];
  const i = orders.indexOf(s.sortBy);
  if (s.sortDir === "asc") {
    set({ sortDir: "desc" });
  } else {
    set({ sortBy: orders[(i + 1) % orders.length], sortDir: "asc" });
  }
  // re-apply client-side for the loaded set (folder-first kept)
  library.update((st) => {
    const files = [...st.files];
    const dir = st.sortDir === "asc" ? 1 : -1;
    files.sort((a, b) => {
      const af = putioIsFolder(a) ? 0 : 1;
      const bf = putioIsFolder(b) ? 0 : 1;
      if (af !== bf) return af - bf;
      if (st.sortBy === "size") return (a.size || 0) < (b.size || 0) ? -dir : dir;
      if (st.sortBy === "date_added") {
        const t = (x: PutFile) => x.created_at || "";
        return t(a) < t(b) ? -dir : t(a) > t(b) ? dir : 0;
      }
      return a.name.localeCompare(b.name) * dir;
    });
    return { ...st, files };
  });
}

export function backOneLevel(auth: Auth): void | Promise<void> {
  const s = get(library);
  if (s.breadcrumbs.length <= 1) return;
  const bc = s.breadcrumbs.slice(0, -1);
  const parent = bc[bc.length - 1].id;
  library.update((st) => ({ ...st, breadcrumbs: bc }));
  return listFolder(auth, parent);
}

function toAPIOrder(s: SortBy): "name" | "date_added" | "size" {
  return s;
}
