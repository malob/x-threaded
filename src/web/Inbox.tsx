import { useEffect, useState } from "react";
import type { OwnPostsResponse, SavedListResponse, SettingsResponse } from "../shared/types";
import {
  getFolders,
  getOwnPosts,
  getSaved,
  getSettings,
  removeSaved,
  setBookmarkFolder,
  syncBookmarks,
} from "./api";
import { PostView } from "./PostView";

type Tab = "saved" | "yours";

/** Folder picker plus sync control for the saved tab. */
function FolderBar({
  settings,
  onChange,
  onSync,
  syncing,
  syncNote,
}: {
  settings: SettingsResponse | null;
  onChange: (id: string | null, name: string) => void;
  onSync: () => void;
  syncing: boolean;
  syncNote: string | null;
}) {
  const [folders, setFolders] = useState<{ id: string; name: string }[] | null>(null);
  const [picking, setPicking] = useState(false);

  const openPicker = () => {
    setPicking(true);
    if (!folders) {
      getFolders()
        .then((r) => setFolders(r.folders))
        .catch(() => setFolders([]));
    }
  };

  if (picking) {
    return (
      <p className="notice">
        {folders === null ? (
          "loading folders…"
        ) : folders.length === 0 ? (
          <>no bookmark folders found — create one on x.com, then reopen this picker</>
        ) : (
          <>
            sync from{" "}
            <select
              defaultValue={settings?.bookmarkFolderId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                const name = folders.find((f) => f.id === id)?.name ?? "";
                onChange(id, name);
                setPicking(false);
              }}
            >
              <option value="">— none —</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </>
        )}{" "}
        ·{" "}
        <button className="notice-btn" onClick={() => setPicking(false)}>
          cancel
        </button>
      </p>
    );
  }

  return (
    <p className="notice">
      {settings?.bookmarkFolderId ? (
        <>
          syncing from{" "}
          <button className="notice-btn" onClick={openPicker}>
            {settings.bookmarkFolderName || "a folder"} ▾
          </button>{" "}
          ·{" "}
          <button className="notice-btn" onClick={onSync} disabled={syncing}>
            {syncing ? "syncing…" : "sync now"}
          </button>
        </>
      ) : (
        <button className="notice-btn" onClick={openPicker}>
          choose a bookmark folder to sync ▾
        </button>
      )}
      {syncNote && <span className="new-badge"> · {syncNote}</span>}
    </p>
  );
}

export function Inbox({ onOpenPost }: { onOpenPost: (postId: string) => void }) {
  const [tab, setTab] = useState<Tab>("saved");
  const [saved, setSaved] = useState<SavedListResponse | null>(null);
  const [own, setOwn] = useState<OwnPostsResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [loadingOwn, setLoadingOwn] = useState(false);
  /** How many threads the Your posts tab is currently asking for. */
  const [ownTarget, setOwnTarget] = useState(10);
  const [error, setError] = useState<string | null>(null);

  const loadSaved = () => {
    getSaved()
      .then(setSaved)
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    loadSaved();
    getSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  const loadOwn = (threads = ownTarget) => {
    setLoadingOwn(true);
    setError(null);
    getOwnPosts(threads)
      .then((r) => {
        setOwn(r);
        setOwnTarget(threads);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoadingOwn(false));
  };

  // Your posts cost real API reads, so fetch them on first view, not on mount.
  useEffect(() => {
    if (tab === "yours" && !own && !loadingOwn) loadOwn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const sync = async () => {
    setSyncing(true);
    setSyncNote(null);
    try {
      const result = await syncBookmarks();
      setSyncNote(result.added > 0 ? `+${result.added} new` : "up to date");
      loadSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const changeFolder = async (id: string | null, name: string) => {
    try {
      setSettings(await setBookmarkFolder(id, name));
      if (id) void sync();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const drop = async (postId: string) => {
    try {
      await removeSaved(postId);
      loadSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <div className="tabs">
        <button className={tab === "saved" ? "tab active" : "tab"} onClick={() => setTab("saved")}>
          Saved{saved ? ` (${saved.items.length})` : ""}
        </button>
        <button className={tab === "yours" ? "tab active" : "tab"} onClick={() => setTab("yours")}>
          Your posts
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {tab === "saved" ? (
        <>
          <FolderBar
            settings={settings}
            onChange={changeFolder}
            onSync={() => void sync()}
            syncing={syncing}
            syncNote={syncNote}
          />
          <ul className="conversations">
            {saved?.items.map((item) => (
              <li
                key={item.post.id}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a, button")) return;
                  onOpenPost(item.post.id);
                }}
              >
                <PostView post={item.post} quoted={saved.quoted} />
                <div className="post-meta inbox-meta">
                  {item.source === "bookmark" ? "bookmarked" : "added here"}
                  {item.loaded ? " · conversation loaded" : " · not loaded yet"} ·{" "}
                  <button className="notice-btn" onClick={() => void drop(item.post.id)}>
                    remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {saved?.items.length === 0 && (
            <p className="notice">
              nothing saved yet — bookmark posts into your folder on x.com, or paste a URL above
            </p>
          )}
        </>
      ) : (
        <>
          <p className="notice">
            your recent threads{own ? ` (${own.items.length})` : ""} ·{" "}
            <button className="notice-btn" onClick={() => loadOwn(10)} disabled={loadingOwn}>
              {loadingOwn ? "loading…" : "refresh"}
            </button>
          </p>
          <ul className="conversations">
            {own?.items.map((item) => (
              <li
                key={item.root.id}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a, button")) return;
                  onOpenPost(item.root.id);
                }}
              >
                <PostView post={item.root} quoted={own.quoted} />
                <div className="post-meta inbox-meta">
                  {item.ownPostCount > 1 && <>thread of {item.ownPostCount} · </>}
                  {item.root.metrics.replies}{" "}
                  {item.root.metrics.replies === 1 ? "reply" : "replies"}
                  {item.loaded ? " · loaded" : ""}
                </div>
              </li>
            ))}
          </ul>
          {own?.items.length === 0 && <p className="notice">no recent posts found</p>}
          {own?.hasMore && (
            <p className="notice">
              <button
                className="notice-btn"
                onClick={() => loadOwn(ownTarget + 10)}
                disabled={loadingOwn}
              >
                {loadingOwn ? "loading…" : "load 10 more"}
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
