import { useEffect, useState } from "react";
import type {
  AuthStatus,
  OwnPostsResponse,
  SavedListResponse,
  SettingsResponse,
} from "../shared/types";
import {
  getAuthStatus,
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

/** Prompt to authorize X, shown wherever user-context features are needed. */
function ConnectPrompt({ auth }: { auth: AuthStatus | null }) {
  if (!auth || auth.authorized) return null;
  if (!auth.configured) {
    return (
      <p className="notice">
        user-context features are off — this deployment has no OAuth credentials (see
        .env.example)
      </p>
    );
  }
  return (
    <p className="notice">
      <a className="connect-link" href="/auth/login">
        Connect your X account
      </a>{" "}
      to sync bookmarks and see your posts
      {auth.error && <span className="new-badge"> · {auth.error}</span>}
    </p>
  );
}

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

const TAB_KEY = "inboxTab";

export function Inbox({ onOpenPost }: { onOpenPost: (postId: string) => void }) {
  // Remembered across reloads and across trips into a conversation.
  const [tab, setTabState] = useState<Tab>(() =>
    localStorage.getItem(TAB_KEY) === "yours" ? "yours" : "saved",
  );
  const setTab = (next: Tab) => {
    setTabState(next);
    localStorage.setItem(TAB_KEY, next);
  };
  const [saved, setSaved] = useState<SavedListResponse | null>(null);
  const [own, setOwn] = useState<OwnPostsResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [loadingOwn, setLoadingOwn] = useState(false);
  /** How many threads the Your posts tab is currently asking for. */
  const [ownTarget, setOwnTarget] = useState(10);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
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
    getAuthStatus()
      .then(setAuth)
      .catch(() => setAuth(null));
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
    if (tab === "yours" && auth?.authorized && !own && !loadingOwn) loadOwn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, auth]);

  const sync = async () => {
    setSyncing(true);
    setSyncNote(null);
    try {
      const result = await syncBookmarks();
      const parts = [];
      if (result.added > 0) parts.push(`+${result.added} new`);
      if (result.removed > 0) parts.push(`−${result.removed} un-bookmarked`);
      setSyncNote(parts.length > 0 ? parts.join(" · ") : "up to date");
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
      <ConnectPrompt auth={auth} />

      {tab === "saved" ? (
        <>
          {auth?.authorized && (
            <FolderBar
              settings={settings}
              onChange={changeFolder}
              onSync={() => void sync()}
              syncing={syncing}
              syncNote={syncNote}
            />
          )}
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
                  {item.source === "bookmark" ? (
                    // The folder is the source of truth: removing it here
                    // would just come back on the next sync.
                    <a
                      href={`https://x.com/${item.post.authorHandle}/status/${item.post.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Un-bookmark on x.com to remove it from this list"
                    >
                      un-bookmark on x.com ↗
                    </a>
                  ) : (
                    <button className="notice-btn" onClick={() => void drop(item.post.id)}>
                      remove
                    </button>
                  )}
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
      ) : !auth?.authorized ? null : (
        <>
          <p className="notice">
            {auth.user ? `@${auth.user.username} · ` : ""}
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
